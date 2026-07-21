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
const QUALITY_MODEL = 'fable'
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
  repo,
  pr_number,
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
  if (repo != null && repo !== '') payload.repo = String(repo);
  if (pr_number != null && pr_number !== '') payload.pr_number = Number(pr_number);
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

function repoFromGithubUrl(url) {
  const match = String(url ?? '').match(
    /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+)(?:[\/#?]|$)/,
  );
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
// ==== END inline: _lib/journal-handoff.mjs ====

// args 正規化: 単体 /pr-iterate <pr> でも dev-flow からの workflow('pr-iterate', {pr}) でも受ける
const PR = resolvePositiveIntArg(args, 'pr')
const POST_TERMINAL_SUMMARY = args?.post_terminal_summary !== false
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

// ==== BEGIN inline: _lib/review-normalize.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// pr-iterate.js の review 経路（decision × blocking findings）を正規化する canonical。issue #321。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// review 経路の 3 値 enum。
const REVIEW_ROUTE_CI_GATE = 'ci_gate';
const REVIEW_ROUTE_FIX_LOOP = 'fix_loop';
const REVIEW_ROUTE_CONTRACT_MISMATCH = 'contract_mismatch';

// pr-reviewer の review 結果を route へ正規化する純粋関数。
//
// blocking findings の有無を一次入力、review.decision を tie-break とする:
//   - blocking.length === 0                              → REVIEW_ROUTE_CI_GATE（decision に依らず）
//   - blocking.length > 0 && decision === 'approve'       → REVIEW_ROUTE_CONTRACT_MISMATCH
//   - blocking.length > 0 && decision !== 'approve'       → REVIEW_ROUTE_FIX_LOOP
//
// blocking = severity が 'critical' または 'major' の issue（pr-iterate.js 現行の blocking 定義と同一）。
// minor = severity が 'minor' の issue。
// severity は REVIEW schema で enum ['critical','major','minor'] に制約済みのため
// out-of-enum の追加ハンドリングは入れない。
//
// review が null/undefined、review.issues が配列でない場合も throw せず空配列として扱う。
function classifyReviewRoute(review) {
  const issues = Array.isArray(review?.issues) ? review.issues : [];
  const blocking = issues.filter((x) => x.severity === 'critical' || x.severity === 'major');
  const minor = issues.filter((x) => x.severity === 'minor');

  let route;
  if (blocking.length === 0) {
    route = REVIEW_ROUTE_CI_GATE;
  } else if (review?.decision === 'approve') {
    route = REVIEW_ROUTE_CONTRACT_MISMATCH;
  } else {
    route = REVIEW_ROUTE_FIX_LOOP;
  }

  return { route, blocking, minor };
}
// ==== END inline: _lib/review-normalize.mjs ====

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
// buildTerminalSummaryBody / terminalReviewAction: pr-iterate の終端サマリー
// markdown 生成、および終端 review action（approve/request-changes/comment）
// を決定する純粋関数。
// I/O なし、gh なし、Date.now() 非決定性なし。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const DECISION_LABEL = {
  'approve': '承認 (LGTM)',
  'request-changes': '変更要求',
  'comment': 'コメント',
};

const SEV_LABEL = { 'critical': '🔴 critical', 'major': '🟠 major', 'minor': '🟡 minor' };

/**
 * finding 配列を番号付き箇条書き markdown 行配列へ変換する。
 * 1 finding = 見出し行（severity + 場所）+ `指摘` 行 + （suggestion があれば）`提案` 行。
 * @param {Array} list - finding 配列（severity, file, line, description, suggestion, 任意で iter）
 * @param {object} [opts]
 * @param {boolean} [opts.withIter] - true の場合、見出し行末尾に `（反復 N 回目）` を付与する
 * @returns {string[]}
 */
function formatFindingsList(list, { withIter = false } = {}) {
  const out = [];
  let idx = 1;
  for (const f of list) {
    const sev = SEV_LABEL[f.severity] ?? f.severity;
    const loc = f.file != null
      ? (f.line != null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``)
      : '場所指定なし';
    const iterSuffix = withIter ? `（反復 ${f.iter} 回目）` : '';
    out.push(`${idx}. ${sev} — ${loc}${iterSuffix}`);
    out.push(`   - 指摘: ${mdCell(f.description)}`);
    if (f.suggestion != null) {
      out.push(`   - 提案: ${mdCell(f.suggestion)}`);
    }
    idx++;
  }
  return out;
}

const STATUS_HEADLINE = {
  'lgtm': '🎉 LGTM',
  'stuck': '⚠️ STUCK — 人間レビューへエスカレーション',
  'fix_failed': '⚠️ 自動修正失敗 — 人間へエスカレーション',
  'max_reached': '⚠️ 反復上限到達',
  'ci_error': '⚠️ CI エラー — gh API 失敗（auth/network）。人間へエスカレーション',
  'ci_pending': '⏳ CI 未完了 — checks pending。人間/CI 完了待ちへエスカレーション',
  'review_contract_error': '⚠️ REVIEW CONTRACT ERROR — reviewer の decision と blocking findings の矛盾が再 review 後も再発。人間へエスカレーション',
};

/**
 * 終端サマリー markdown を生成する。
 * @param {object} opts
 * @param {number|string} opts.pr - PR 番号
 * @param {string} opts.status - 'lgtm' | 'stuck' | 'fix_failed' | 'max_reached' | 'ci_error' | 'ci_pending' | 'review_contract_error'
 * @param {number} opts.iterations - 総反復回数
 * @param {string} opts.lastDecision - 最終判定
 * @param {string} opts.lastSummary - 最終サマリーテキスト
 * @param {string[]} [opts.lastVerificationEvidence] - 最終検証根拠リスト（任意）
 * @param {Array} opts.history - ラウンド履歴 [{iteration, decision, summary, blocking, minor}]
 * @param {number} [opts.ciWaitSeconds] - CI pending 待機の累積秒数（任意。check-ci.sh --wait-seconds ポーリング分）
 * @param {number} [opts.ciPollAttempts] - CI ステータス取得の累積ポーリング回数（任意）
 * @returns {string}
 */
function buildTerminalSummaryBody({ pr, status, iterations, lastDecision, lastSummary, lastVerificationEvidence, history, ciWaitSeconds, ciPollAttempts }) {
  const DECISION_EMOJI = { 'approve': '✅', 'request-changes': '🔴', 'comment': '💬' };
  const lines = [];

  lines.push(`## PR #${pr} — pr-iterate 終了レポート`);
  lines.push('');
  lines.push(`### ${STATUS_HEADLINE[status] ?? status}`);
  lines.push('');

  lines.push('| 終了状態 | 反復回数 | 最終判定 |');
  lines.push('|---|---|---|');
  const decEmoji = DECISION_EMOJI[lastDecision] ?? '';
  const decLabel = DECISION_LABEL[lastDecision] ?? lastDecision;
  lines.push(`| ${status} | ${iterations} | ${decEmoji} ${decLabel} |`);

  lines.push('');
  lines.push(`**最終判定理由**: ${lastSummary}`);

  if (ciWaitSeconds != null || ciPollAttempts != null) {
    lines.push('');
    lines.push(`**CI 待機**: ${ciWaitSeconds ?? 0}秒（ポーリング ${ciPollAttempts ?? 0} 回）`);
  }

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
    lines.push('| 反復 | 判定 | 要修正 (blocking) | 軽微 (minor) | 総評 |');
    lines.push('|---|---|---|---|---|');
    for (const round of histList) {
      const rEmoji = DECISION_EMOJI[round.decision] ?? '';
      const rLabel = DECISION_LABEL[round.decision] ?? round.decision;
      const bCount = (round.blocking ?? []).length;
      const mCount = (round.minor ?? []).length;
      const rawSummary = mdCell(round.summary);
      const rSummary = rawSummary.length > 120 ? rawSummary.slice(0, 120) + '…' : rawSummary;
      lines.push(`| ${round.iteration} | ${rEmoji} ${rLabel} | ${bCount} | ${mCount} | ${rSummary} |`);
    }
  }

  const allBlocking = histList.flatMap((r) => (r.blocking ?? []).map((f) => ({ iter: r.iteration, ...f })));
  const totalBlocking = allBlocking.length;
  if (totalBlocking > 0) {
    lines.push('');
    lines.push(`<details><summary>要修正（blocking）指摘の全詳細（${totalBlocking} 件）</summary>`);
    lines.push('');
    lines.push(...formatFindingsList(allBlocking, { withIter: true }));
    lines.push('');
    lines.push('</details>');
  }

  const allMinor = histList.flatMap((r) => (r.minor ?? []).map((f) => ({ iter: r.iteration, ...f })));
  const totalMinor = allMinor.length;
  if (totalMinor > 0) {
    lines.push('');
    lines.push(`<details><summary>軽微な指摘（minor）の全詳細（自動修正対象外・${totalMinor} 件）</summary>`);
    lines.push('');
    lines.push(...formatFindingsList(allMinor, { withIter: true }));
    lines.push('');
    lines.push('</details>');
  }

  lines.push('');
  lines.push('---');
  lines.push('*このコメントは pr-iterate により自動生成されました。*');
  lines.push(`<!-- pr-iterate:${status}:${iterations} -->`);

  return lines.join('\n');
}

/**
 * 終端レビューアクションを決定する純粋関数（AC-2）。
 * @param {object} opts
 * @param {string} opts.status - 'lgtm'|'stuck'|'fix_failed'|'max_reached'|'ci_error'|'ci_pending'|'review_contract_error'
 * @param {string|null} opts.lastDecision - 'approve'|'request-changes'|'comment'|null
 * @param {number} opts.blockingCount - 終端時点の blocking finding 総数
 * @returns {'approve'|'request-changes'|'comment'}
 */
function terminalReviewAction({ status, lastDecision, blockingCount }) {
  if (status === 'lgtm' && lastDecision === 'approve') return 'approve';
  if (blockingCount > 0 && lastDecision === 'request-changes') return 'request-changes';
  return 'comment';
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
          description: { type: 'string', maxLength: 300 },
          suggestion: { type: 'string', maxLength: 200 },
        },
      },
    },
    summary: { type: 'string', maxLength: 200 },
    // 検証根拠の箇条書き（1 項目 1 文）。summary は結論 1-2 文に留める（issue #242）
    verification_evidence: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 120 } },
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
// dev-runner-haiku-ro runs pr-iterate/scripts/check-ci.sh and returns its stdout JSON unchanged.
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
    // check-ci.sh --wait-seconds ポーリングの累積待機秒数 / ポーリング（gh fetch）回数（issue #324）。
    // ポーリング未実行（wait-seconds 未指定 or 即決定）でも script は常に返す。
    waited_seconds: { type: 'number' },
    poll_attempts: { type: 'number' },
  },
}

phase('Iterate')

// repo (owner/name) probe: PR の base repo URL から owner/name を導出する（telemetry の repo 解決用。issue #309）。
// fail-open — probe 失敗/null でも repo を省略するだけで workflow は継続する。
const PR_META = { type: 'object', required: ['url'], properties: { url: { type: 'string' } } }
const prMeta = await agent(
  `## Objective\nPR #${PR} の URL を取得する（telemetry の repo 解決用）。\n\n## Instructions\n次のコマンドをそのまま実行し、stdout（1 行）を url として返せ: \`gh pr view ${PR} --json url -q .url\`\nコマンド失敗時は throw せず url を空文字で返すこと。\n\n## Output format\n{ "url": string }\n\n## Tools\n使用可: Bash のみ\n\n## Boundary\nファイル変更・git 操作禁止。\n\n## Token cap\n50 語以内で完結すること。`,
  { agentType: 'dev-runner-haiku-ro', schema: PR_META, label: 'pr-meta', phase: 'Iterate' },
)
const REPO = repoFromGithubUrl(prMeta?.url)
if (!REPO) log('⚠️ repo (owner/name) を解決できず — telemetry の repo は省略される')

let lastReview = null
let lgtm = false
let i = 0
let terminal = null              // 早期終端理由（stuck / fix_failed）。null なら lgtm / max_reached で判定
let fixesApplied = 0  // fix.applied===true の累積回数（dev-flow が stale-eval 警告の判定に使う。issue #233）
let fixNullRetries = 0  // fix agent が null（schema 不一致・技術的失敗）で 1 回 retry した累積回数。issue #347
let totalCiWaitSeconds = 0  // check-ci.sh --wait-seconds ポーリングの累積待機秒数（全 ci-check ラウンド合算。issue #324）
let totalCiPollAttempts = 0  // 同上の累積ポーリング（gh fetch）回数
const reviewSeen = makeSeenTracker(REVIEW_STUCK)  // findings 累積 & stuck 検出（_lib/stuck-detector.mjs。issue #126）
const history = []               // ラウンド履歴 [{iteration, decision, summary, blocking, minor}]

// fix agent が null（schema 不一致/技術的失敗）の場合のみ、同一 findings で 1 回だけ再試行する。
// applied:false（agent の明示判断による修正不能）は retry しない — stuck 検出等の incentive-structural
// 機構は不変。retry は iteration ごと最大 1 回で有限（review#N-contract-retry :604-614 と同パターン、
// MAX 非消費）。issue #347
async function callFixAgent(prompt, i) {
  let fix = await agent(prompt, { agentType: 'dev-runner', schema: FIX, label: `fix#${i}`, phase: 'Iterate' })
  let retried = false
  if (fix == null) {
    retried = true
    fixNullRetries++
    log(`⚠️ fix#${i} が null（schema 不一致/技術的失敗）— 同一 findings で 1 回だけ再試行する（fix-null-retry）`)
    fix = await agent(prompt, { agentType: 'dev-runner', schema: FIX, label: `fix#${i}-retry`, phase: 'Iterate' })
  }
  return { fix, retried }
}

for (i = 1; i <= MAX; i++) {
  const prior = reviewSeen.prior()   // 前 iteration までの累積 findings
  const reviewPrompt = `PR #${PR} を批判的にレビューせよ。gh pr view / gh pr diff で実 diff を確認し、宣言意図に照合する。\n`
    + `summary は結論 1-2 文に留めよ。検証した根拠（テスト実行・diff 照合・edge case 確認等）は verification_evidence に 1 項目 1 文の配列で列挙せよ。\n`
    + (prior.length
        ? `既出 findings（前ラウンドまでに指摘済み。author は対応済みのはず）:\n${JSON.stringify(prior)}\n`
          + `**新規の critical/major のみ報告**せよ。前ラウンドで対応済み・却下済みの論点の蒸し返し、`
          + `別観点の上乗せ（moving target）は禁止。既出問題を再提起する場合は既出と同じ topic 文字列を`
          + `必ず再利用せよ（orchestrator が topic で stuck を突合する）。`
        : '')
  const review = await agent(
    reviewPrompt,
    { agentType: 'pr-reviewer', model: QUALITY_MODEL, schema: REVIEW, label: `review#${i}`, phase: 'Iterate' },
  )
  if (review == null) throw new Error(`pr-iterate: review#${i} が結果を返しませんでした（skip された可能性）`)
  lastReview = review

  let effReview = review
  let outcome = classifyReviewRoute(review)

  // contract mismatch（approve だが blocking あり）: 同一 iteration 内で 1 回だけ再 review する。
  // MAX は消費しない — 有限性は「iteration ごと最大 1 回」で担保する（issue #321）。
  if (outcome.route === 'contract_mismatch') {
    log(`⚠️ iteration ${i}: review contract mismatch — decision=approve だが blocking ${outcome.blocking.length} 件。1 回だけ再 review する`)
    const rereview = await agent(
      reviewPrompt
      + `\n\n直前の review 出力は decision='approve' なのに critical/major の issues が ${outcome.blocking.length} 件あり矛盾している。`
      + `直前の出力: ${JSON.stringify(review)}。`
      + `blocking issues が実在するなら decision を request-changes/comment にし、実在しないなら issues から除いて、`
      + `decision と issues が整合した結果を再出力せよ。既出問題の topic 文字列は同一のものを再利用せよ。`,
      { agentType: 'pr-reviewer', model: QUALITY_MODEL, schema: REVIEW, label: `review#${i}-contract-retry`, phase: 'Iterate' },
    )
    if (rereview == null) throw new Error(`pr-iterate: review#${i}-contract-retry が結果を返しませんでした（skip された可能性）`)
    effReview = rereview
    lastReview = rereview
    outcome = classifyReviewRoute(rereview)

    if (outcome.route === 'contract_mismatch') {
      // 再 review 後も decision と blocking の矛盾が再発 — 無限ループせず人間へエスカレーション。
      // 注意: この mismatch review の blocking は reviewSeen に register しない
      // （fix を挟まない再 review が REVIEW_STUCK を 1 iteration 内で誤発火させるため）。
      terminal = 'review_contract_error'
      log(`⚠️ iteration ${i}: review contract mismatch が再 review 後も再発（decision=approve、blocking ${outcome.blocking.length} 件）。人間へエスカレーション`)

      history.push({ iteration: i, decision: effReview.decision, summary: effReview.summary, blocking: outcome.blocking, minor: outcome.minor })

      break
    }
  }

  if (outcome.route === 'ci_gate') {
    // CI gate — restores the gate lost in eb8aa7e (issue #133)。blocking 0 件の comment/request-changes も
    // ここへ合流する（AC-1/AC-2、issue #321）。lgtm 確定時の投稿のみ decision で分岐する（approve でなければ捏造しない）。
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
      + `\`\`\`\nbash ~/.claude/skills/pr-iterate/scripts/check-ci.sh ${PR} --wait-seconds 90 --poll-seconds 15\n\`\`\`\n`
      + `**重要**: 必ずこの \`~/.claude/skills/...\` の絶対パス形で起動せよ。`
      + `worktree 相対パス（\`bash pr-iterate/scripts/check-ci.sh\`）や \`$HOME\` 展開形で起動してはならない。`
      + `\`~/.claude/skills/*\` で起動した場合のみ sandbox 除外（excludedCommands）が効き、`
      + `内部の gh が自身の config（\`~/.config/gh\`）を読めて CI を取得できる。`
      + `sandbox 下で起動すると gh が config 読み取りに失敗し、CI が green でも status:error の誤判定になる。\n`
      + `\`--wait-seconds 90 --poll-seconds 15\` は CI pending 時に最大 90 秒（15 秒間隔）ポーリングしてから確定する`
      + `（AC-1/AC-2）。この Bash 実行の timeout パラメータには必ず 300000（ミリ秒。5分）を指定せよ — `
      + `既定の 120000ms では最大 90 秒のポーリング＋ gh API retry backoff の合計に対して余裕が無い。\n`
      + `スクリプトの stdout JSON（{status, failed_checks, waited_seconds, poll_attempts, ...}）をそのまま返せ。\n\n`
      + `## Output format\n`
      + `{ "status": "passed"|"failed"|"pending"|"no_checks"|"error", "failed_checks": [{name, bucket, state}, ...], `
      + `"waited_seconds": number, "poll_attempts": number }\n`
      + `prose 禁止。JSON のみ返せ。\n\n`
      + `## Token cap\n`
      + `JSON のみ。1 行以内。`,
      { agentType: 'dev-runner-haiku-ro', schema: CI_STATUS, label: `ci-check#${i}`, phase: 'Iterate' },
    )

    if (ci == null) throw new Error(`pr-iterate: ci-check#${i} が結果を返しませんでした`)

    // waited_seconds/poll_attempts は route（passed/pending/failed/error）に関わらず常に加算する。
    totalCiWaitSeconds += Number(ci.waited_seconds ?? 0)
    totalCiPollAttempts += Number(ci.poll_attempts ?? 0)
    log(`iteration ${i}: ci-check waited_seconds=${ci.waited_seconds ?? 0} poll_attempts=${ci.poll_attempts ?? 0}`
      + `（累積 waited=${totalCiWaitSeconds}s poll=${totalCiPollAttempts}）`)

    if (ci.status === 'passed' || ci.status === 'no_checks') {
      lgtm = true
      log(`iteration ${i}: LGTM（CI status=${ci.status}）`)

      // lgtm 確定ラウンドの history を記録（blocking なし、minor は保持）
      history.push({ iteration: i, decision: effReview.decision, summary: effReview.summary, blocking: [], minor: outcome.minor })

      break
    } else if (ci.status === 'error') {
      // Real gh API error (auth failure, network error, etc.) — do not misinterpret as CI failure.
      // Surface to human immediately; retrying a fix on a non-existent bug would waste cycles.
      terminal = 'ci_error'
      log(`⚠️ CI check returned error — gh API failed (auth/network). 人間へエスカレーション`)
      break
    } else if (ci.status === 'pending') {
      terminal = 'ci_pending'
      log(`⚠️ CI pending — checks incomplete, never auto-approve. 人間/CI 完了待ちへエスカレーション`)
      break
    } else if (ci.status === 'failed') {
      // ci.status === 'failed': convert failed_checks into synthetic blocking findings and route
      // through the existing fix path. Repeated identical ci::<name> topics hit REVIEW_STUCK
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
      log(`iteration ${i}: ${effReview.decision} だが CI failed — ${ciFindings.length} failing check(s)`
        + `${ciStuckTopics.length ? ` [REVIEW_STUCK: ${ciStuckTopics.join(' / ')}]` : ''}`)

      // CI-failed ラウンドの history 記録（blocking は synthetic CI findings、minor は保持）
      const ciRound = { iteration: i, decision: effReview.decision, summary: effReview.summary, blocking: ciFindings, minor: outcome.minor }
      history.push(ciRound)

      if (ciStuckTopics.length) {
        terminal = 'stuck'
        log(`⚠️ Review STUCK — 同一 CI failure topic が ${REVIEW_STUCK} 回反復（${ciStuckTopics.join(' / ')}）。`
          + `relax せず人間レビューへエスカレーション（critical/major のゲートは後退させない）`)
        break
      }

      const issuesText = ciFindings
        .map((x) => `- [${x.severity}] ${x.description}${x.suggestion ? ' → ' + x.suggestion : ''}`)
        .join('\n')

      const ciFixPrompt = `PR #${PR} の CI 失敗を修正する。手順: (1) \`gh pr checkout ${PR}\` で PR ブランチを checkout、`
        + `(2) 下記の CI 失敗を修正、(3) Conventional Commits 形式で commit、(4) \`git push\` で push。`
        + `解消すべき CI 失敗:\n${issuesText}`
      const { fix, retried } = await callFixAgent(ciFixPrompt, i)
      if (retried) ciRound.fix_retried = true

      if (fix == null || fix.applied !== true) {
        terminal = 'fix_failed'
        log(`⚠️ fix#${i} が適用されず（applied=${fix?.applied ?? 'null'}）— ${fix?.summary ?? '理由不明'}${retried ? '（retry 後も null）' : ''}。`
          + `無言で再レビューを繰り返さず人間へエスカレーション`)
        break
      }

      // CI fix applied — continue to next iteration for re-review + re-CI-check
      fixesApplied++
      continue
    }
  } else {
    // outcome.route === 'fix_loop'（blocking あり、decision は request-changes/comment。approve はここへ来ない）
    const blocking = outcome.blocking

    // blocking findings を topic 単位で累積し出現回数を数える（stuck 検出 fingerprint。issue #126）
    for (const x of blocking) reviewSeen.register(x)
    const stuckTopics = reviewSeen.stuckTopics()
    log(`iteration ${i}: ${effReview.decision} — blocking ${blocking.length} 件`
      + `${stuckTopics.length ? ` [REVIEW_STUCK: ${stuckTopics.join(' / ')}]` : ''}`)

    // history に記録（blocking findings と minor を含む）
    const round = { iteration: i, decision: effReview.decision, summary: effReview.summary, blocking, minor: outcome.minor }
    history.push(round)

    // stuck: 同一 topic が REVIEW_STUCK 回繰り返した = fix が刺さっていない。relax せず人間へエスカレーション。
    if (stuckTopics.length) {
      terminal = 'stuck'
      log(`⚠️ Review STUCK — 同一 topic が ${REVIEW_STUCK} 回反復（${stuckTopics.join(' / ')}）。`
        + `relax せず人間レビューへエスカレーション（critical/major のゲートは後退させない）`)
      break
    }

    // minor は fix loop の対象外 — issuesText / fix agent プロンプトに一切含めない（AC-5、issue #321）。
    const issuesText = blocking
      .map((x) => `- [${x.severity}] ${x.file ?? ''}${x.line ? ':' + x.line : ''} ${x.description}${x.suggestion ? ' → ' + x.suggestion : ''}`)
      .join('\n')

    // fix は dev-runner agent に直接指示する（旧 pr-fix skill は issue #116 で削除）。
    const fixPrompt = `PR #${PR} のレビュー指摘を修正する。手順: (1) \`gh pr checkout ${PR}\` で PR ブランチを checkout、`
      + `(2) 下記の指摘を修正、(3) Conventional Commits 形式で commit、(4) \`git push\` で push。`
      + `解消すべき指摘:\n${issuesText}`
    const { fix, retried } = await callFixAgent(fixPrompt, i)
    if (retried) round.fix_retried = true

    // fix の applied:false を検出して人間へエスカレーション（無言で MAX 回燃やさない。issue #126）。
    if (fix == null || fix.applied !== true) {
      terminal = 'fix_failed'
      log(`⚠️ fix#${i} が適用されず（applied=${fix?.applied ?? 'null'}）— ${fix?.summary ?? '理由不明'}${retried ? '（retry 後も null）' : ''}。`
        + `無言で再レビューを繰り返さず人間へエスカレーション`)
      break
    }
    fixesApplied++
  }
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
  ciWaitSeconds: totalCiWaitSeconds,
  ciPollAttempts: totalCiPollAttempts,
})
const terminalBlockingCount = (history[history.length - 1]?.blocking ?? []).length
const termAction = terminalReviewAction({ status, lastDecision: lastReview?.decision ?? null, blockingCount: terminalBlockingCount })

if (POST_TERMINAL_SUMMARY) {
  let summaryInstructions
  if (termAction === 'approve') {
    summaryInstructions = `保存した <BODY_FILE> を使って以下の手順で投稿せよ：\n`
      + `1. self-PR 検出: \`gh pr view ${PR} --json author -q .author.login\` の出力と \`gh api user -q .login\` の出力を比較する。\n`
      + `2. 自分自身の PR である場合（または --approve が "Cannot approve your own pull request" エラーになる場合）は、\n`
      + `   \`gh pr comment ${PR} --body-file <BODY_FILE>\` でコメント投稿にフォールバックする。\n`
      + `3. 自分自身の PR でない場合は \`gh pr review ${PR} --approve --body-file <BODY_FILE>\` を試みる。\n`
      + `   失敗した場合（"Cannot approve your own pull request" 等）は \`gh pr comment ${PR} --body-file <BODY_FILE>\` にフォールバックする。\n`
      + `4. 投稿成功時: posted:true、使用したコマンドを method に、URL があれば url に返す。\n`
      + `5. 投稿失敗時でも posted:false を返し throw しないこと。\n`
  } else if (termAction === 'request-changes') {
    summaryInstructions = `保存した <BODY_FILE> を使って以下の手順で投稿せよ：\n`
      + `1. self-PR 検出: \`gh pr view ${PR} --json author -q .author.login\` の出力と \`gh api user -q .login\` の出力を比較する。\n`
      + `2. 自分自身の PR である場合（または --request-changes が "Can not request changes on your own pull request" エラーになる場合）は、\n`
      + `   \`gh pr comment ${PR} --body-file <BODY_FILE>\` でコメント投稿にフォールバックする。\n`
      + `3. 自分自身の PR でない場合は \`gh pr review ${PR} --request-changes --body-file <BODY_FILE>\` を試みる。\n`
      + `   失敗した場合（"Can not request changes on your own pull request" 等）は \`gh pr comment ${PR} --body-file <BODY_FILE>\` にフォールバックする。\n`
      + `4. 投稿成功時: posted:true、使用したコマンドを method に、URL があれば url に返す。\n`
      + `5. 投稿失敗時でも posted:false を返し throw しないこと。\n`
  } else {
    summaryInstructions = `保存した <BODY_FILE> を使い、以下のコマンドをそのまま実行せよ: \`gh pr comment ${PR} --body-file <BODY_FILE>\`\n`
      + `投稿成功時: posted:true、使用したコマンドを method に、URL があれば url に返す。\n`
      + `投稿失敗時でも posted:false を返し throw しないこと。\n`
  }

  const summaryPost = await agent(
    `## Objective\nPR #${PR} に pr-iterate の終端サマリーコメントを投稿する（status: ${status}、action: ${termAction}）。\n\n`
    + bodySaveInstr(summaryBody, 'pr-iterate', 'PR_ITERATE')
    + `## Instructions\n`
    + summaryInstructions
    + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Write\n`
    + `\n## Boundary\n<BODY_FILE>（一時ファイル）以外のファイルを変更しない。git commit 禁止。\n`
    + `\n## Token cap\n200 語以内で完結すること。`,
    { agentType: 'dev-runner-haiku', schema: POST_RESULT, label: `post-summary`, phase: 'Iterate' },
  )
  if (!summaryPost?.posted) {
    log(`⚠️ post-summary の投稿に失敗しました（posted=${summaryPost?.posted ?? 'null'}）。ワークフローは継続します。`)
  }
}

const telemetryHandoff = buildJournalHandoffPayload({
  skill: 'pr-iterate',
  outcome: 'success',
  args: `pr=${PR}`,
  repo: REPO,
  pr_number: Number(PR),
  telemetry: {
    merge_tier: 'PR_ITERATE',
    iterate_status: status,
    ci_wait_seconds: totalCiWaitSeconds,
    ci_poll_attempts: totalCiPollAttempts,
    fix_null_retries: fixNullRetries,
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
  ci_wait_seconds: totalCiWaitSeconds,
  ci_poll_attempts: totalCiPollAttempts,
  fix_null_retries: fixNullRetries,
  history,
}
