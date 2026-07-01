export const meta = {
  name: 'pr-iterate',
  description: 'PR を review ⇄ fix で LGTM になるまで反復（上限 10）。単体起動も dev-flow からのサブ呼びも可',
  phases: [
    { title: 'Iterate' },
  ],
}

// ==== BEGIN inline: _lib/quality-model.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// 品質ゲート系 4 agent（dev-planner / plan-reviewer / evaluator / pr-reviewer）の model override。
// frontmatter 既定は opus。Fable 5 試験運用中は 'fable'、戻すときはこの 1 行を 'opus' にする。
// effort は agent() opts に存在しないため frontmatter（high）固定。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
const QUALITY_MODEL = 'opus'
// ==== END inline: _lib/quality-model.mjs ====

// ==== BEGIN inline: _lib/resolve-arg.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// 正の整数 arg を正規化する。dev-flow / pr-iterate の entrypoint 共通。
// 受理: bare string '120' / number 120 / array ['120'] / object {issue:'120'} | {pr:'120'}
// 拒否(throw): 空 / 未展開テンプレート '{' / '0' / 負数 / 小数 / 非数字混入
// NOTE: name に対応するキー（args[name]）と bare/array 形式のみを解決する。
//       cross-name fallback（例: name='pr' のときに args.issue を採用する）は
//       型安全性を損なう footgun のため意図的に除外している。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
function resolvePositiveIntArg(args, name) {
  const raw = (typeof args === 'string' || typeof args === 'number')
    ? args
    : (args?.[name] ?? args?.[0]);
  const s = String(raw ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(s)) {
    throw new Error(`${name}: 正の整数が必要です（受信: ${JSON.stringify(s)}）`);
  }
  return s;
}
// ==== END inline: _lib/resolve-arg.mjs ====

// ==== BEGIN inline: _lib/journal-handoff.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// Journal telemetry handoff helpers for workflow runtime.
// Workflow loader cannot import ESM, so tools/sync-inlines.mjs injects this file
// into .claude/workflows/*.js. Keep this file import-free and deterministic.
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const JOURNAL_PENDING_DIR = '~/.claude/journal/pending';
const JOURNAL_HANDOFF_DELIMITER = 'TELEMETRY_EOF';

function buildJournalHandoffPayload({
  skill,
  outcome,
  args,
  issue,
  journal_sh,
  telemetry,
  error_category,
  error_msg,
}) {
  if (!skill) throw new Error('journal-handoff: skill is required');
  if (!outcome) throw new Error('journal-handoff: outcome is required');

  const payload = { skill, outcome };
  if (args) payload.args = args;
  if (issue != null && issue !== '') payload.issue = Number(issue);
  if (journal_sh) payload.journal_sh = journal_sh;
  if (telemetry != null) payload.telemetry = telemetry;
  if (error_category) payload.error_category = error_category;
  if (error_msg) payload.error_msg = error_msg;
  return JSON.stringify(payload);
}

function buildJournalHandoffCommand({ prefix, id, payload }) {
  const safePrefix = String(prefix ?? '').trim();
  const safeId = String(id ?? '').trim();
  if (!/^[a-z][a-z0-9-]*$/.test(safePrefix)) {
    throw new Error(`journal-handoff: invalid prefix: ${JSON.stringify(prefix)}`);
  }
  if (!/^[1-9][0-9]*$/.test(safeId)) {
    throw new Error(`journal-handoff: invalid id: ${JSON.stringify(id)}`);
  }
  if (payload == null) throw new Error('journal-handoff: payload is required');

  return `mkdir -p ${JOURNAL_PENDING_DIR} && cat > ${JOURNAL_PENDING_DIR}/${safePrefix}-${safeId}-$(date +%s).json <<'${JOURNAL_HANDOFF_DELIMITER}'\n${String(payload)}\n${JOURNAL_HANDOFF_DELIMITER}`;
}
// ==== END inline: _lib/journal-handoff.mjs ====

// args 正規化: 単体 /pr-iterate <pr> でも dev-flow からの workflow('pr-iterate', {pr}) でも受ける
const PR = resolvePositiveIntArg(args, 'pr')
const MAX = args?.max_iterations == null
  ? 10
  : Number(resolvePositiveIntArg(args.max_iterations, 'max_iterations'))
const REVIEW_STUCK = 2   // 同一 topic がこの回数出たら stuck と判定し人間へエスカレーション（issue #126）

// ---- Review de-churn モデル（issue #126。#123 Plan ループ収束モデルの Review 版を inline 複製）----
// cold start の pr-reviewer は moving target を生む（毎回 fresh context で全 PR diff を再レビューし、
// Adversarial Opener の「能動的に探せ」指示と相まって、安定コードに新しい主観的 major を捻り出しうる）。
// orchestrator 側で churn だけを殺す（ゲートは堅いまま）:
//   1. 既出 findings を pr-reviewer に渡し「対応済み・新規 critical/major のみ・蒸し返し禁止」を指示
//   2. 同一 topic が REVIEW_STUCK 回出たら stuck と判定（fingerprint を JS 側で突合）→ status:'stuck' で人間へ
//   3. fix の applied:false を検出したら status:'fix_failed' で即座に人間へエスカレーション
//      （無言で MAX 回燃やさない。現状この返り値は捨てられていた）
//   4. critical/major は常にブロック（**relax は入れない** = ゲート後退なし）。
//      #123 の PLAN_RELAX_FROM 相当は移植しない — Review は main にマージされる実コードの最後のゲートで
//      merge は手動。「N 回回ったから major 残ったまま approve」は既知の major 出荷になり実害が大きい。
//   5. lgtm / stuck / fix_failed / max_reached は throw せず status で返し、終端理由を log() で可視化。
// loader 制約（ESM import 不可）への対応として、stuck 検出は _lib/stuck-detector.mjs を canonical とし tools/sync-inlines.mjs で inline 生成する（手書き複製は廃止。issue #208）。

// ==== BEGIN inline: _lib/stuck-detector.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// dev-flow.js の planSeen/blockSeen/evalSeen と pr-iterate.js の reviewSeen が共有する
// stuck 検出 canonical。incentive-structural クラス — W7、撤去禁止。issue #123/#125/#126/#208。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
//
// 命名注記: goal-ledger.mjs の topicKey と同一ファイル dev-flow.js に inline されるため
// 識別子衝突を避けて stuckTopicKey と命名。

// topic fingerprint を導出する。
// (a) x == null → ''
// (b) typeof x === 'string' → x をそのまま返す
// (c) typeof x.topic === 'string' かつ x.topic.trim() が非空 → x.topic.trim()
// (d) x.file != null → `${String(x.file)}::${x.description != null ? String(x.description) : JSON.stringify(x)}`
// (e) x.description != null かつ String(x.description) が非空 → String(x.description)
// (f) それ以外 → JSON.stringify(x)
function stuckTopicKey(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x.topic === 'string' && x.topic.trim()) return x.topic.trim();
  if (x.file != null) {
    return `${String(x.file)}::${x.description != null ? String(x.description) : JSON.stringify(x)}`;
  }
  if (x.description != null && String(x.description)) return String(x.description);
  return JSON.stringify(x);
}

// stuck 検出 closure tracker を返す。
// 内部 state は plain object（Map 禁止 — Object.values/entries の列挙順序まで現行と一致させるため）。
// register(item): topic → { item, count } に累積。同一 topic の再登録は item を最新版で上書き + count 加算。
// prior(): Object.values(seen).map((s) => s.item) を返す。
// stuckTopics(): count >= threshold の topic キー配列を返す。
function makeSeenTracker(threshold) {
  const seen = {};
  return {
    register(item) {
      const t = stuckTopicKey(item);
      if (seen[t]) { seen[t].item = item; seen[t].count += 1 }
      else seen[t] = { item, count: 1 };
    },
    prior() {
      return Object.values(seen).map((s) => s.item);
    },
    stuckTopics() {
      return Object.entries(seen).filter(([, s]) => s.count >= threshold).map(([t]) => t);
    },
  };
}
// ==== END inline: _lib/stuck-detector.mjs ====

// ==== BEGIN inline: _lib/md-cell.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// mdCell: Markdown テーブルセルの値をエスケープする純粋関数。
// I/O なし、非決定性なし。同入力 -> byte 一致。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

/**
 * Markdown テーブルセルの値をエスケープする。
 * パイプ文字を \| に、改行を <br> に変換する。
 * @param {*} v
 * @returns {string}
 */
function mdCell(v) {
  if (v == null) return '';
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
// ==== END inline: _lib/md-cell.mjs ====

// ==== BEGIN inline: _lib/pr-comment-format.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// buildReviewCommentBody / buildTerminalSummaryBody: pr-iterate の per-round
// レビューコメントおよび終端サマリー markdown を生成する純粋関数。
// I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const DECISION_LABEL = {
  'approve': '承認 (LGTM)',
  'request-changes': '変更要求',
  'comment': 'コメント',
};

/**
 * per-round レビューコメント markdown を生成する。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {number} opts.iteration - 反復回数
 * @param {string} opts.decision - 'approve' | 'request-changes' | 'comment'
 * @param {Array} opts.blocking - blocking finding の配列
 * @param {string} [opts.summary] - 結論 1-2 文（任意）
 * @param {string[]} [opts.verificationEvidence] - 検証根拠リスト（任意）
 * @returns {string}
 */
function buildReviewCommentBody({ pr, iteration, decision, blocking, summary, verificationEvidence }) {
  const DECISION_EMOJI = { 'approve': '✅', 'request-changes': '🔴', 'comment': '💬' };
  const SEV_LABEL = { 'critical': '🔴 critical', 'major': '🟠 major', 'minor': '🟡 minor' };
  const label = DECISION_LABEL[decision] ?? decision;
  const emoji = DECISION_EMOJI[decision] ?? '';
  const lines = [];

  lines.push(`## PR #${pr} — レビュー結果 (iteration ${iteration})`);
  lines.push('');

  const blockingList = blocking || [];
  if (blockingList.length === 0) {
    lines.push(`**判定**: ${emoji} ${label} — ✅ blocking 指摘なし`);
  } else {
    const c = blockingList.filter((f) => f.severity === 'critical').length;
    const m = blockingList.filter((f) => f.severity === 'major').length;
    lines.push(`**判定**: ${emoji} ${label} — blocking ${blockingList.length} 件（critical ${c} / major ${m}）`);
    lines.push('');
    lines.push('| # | 重大度 | 場所 | 指摘 | 提案 |');
    lines.push('|---|---|---|---|---|');
    let idx = 1;
    for (const f of blockingList) {
      const sev = SEV_LABEL[f.severity] ?? f.severity;
      const loc = f.file != null
        ? (f.line != null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``)
        : '—';
      const desc = mdCell(f.description);
      const sug = f.suggestion != null ? mdCell(f.suggestion) : '—';
      lines.push(`| ${idx} | ${sev} | ${loc} | ${desc} | ${sug} |`);
      idx++;
    }
  }

  if (summary != null && summary !== '') {
    lines.push('');
    lines.push(`**summary**: ${summary}`);
  }
  const evList = verificationEvidence || [];
  if (evList.length > 0) {
    lines.push('');
    lines.push('**検証根拠**:');
    for (const e of evList) lines.push(`- ${mdCell(e)}`);
  }

  return lines.join('\n');
}

const STATUS_HEADLINE = {
  'lgtm': '🎉 LGTM',
  'stuck': '⚠️ STUCK — 人間レビューへエスカレーション',
  'fix_failed': '⚠️ 自動修正失敗 — 人間へエスカレーション',
  'max_reached': '⚠️ 反復上限到達',
};

/**
 * 終端サマリー markdown を生成する。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {string} opts.status - 'lgtm' | 'stuck' | 'fix_failed' | 'max_reached'
 * @param {number} opts.iterations - 総反復回数
 * @param {string} opts.lastDecision - 最終判定
 * @param {string} opts.lastSummary - 最終サマリーテキスト
 * @param {string[]} [opts.lastVerificationEvidence] - 最終検証根拠リスト（任意）
 * @param {Array} opts.history - ラウンド履歴 [{iteration, decision, summary, blocking}]
 * @returns {string}
 */
function buildTerminalSummaryBody({ pr, status, iterations, lastDecision, lastSummary, lastVerificationEvidence, history }) {
  const DECISION_EMOJI = { 'approve': '✅', 'request-changes': '🔴', 'comment': '💬' };
  const SEV_LABEL = { 'critical': '🔴 critical', 'major': '🟠 major', 'minor': '🟡 minor' };
  const lines = [];

  lines.push(`## PR #${pr} — pr-iterate 終了レポート`);
  lines.push('');
  lines.push(`### ${STATUS_HEADLINE[status] ?? status}`);
  lines.push('');

  lines.push('| 終了状態 | 総反復 | 最終判定 |');
  lines.push('|---|---|---|');
  const decEmoji = DECISION_EMOJI[lastDecision] ?? '';
  const decLabel = DECISION_LABEL[lastDecision] ?? lastDecision;
  lines.push(`| ${status} | ${iterations} | ${decEmoji} ${decLabel} |`);

  lines.push('');
  lines.push(`**最終判定理由**: ${lastSummary}`);

  const evList2 = lastVerificationEvidence || [];
  if (evList2.length > 0) {
    lines.push('');
    lines.push('**検証根拠**:');
    for (const e of evList2) lines.push(`- ${mdCell(e)}`);
  }

  const histList = history || [];
  if (histList.length > 0) {
    lines.push('');
    lines.push('### 反復履歴');
    lines.push('');
    lines.push('| iter | 判定 | blocking | summary |');
    lines.push('|---|---|---|---|');
    for (const round of histList) {
      const rEmoji = DECISION_EMOJI[round.decision] ?? '';
      const rLabel = DECISION_LABEL[round.decision] ?? round.decision;
      const bCount = (round.blocking ?? []).length;
      const rawSummary = mdCell(round.summary);
      const rSummary = rawSummary.length > 120 ? rawSummary.slice(0, 120) + '…' : rawSummary;
      lines.push(`| ${round.iteration} | ${rEmoji} ${rLabel} | ${bCount} | ${rSummary} |`);
    }
  }

  const allBlocking = histList.flatMap((r) => (r.blocking ?? []).map((f) => ({ iter: r.iteration, ...f })));
  const totalBlocking = allBlocking.length;
  if (totalBlocking > 0) {
    lines.push('');
    lines.push(`<details><summary>全 blocking 指摘の詳細（${totalBlocking} 件）</summary>`);
    lines.push('');
    lines.push('| iter | 重大度 | 場所 | 指摘 | 提案 |');
    lines.push('|---|---|---|---|---|');
    for (const f of allBlocking) {
      const sev = SEV_LABEL[f.severity] ?? f.severity;
      const loc = f.file != null
        ? (f.line != null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``)
        : '—';
      const desc = mdCell(f.description);
      const sug = f.suggestion != null ? mdCell(f.suggestion) : '—';
      lines.push(`| ${f.iter} | ${sev} | ${loc} | ${desc} | ${sug} |`);
    }
    lines.push('');
    lines.push('</details>');
  }

  lines.push('');
  lines.push('---');
  lines.push('*このコメントは pr-iterate により自動生成されました。*');
  lines.push(`<!-- pr-iterate:${status}:${iterations} -->`);

  return lines.join('\n');
}
// ==== END inline: _lib/pr-comment-format.mjs ====

// ==== BEGIN inline: _lib/workflow-post-helpers.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// workflow-post-helpers: PR/Issue コメント投稿・ジャーナル記録用の共通スキーマ・ヘルパー。
// I/O なし。bodySaveInstr は agent 向け instruction 文字列を生成する純粋関数。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const POST_RESULT = {
  type: 'object',
  required: ['posted'],
  properties: {
    posted: { type: 'boolean' },
    method: { type: 'string' },
    url: { type: 'string' },
  },
}

const JOURNAL_RESULT = {
  type: 'object',
  required: ['logged'],
  properties: {
    logged: { type: 'boolean' },
    summary: { type: 'string' },
  },
}

/**
 * PR/Issue コメント本文保存の agent 向け instruction を生成する。
 * Write tool 経由で一時ファイルに保存させる手順を返す。
 * @param {string} body - 保存する本文
 * @param {string} tmpPrefix - mktemp の prefix（例: 'dev-flow', 'pr-iterate'）
 * @param {string} delimName - delimiter 名（例: 'DEV_FLOW', 'PR_ITERATE'）
 */
function bodySaveInstr(body, tmpPrefix, delimName) {
  return `## 本文の保存\n`
    + `まず Bash で \`mktemp "\${TMPDIR:-/tmp}/${tmpPrefix}-XXXXXX.md"\` を実行して一時ファイルを作成し、\n`
    + `そのパスを <BODY_FILE> とする。次に **Write tool** を使い、下記 delimiter 内の本文を\n`
    + `**一字一句そのまま** <BODY_FILE> へ書き出せ。本文は絶対に shell（echo/printf/heredoc 等）へ\n`
    + `渡さず、必ず Write tool の content 引数として渡すこと。backtick やコードフェンスを\n`
    + `エスケープ・改変しないこと。以降のコマンドの \`--body-file\` には <BODY_FILE> を指定する。\n`
    + `<<<${delimName}_BODY_BEGIN>>>\n${body}\n<<<${delimName}_BODY_END>>>\n\n`
}
// ==== END inline: _lib/workflow-post-helpers.mjs ====

const REVIEW = {
  type: 'object',
  required: ['decision', 'issues', 'summary'],
  properties: {
    decision: { type: 'string', enum: ['approve', 'request-changes', 'comment'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'topic', 'file', 'description', 'suggestion'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          // 同一問題の再出現を orchestrator が stuck 突合するための安定 ID（issue #126）。
          // 既出指摘を再提起する場合は前ラウンドと同じ文字列を必ず再利用する。
          topic: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
    // 検証根拠の箇条書き（1 項目 1 文）。summary は結論 1-2 文に留める（issue #242）
    verification_evidence: { type: 'array', items: { type: 'string' } },
  },
}

const FIX = {
  type: 'object',
  required: ['applied', 'summary'],
  properties: {
    applied: { type: 'boolean' },
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

// CI gate schema — restores the gate lost in eb8aa7e (issue #133).
// dev-runner runs pr-iterate/scripts/check-ci.sh and returns its stdout JSON unchanged.
// failed_checks items match script output: {name, bucket, state} (conclusion was removed in
// the bucket-field migration; see issue #133 / ci::bats-fabricated-schema).
// 'error' status means gh API failed (auth/network); escalate to human immediately.
const CI_STATUS = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['passed', 'failed', 'pending', 'no_checks', 'error'] },
    failed_checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          bucket: { type: 'string' },
          state: { type: 'string' },
        },
      },
    },
  },
}

phase('Iterate')

let lastReview = null
let lgtm = false
let i = 0
let terminal = null              // 早期終端理由（stuck / fix_failed）。null なら lgtm / max_reached で判定
let fixesApplied = 0  // fix.applied===true の累積回数（dev-flow が stale-eval 警告の判定に使う。issue #233）
const reviewSeen = makeSeenTracker(REVIEW_STUCK)  // findings 累積 & stuck 検出（_lib/stuck-detector.mjs。issue #126）
const history = []               // ラウンド履歴 [{iteration, decision, summary, blocking}]

for (i = 1; i <= MAX; i++) {
  const prior = reviewSeen.prior()   // 前 iteration までの累積 findings
  const review = await agent(
    `PR #${PR} を批判的にレビューせよ。gh pr view / gh pr diff で実 diff を確認し、宣言意図に照合する。\n`
    + `summary は結論 1-2 文に留めよ。検証した根拠（テスト実行・diff 照合・edge case 確認等）は verification_evidence に 1 項目 1 文の配列で列挙せよ。\n`
    + (prior.length
        ? `既出 findings（前ラウンドまでに指摘済み。author は対応済みのはず）:\n${JSON.stringify(prior)}\n`
          + `**新規の critical/major のみ報告**せよ。前ラウンドで対応済み・却下済みの論点の蒸し返し、`
          + `別観点の上乗せ（moving target）は禁止。既出問題を再提起する場合は既出と同じ topic 文字列を`
          + `必ず再利用せよ（orchestrator が topic で stuck を突合する）。`
        : ''),
    { agentType: 'pr-reviewer', model: QUALITY_MODEL, schema: REVIEW, label: `review#${i}`, phase: 'Iterate' },
  )
  if (review == null) throw new Error(`pr-iterate: review#${i} が結果を返しませんでした（skip された可能性）`)
  lastReview = review

  if (review.decision === 'approve') {
    // CI gate — restores the gate lost in eb8aa7e (issue #133).
    // pr-reviewer may LGTM the code but CI must also be green before we declare lgtm.
    // no_checks is treated as passing (consistent with e4e2b92: repos without CI are fine).
    const ci = await agent(
      `## Objective\n`
      + `PR #${PR} の CI ステータスを取得し、JSON をそのまま返せ。\n\n`
      + `## Tools\n`
      + `- 使用可: Bash のみ\n`
      + `- 禁止: Write, Edit, git commit, git push\n\n`
      + `## Boundary\n`
      + `- 読み取り専用。git mutation（commit/push/reset 等）禁止\n`
      + `- 実行するスクリプト以外のファイルを変更しない\n\n`
      + `## Steps\n`
      + `インストール済み skills の **固定パス** で check-ci.sh を実行せよ（リテラルの \`~/.claude/skills/\` プレフィックスをそのまま使うこと）:\n`
      + `\`\`\`\nbash ~/.claude/skills/pr-iterate/scripts/check-ci.sh ${PR}\n\`\`\`\n`
      + `**重要**: 必ずこの \`~/.claude/skills/...\` の絶対パス形で起動せよ。`
      + `worktree 相対パス（\`bash pr-iterate/scripts/check-ci.sh\`）や \`$HOME\` 展開形で起動してはならない。`
      + `\`~/.claude/skills/*\` で起動した場合のみ sandbox 除外（excludedCommands）が効き、`
      + `内部の gh が自身の config（\`~/.config/gh\`）を読めて CI を取得できる。`
      + `sandbox 下で起動すると gh が config 読み取りに失敗し、CI が green でも status:error の誤判定になる。\n`
      + `スクリプトの stdout JSON（{status, failed_checks, ...}）をそのまま返せ。\n\n`
      + `## Output format\n`
      + `{ "status": "passed"|"failed"|"pending"|"no_checks"|"error", "failed_checks": [{name, bucket, state}, ...] }\n`
      + `prose 禁止。JSON のみ返せ。\n\n`
      + `## Token cap\n`
      + `JSON のみ。1 行以内。`,
      { agentType: 'dev-runner', schema: CI_STATUS, label: `ci-check#${i}`, phase: 'Iterate' },
    )

    if (ci == null) throw new Error(`pr-iterate: ci-check#${i} が結果を返しませんでした`)

    if (ci.status === 'passed' || ci.status === 'no_checks') {
      lgtm = true
      log(`iteration ${i}: LGTM（CI status=${ci.status}）`)

      // approve ラウンドの history を記録（blocking なし）
      history.push({ iteration: i, decision: review.decision, summary: review.summary, blocking: [] })

      // per-round 投稿: approve（self-PR 検出 → --approve 失敗時 gh pr comment へフォールバック）
      const approveBody = buildReviewCommentBody({ pr: PR, iteration: i, decision: review.decision, blocking: [], summary: review.summary, verificationEvidence: review.verification_evidence })
      const approvePost = await agent(
        `## Objective\nPR #${PR} に pr-iterate のレビュー結果コメントを投稿する（iteration ${i}、判定: approve）。\n\n`
        + bodySaveInstr(approveBody, 'pr-iterate', 'PR_ITERATE')
        + `## Instructions\n`
        + `保存した <BODY_FILE> を使って以下の手順で投稿せよ：\n`
        + `1. self-PR 検出: \`gh pr view ${PR} --json author -q .author.login\` の出力と \`gh api user -q .login\` の出力を比較する。\n`
        + `2. 自分自身の PR である場合（または --approve が "Cannot approve your own pull request" エラーになる場合）は、\n`
        + `   \`gh pr comment ${PR} --body-file <BODY_FILE>\` でコメント投稿にフォールバックする。\n`
        + `3. 自分自身の PR でない場合は \`gh pr review ${PR} --approve --body-file <BODY_FILE>\` を試みる。\n`
        + `   失敗した場合（"Cannot approve your own pull request" 等）は \`gh pr comment ${PR} --body-file <BODY_FILE>\` にフォールバックする。\n`
        + `4. 投稿成功時: posted:true、使用したコマンドを method に、URL があれば url に返す。\n`
        + `5. 投稿失敗時でも posted:false を返し throw しないこと。\n`
        + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
        + `\n## Tools\n使用可: Bash, Write\n`
        + `\n## Boundary\n<BODY_FILE>（一時ファイル）以外のファイルを変更しない。git commit 禁止。\n`
        + `\n## Token cap\n200 語以内で完結すること。`,
        { agentType: 'dev-runner', schema: POST_RESULT, label: `post-review#${i}`, phase: 'Iterate' },
      )
      if (!approvePost?.posted) {
        log(`⚠️ post-review#${i} (approve) の投稿に失敗しました（posted=${approvePost?.posted ?? 'null'}）。ワークフローは継続します。`)
      }

      break
    } else if (ci.status === 'error') {
      // Real gh API error (auth failure, network error, etc.) — do not misinterpret as CI failure.
      // Surface to human immediately; retrying pr-fix on a non-existent bug would waste cycles.
      terminal = 'ci_error'
      log(`⚠️ CI check returned error — gh API failed (auth/network). 人間へエスカレーション`)
      break
    } else if (ci.status === 'pending') {
      terminal = 'ci_pending'
      log(`⚠️ CI pending — checks incomplete, never auto-approve. 人間/CI 完了待ちへエスカレーション`)
      break
    } else if (ci.status === 'failed') {
      // ci.status === 'failed': convert failed_checks into synthetic blocking findings and route
      // through the existing pr-fix path. Repeated identical ci::<name> topics hit REVIEW_STUCK
      // automatically via the existing stuckTopics computation below.
      // failed_checks items are {name, bucket, state} per check-ci.sh output (no conclusion field).
      const ciFindings = (ci.failed_checks && ci.failed_checks.length > 0)
        ? ci.failed_checks.map((c) => ({
            severity: 'critical',
            topic: `ci::${c.name}`,
            description: `CI check failed: ${c.name} (${c.state ?? c.bucket})`,
            suggestion: 'CI を green にする',
          }))
        : [{
            severity: 'critical',
            topic: 'ci::unknown',
            description: 'CI failed (no specific check details available)',
            suggestion: 'CI を green にする',
          }]

      // Register CI findings into reviewSeen exactly like the existing blocking loop so that
      // repeated identical CI failures (same ci::<name> topic) trigger REVIEW_STUCK escalation.
      for (const x of ciFindings) reviewSeen.register(x)
      const ciStuckTopics = reviewSeen.stuckTopics()
      log(`iteration ${i}: approve but CI failed — ${ciFindings.length} failing check(s)`
        + `${ciStuckTopics.length ? ` [REVIEW_STUCK: ${ciStuckTopics.join(' / ')}]` : ''}`)

      // CI-failed ラウンドの history 記録（blocking は synthetic CI findings）
      history.push({ iteration: i, decision: review.decision, summary: review.summary, blocking: ciFindings })

      // per-round 投稿: CI failed。decision は approve だが CI red のため gh pr review --approve は使わず
      // plain な gh pr comment で情報提供のみ行う
      const ciRoundBody = buildReviewCommentBody({ pr: PR, iteration: i, decision: review.decision, blocking: ciFindings, summary: review.summary, verificationEvidence: review.verification_evidence })
      const ciRoundPost = await agent(
        `## Objective\nPR #${PR} に pr-iterate のレビュー結果コメントを投稿する（iteration ${i}、判定: ${review.decision}、CI failed）。\n\n`
        + bodySaveInstr(ciRoundBody, 'pr-iterate', 'PR_ITERATE')
        + `## Instructions\n`
        + `保存した <BODY_FILE> を使い、以下のコマンドをそのまま実行せよ: \`gh pr comment ${PR} --body-file <BODY_FILE>\`\n`
        + `投稿成功時: posted:true、使用したコマンドを method に、URL があれば url に返す。\n`
        + `投稿失敗時でも posted:false を返し throw しないこと。\n`
        + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
        + `\n## Tools\n使用可: Bash, Write\n`
        + `\n## Boundary\n<BODY_FILE>（一時ファイル）以外のファイルを変更しない。git commit 禁止。\n`
        + `\n## Token cap\n200 語以内で完結すること。`,
        { agentType: 'dev-runner', schema: POST_RESULT, label: `post-review#${i}`, phase: 'Iterate' },
      )
      if (!ciRoundPost?.posted) {
        log(`⚠️ post-review#${i} (ci-failed) の投稿に失敗しました（posted=${ciRoundPost?.posted ?? 'null'}）。ワークフローは継続します。`)
      }

      if (ciStuckTopics.length) {
        terminal = 'stuck'
        log(`⚠️ Review STUCK — 同一 CI failure topic が ${REVIEW_STUCK} 回反復（${ciStuckTopics.join(' / ')}）。`
          + `relax せず人間レビューへエスカレーション（critical/major のゲートは後退させない）`)
        break
      }

      const issuesText = ciFindings
        .map((x) => `- [${x.severity}] ${x.description}${x.suggestion ? ' → ' + x.suggestion : ''}`)
        .join('\n')

      const fix = await agent(
        `PR #${PR} の CI 失敗を修正する。次の CI 失敗を解消するため \`Skill: pr-fix ${PR}\` を実行し、`
        + `修正を push まで行え。解消すべき CI 失敗:\n${issuesText}`,
        { agentType: 'dev-runner', schema: FIX, label: `fix#${i}`, phase: 'Iterate' },
      )

      if (fix == null || fix.applied !== true) {
        terminal = 'fix_failed'
        log(`⚠️ fix#${i} が適用されず（applied=${fix?.applied ?? 'null'}）— ${fix?.summary ?? '理由不明'}。`
          + `無言で再レビューを繰り返さず人間へエスカレーション`)
        break
      }

      // CI fix applied — continue to next iteration for re-review + re-CI-check
      fixesApplied++
      continue
    }
  }

  const blocking = review.issues.filter((x) => x.severity === 'critical' || x.severity === 'major')

  // blocking findings を topic 単位で累積し出現回数を数える（stuck 検出 fingerprint。issue #126）
  for (const x of blocking) reviewSeen.register(x)
  const stuckTopics = reviewSeen.stuckTopics()
  log(`iteration ${i}: ${review.decision} — blocking ${blocking.length} 件`
    + `${stuckTopics.length ? ` [REVIEW_STUCK: ${stuckTopics.join(' / ')}]` : ''}`)

  // history に記録（blocking findings を含む）
  history.push({ iteration: i, decision: review.decision, summary: review.summary, blocking })

  // per-round 投稿: request-changes または comment
  const roundBody = buildReviewCommentBody({ pr: PR, iteration: i, decision: review.decision, blocking, summary: review.summary, verificationEvidence: review.verification_evidence })
  const roundPost = await agent(
    `## Objective\nPR #${PR} に pr-iterate のレビュー結果コメントを投稿する（iteration ${i}、判定: ${review.decision}）。\n\n`
    + bodySaveInstr(roundBody, 'pr-iterate', 'PR_ITERATE')
    + `## Instructions\n`
    + (review.decision === 'request-changes'
      ? `保存した <BODY_FILE> を使って以下の手順で投稿せよ：\n`
        + `1. self-PR 検出: \`gh pr view ${PR} --json author -q .author.login\` の出力と \`gh api user -q .login\` の出力を比較する。\n`
        + `2. 自分自身の PR である場合（または --request-changes が "Can not request changes on your own pull request" エラーになる場合）は、\n`
        + `   \`gh pr comment ${PR} --body-file <BODY_FILE>\` でコメント投稿にフォールバックする。\n`
        + `3. 自分自身の PR でない場合は \`gh pr review ${PR} --request-changes --body-file <BODY_FILE>\` を試みる。\n`
        + `   失敗した場合（"Can not request changes on your own pull request" 等）は \`gh pr comment ${PR} --body-file <BODY_FILE>\` にフォールバックする。\n`
      : `保存した <BODY_FILE> を使い、以下のコマンドをそのまま実行せよ: \`gh pr review ${PR} --comment --body-file <BODY_FILE>\`\n`)
    + `投稿成功時: posted:true、使用したコマンドを method に、URL があれば url に返す。\n`
    + `投稿失敗時でも posted:false を返し throw しないこと。\n`
    + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Write\n`
    + `\n## Boundary\n<BODY_FILE>（一時ファイル）以外のファイルを変更しない。git commit 禁止。\n`
    + `\n## Token cap\n200 語以内で完結すること。`,
    { agentType: 'dev-runner', schema: POST_RESULT, label: `post-review#${i}`, phase: 'Iterate' },
  )
  if (!roundPost?.posted) {
    log(`⚠️ post-review#${i} (${review.decision}) の投稿に失敗しました（posted=${roundPost?.posted ?? 'null'}）。ワークフローは継続します。`)
  }

  // stuck: 同一 topic が REVIEW_STUCK 回繰り返した = fix が刺さっていない。relax せず人間へエスカレーション。
  if (stuckTopics.length) {
    terminal = 'stuck'
    log(`⚠️ Review STUCK — 同一 topic が ${REVIEW_STUCK} 回反復（${stuckTopics.join(' / ')}）。`
      + `relax せず人間レビューへエスカレーション（critical/major のゲートは後退させない）`)
    break
  }

  // pr-fix は portable skill。汎用 workflow agent から Skill 経由で実行する。
  const issuesText = blocking
    .map((x) => `- [${x.severity}] ${x.file ?? ''}${x.line ? ':' + x.line : ''} ${x.description}${x.suggestion ? ' → ' + x.suggestion : ''}`)
    .join('\n')

  // pr-fix は portable skill。Skill を持つ dev-runner agent 経由で実行する。
  const fix = await agent(
    `PR #${PR} のレビュー指摘を修正する。次の指摘を解消するため \`Skill: pr-fix ${PR}\` を実行し、`
    + `修正を push まで行え。解消すべき指摘:\n${issuesText}`,
    { agentType: 'dev-runner', schema: FIX, label: `fix#${i}`, phase: 'Iterate' },
  )

  // fix の applied:false を検出して人間へエスカレーション（無言で MAX 回燃やさない。issue #126）。
  if (fix == null || fix.applied !== true) {
    terminal = 'fix_failed'
    log(`⚠️ fix#${i} が適用されず（applied=${fix?.applied ?? 'null'}）— ${fix?.summary ?? '理由不明'}。`
      + `無言で再レビューを繰り返さず人間へエスカレーション`)
    break
  }
  fixesApplied++
}

const status = lgtm ? 'lgtm' : (terminal ?? 'max_reached')
log(`pr-iterate 終端: status=${status}（iterations=${Math.min(i, MAX)}）`)

// 終端サマリーを PR に 1 回だけ投稿する
const summaryBody = buildTerminalSummaryBody({
  pr: PR,
  status,
  iterations: Math.min(i, MAX),
  lastDecision: lastReview?.decision ?? null,
  lastSummary: lastReview?.summary ?? null,
  lastVerificationEvidence: lastReview?.verification_evidence ?? null,
  history,
})
const summaryPost = await agent(
  `## Objective\nPR #${PR} に pr-iterate の終端サマリーコメントを投稿する（status: ${status}）。\n\n`
  + bodySaveInstr(summaryBody, 'pr-iterate', 'PR_ITERATE')
  + `## Instructions\n`
  + `保存した <BODY_FILE> を使い、以下のコマンドをそのまま実行せよ: \`gh pr comment ${PR} --body-file <BODY_FILE>\`\n`
  + `投稿成功時: posted:true、使用したコマンドを method に、URL があれば url に返す。\n`
  + `投稿失敗時でも posted:false を返し throw しないこと。\n`
  + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
  + `\n## Tools\n使用可: Bash, Write\n`
  + `\n## Boundary\n<BODY_FILE>（一時ファイル）以外のファイルを変更しない。git commit 禁止。\n`
  + `\n## Token cap\n200 語以内で完結すること。`,
  { agentType: 'dev-runner', schema: POST_RESULT, label: `post-summary`, phase: 'Iterate' },
)
if (!summaryPost?.posted) {
  log(`⚠️ post-summary の投稿に失敗しました（posted=${summaryPost?.posted ?? 'null'}）。ワークフローは継続します。`)
}

const telemetryHandoff = buildJournalHandoffPayload({
  skill: 'pr-iterate',
  outcome: 'success',
  args: `pr=${PR}`,
  telemetry: {
    merge_tier: 'PR_ITERATE',
    iterate_status: status,
  },
})
const journalCmd = buildJournalHandoffCommand({ prefix: 'priterate', id: PR, payload: telemetryHandoff })
const journalPost = await agent(
  `## Objective\npr-iterate 終端 status の telemetry handoff を ~/.claude/journal/pending/ に書き出す（Stop hook が journal へ flush する）。\n\n`
  + `## Instructions\n`
  + `次のコマンドをそのまま実行せよ: \`${journalCmd}\`\n`
  + `exit 0 なら logged:true、失敗しても throw せず logged:false を返すこと。\n`
  + `\n## Output format\n{ "logged": boolean, "summary": string }\n`
  + `\n## Tools\n使用可: Bash のみ\n`
  + `\n## Boundary\n~/.claude/journal 以外のファイルを変更しない。git 操作禁止。\n`
  + `\n## Token cap\n100 語以内で完結すること。`,
  { agentType: 'dev-runner-haiku', schema: JOURNAL_RESULT, label: 'journal-log', phase: 'Iterate' },
)
if (!journalPost?.logged) {
  log(`⚠️ journal-log の記録に失敗しました（logged=${journalPost?.logged ?? 'null'}）。ワークフローは継続します。`)
}

return {
  pr: PR,
  status,
  iterations: Math.min(i, MAX),
  fixes_applied: fixesApplied,
  last_decision: lastReview?.decision ?? null,
  last_summary: lastReview?.summary ?? null,
}
