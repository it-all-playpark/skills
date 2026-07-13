export const meta = {
  name: 'dev-improve',
  description: 'dev-flow 自己改善サイクル: 仮説突合→4ソースマイニング→rank→issue化（上限2件/回、実装は呼び出し元が dev-flow を起動、merge は人間）',
  whenToUse: '週次 self-improve サイクル。/dev-flow-improve 起動 skill から呼ばれる。単体起動も可（issue 化まで）',
  phases: [
    { title: 'Reconcile', detail: '前サイクル仮説の実測突合' },
    { title: 'Mine', detail: '4ソース並列マイニング' },
    { title: 'Rank', detail: 'dedup + 優先度 rank + 上位2件' },
    { title: 'File', detail: 'issue 作成 + backlog 追記 + telemetry' },
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

// ==== BEGIN inline: _lib/improve-hypothesis.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// _lib/improve-hypothesis.mjs
// dev-improve の hypothesis ブロック（issue body 埋め込み）の build / parse / status 更新と
// metric enum。I/O なし・非決定性なし。verdict（confirmed/not_confirmed/insufficient_data）の
// 判定は dev-flow-improve/scripts/hypothesis-check.sh（決定論 oracle）が単一実装 —
// 本ファイルでは重複実装しない（軸A: LLM/orchestrator 側に効果判定を持たせない）。
// metric enum は hypothesis-check.sh の case 分岐と 1:1 対応を保つこと。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

// 仮説 metric の閉じた enum。direction: 'lte' = target 以下で confirmed / 'gte' = target 以上で confirmed。
const IMPROVE_METRIC_DIRECTIONS = Object.freeze({
  iterate_unhealthy_rate: 'lte',
  micro_share: 'gte',
  cap_pinned_count: 'lte',
});

const HYPOTHESIS_BEGIN = '<!-- dev-improve:hypothesis:begin -->';
const HYPOTHESIS_END = '<!-- dev-improve:hypothesis:end -->';
const HYPOTHESIS_STATUSES = Object.freeze(['pending', 'confirmed', 'not_confirmed']);

function improveMetricNames() {
  return Object.keys(IMPROVE_METRIC_DIRECTIONS);
}

// buildHypothesisBlock({metric, current, target, min_runs}) → markdown 文字列（status は常に pending）。
// out-of-enum metric / 非数値 / min_runs 非正整数は throw。
function buildHypothesisBlock({ metric, current, target, min_runs }) {
  if (!IMPROVE_METRIC_DIRECTIONS[metric]) {
    throw new Error(`improve-hypothesis: out-of-enum metric: ${JSON.stringify(metric ?? null)}`);
  }
  for (const [k, v] of [['current', current], ['target', target]]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`improve-hypothesis: ${k} は有限数が必要です（受信: ${JSON.stringify(v)}）`);
    }
  }
  if (!Number.isInteger(min_runs) || min_runs < 1) {
    throw new Error(`improve-hypothesis: min_runs は正の整数が必要です（受信: ${JSON.stringify(min_runs)}）`);
  }
  return [
    HYPOTHESIS_BEGIN,
    '```yaml',
    `metric: ${metric}`,
    `current: ${current}`,
    `target: ${target}`,
    `min_runs: ${min_runs}`,
    'status: pending',
    '```',
    HYPOTHESIS_END,
  ].join('\n');
}

// parseHypothesisBlock(body) → {metric, current, target, min_runs, status} | null。
// マーカー不在は null（hypothesis 無し issue）。マーカーはあるが中身が不正なら throw
//（呼び出し側が per-issue try/catch で fail-open する）。
function parseHypothesisBlock(body) {
  const src = String(body ?? '');
  const beginIdx = src.indexOf(HYPOTHESIS_BEGIN);
  if (beginIdx === -1) return null;
  const endIdx = src.indexOf(HYPOTHESIS_END, beginIdx);
  if (endIdx === -1) {
    throw new Error('improve-hypothesis: end マーカーがありません');
  }
  const zone = src.slice(beginIdx + HYPOTHESIS_BEGIN.length, endIdx);
  const fields = {};
  for (const line of zone.split('\n')) {
    const m = line.match(/^(metric|current|target|min_runs|status):\s*(\S+)\s*$/);
    if (m) fields[m[1]] = m[2];
  }
  const metric = fields.metric;
  if (!IMPROVE_METRIC_DIRECTIONS[metric]) {
    throw new Error(`improve-hypothesis: out-of-enum metric: ${JSON.stringify(metric ?? null)}`);
  }
  const current = Number(fields.current);
  const target = Number(fields.target);
  const min_runs = Number(fields.min_runs);
  if (!Number.isFinite(current) || !Number.isFinite(target)
    || !Number.isInteger(min_runs) || min_runs < 1) {
    throw new Error('improve-hypothesis: current/target/min_runs が不正です');
  }
  if (!HYPOTHESIS_STATUSES.includes(fields.status)) {
    throw new Error(`improve-hypothesis: out-of-enum status: ${JSON.stringify(fields.status ?? null)}`);
  }
  return { metric, current, target, min_runs, status: fields.status };
}

// setHypothesisStatus(body, newStatus) → block 内の status 行のみ置換した body を返す。
// out-of-enum status / block 不在・不正 body は throw。
function setHypothesisStatus(body, newStatus) {
  if (!HYPOTHESIS_STATUSES.includes(newStatus)) {
    throw new Error(`improve-hypothesis: out-of-enum status: ${JSON.stringify(newStatus)}`);
  }
  const parsed = parseHypothesisBlock(body);
  if (parsed == null) {
    throw new Error('improve-hypothesis: hypothesis ブロックが存在しません');
  }
  const src = String(body);
  const beginIdx = src.indexOf(HYPOTHESIS_BEGIN);
  const endIdx = src.indexOf(HYPOTHESIS_END, beginIdx);
  const zone = src.slice(beginIdx, endIdx);
  const newZone = zone.replace(/^status: .*$/m, `status: ${newStatus}`);
  return src.slice(0, beginIdx) + newZone + src.slice(endIdx);
}
// ==== END inline: _lib/improve-hypothesis.mjs ====

// ==== BEGIN inline: _lib/improve-rank.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
// _lib/improve-rank.mjs
// dev-improve の候補 validate / dedup fingerprint / 決定論 rank / throughput cap +
// backpressure / issue body 生成。I/O なし・非決定性なし。
// LLM judge はスコア付けのみ — 最終順位・cut・棄却は本ファイルの決定論で行う
//（W7: cap は incentive-structural — ループに自分の提案量を自己増幅させない）。
// cross-canonical import 禁止のため metric enum は validateCandidate の引数で受ける。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const IMPROVE_MAX = 2;
const IMPROVE_BACKPRESSURE_OPEN = 2;
const IMPROVE_SOURCES = Object.freeze([
  'doctor-anomaly', 'failure-rca', 'sunset', 'pr-signal', 'reconcile-revert',
]);
const IMPROVE_RISKS = Object.freeze(['low', 'medium', 'high']);
// dev-flow 本体（自己改変）に該当する path prefix。触れる候補は canary AC を自動追記する。
const IMPROVE_CORE_PREFIXES = Object.freeze([
  '.claude/workflows/', '_lib/', '.claude/agents/', 'tools/',
]);

// candidateKey(c): dedup 用の正規化 fingerprint。unicode 文字・数字以外を除去し lowercase。
function candidateKey(c) {
  return String(c?.title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// validateCandidate(c, metricNames): 共通 candidate schema の決定論バリデーション。
// evidence 空・AC 空・out-of-enum source/risk/metric・数値不正は false（棄却）。
function validateCandidate(c, metricNames) {
  if (c == null || typeof c !== 'object') return false;
  if (!IMPROVE_SOURCES.includes(c.source)) return false;
  if (typeof c.title !== 'string' || !c.title.trim()) return false;
  if (!Array.isArray(c.evidence) || c.evidence.length === 0) return false;
  if (!c.evidence.every((e) => typeof e === 'string' && e.trim())) return false;
  if (!Array.isArray(c.acceptance_criteria) || c.acceptance_criteria.length === 0) return false;
  if (!c.acceptance_criteria.every((a) => typeof a === 'string' && a.trim())) return false;
  if (!IMPROVE_RISKS.includes(c.risk)) return false;
  const d = c.expected_metric_delta;
  if (d == null || typeof d !== 'object') return false;
  if (!Array.isArray(metricNames) || !metricNames.includes(d.metric)) return false;
  if (typeof d.current !== 'number' || !Number.isFinite(d.current)) return false;
  if (typeof d.target !== 'number' || !Number.isFinite(d.target)) return false;
  if (!Number.isInteger(d.min_runs) || d.min_runs < 1) return false;
  return true;
}

// rankCandidates(cands, scores): judge の {index, score} を突合し決定論順に整列した新配列を返す。
// score 降順 → risk 昇順（low < medium < high）→ candidateKey 昇順。score 不在 index は 0 扱い。
function rankCandidates(cands, scores) {
  const scoreByIndex = {};
  for (const s of Array.isArray(scores) ? scores : []) {
    if (s != null && Number.isInteger(s.index) && typeof s.score === 'number' && Number.isFinite(s.score)) {
      scoreByIndex[s.index] = s.score;
    }
  }
  const riskOrder = { low: 0, medium: 1, high: 2 };
  return cands
    .map((c, i) => ({ c, score: scoreByIndex[i] ?? 0 }))
    .sort((a, b) => (b.score - a.score)
      || (riskOrder[a.c.risk] - riskOrder[b.c.risk])
      || (candidateKey(a.c) < candidateKey(b.c) ? -1 : candidateKey(a.c) > candidateKey(b.c) ? 1 : 0))
    .map((x) => x.c);
}

// selectTop(ranked, openImproveCount): backpressure + IMPROVE_MAX cut。
// openImproveCount が取得不能な場合は Infinity を渡す（fail-closed = backpressure 扱い）。
function selectTop(ranked, openImproveCount) {
  if (Number(openImproveCount) >= IMPROVE_BACKPRESSURE_OPEN) {
    return { file: [], backlog: ranked.slice(), backpressure: true };
  }
  return { file: ranked.slice(0, IMPROVE_MAX), backlog: ranked.slice(IMPROVE_MAX), backpressure: false };
}

// buildImproveIssueBody(c, {hypothesisBlock}): 起票 issue body markdown を生成する。
// c.target_paths が IMPROVE_CORE_PREFIXES に触れる場合は canary AC（自己改変 floor）を自動追記。
function buildImproveIssueBody(c, { hypothesisBlock }) {
  const lines = [];
  lines.push('## 背景');
  lines.push('');
  lines.push(`dev-improve サイクル（source: ${c.source}）が telemetry / PR シグナルから起票した自己改善 issue。`);
  if (typeof c.body_notes === 'string' && c.body_notes.trim()) {
    lines.push('');
    lines.push(c.body_notes.trim());
  }
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  for (const e of c.evidence) lines.push(`- ${e}`);
  lines.push('');
  lines.push('## 受入条件');
  lines.push('');
  for (const a of c.acceptance_criteria) lines.push(`- [ ] ${a}`);
  const touchesCore = c.source === 'reconcile-revert'
    || (Array.isArray(c.target_paths)
      && c.target_paths.some((p) => IMPROVE_CORE_PREFIXES.some((pre) => String(p).startsWith(pre))));
  if (touchesCore) {
    lines.push('- [ ] PR 作成後に /dev-flow-canary を実行し、read-only capability canary が green であること（自己改変 floor）');
  }
  lines.push('');
  lines.push('## 効果検証仮説（dev-improve managed — 手動編集禁止）');
  lines.push('');
  lines.push(hypothesisBlock);
  lines.push('');
  lines.push('---');
  lines.push('*この issue は dev-improve（自己改善ループ）により自動起票されました。*');
  return lines.join('\n');
}

// buildBacklogSection({today, losers}): backlog issue へ追記する markdown セクション。
function buildBacklogSection({ today, losers }) {
  const lines = [];
  lines.push(`### cycle ${today}`);
  lines.push('');
  for (const c of losers) {
    lines.push(`- [${c.source}] ${c.title}（risk: ${c.risk} / metric: ${c.expected_metric_delta.metric}）`);
  }
  return lines.join('\n');
}
// ==== END inline: _lib/improve-rank.mjs ====

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

// ---- args 正規化（workflow は Date 系 API 禁止 — 現在時刻は起動側から受け取る）----
const TODAY = (() => {
  const raw = (typeof args === 'string') ? args : args?.today
  const s = String(raw ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s)) {
    throw new Error(`dev-improve: args.today に ISO8601 UTC timestamp が必要です（受信: ${JSON.stringify(s)}）`)
  }
  return s
})()

const METRIC_NAMES = improveMetricNames()

// ---- schemas ----
const ISSUE_LIST = {
  type: 'object',
  required: ['ok', 'issues'],
  properties: {
    ok: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['number', 'title'],
        properties: {
          number: { type: 'number' },
          title: { type: 'string' },
          body: { type: 'string' },
          closedAt: { type: 'string' },
          stateReason: { type: 'string' },
        },
      },
    },
  },
}

const HYP_CHECK = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    metric: { type: 'string' },
    value: { type: 'number' },
    runs: { type: 'number' },
    verdict: { type: 'string', enum: ['confirmed', 'not_confirmed', 'insufficient_data'] },
  },
}

const CANDIDATES = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source', 'title', 'evidence', 'acceptance_criteria', 'expected_metric_delta', 'risk'],
        properties: {
          source: { type: 'string', enum: ['doctor-anomaly', 'failure-rca', 'sunset', 'pr-signal'] },
          title: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          acceptance_criteria: { type: 'array', items: { type: 'string' } },
          body_notes: { type: 'string' },
          target_paths: { type: 'array', items: { type: 'string' } },
          expected_metric_delta: {
            type: 'object',
            required: ['metric', 'current', 'target', 'min_runs'],
            properties: {
              metric: { type: 'string', enum: METRIC_NAMES },
              current: { type: 'number' },
              target: { type: 'number' },
              min_runs: { type: 'number' },
            },
          },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
    },
  },
}

const RANKING = {
  type: 'object',
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'score'],
        properties: {
          index: { type: 'number' },
          score: { type: 'number' },
          duplicate_of_existing: { type: 'boolean' },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

const ISSUE_CREATED = {
  type: 'object',
  required: ['created'],
  properties: {
    created: { type: 'boolean' },
    number: { type: 'number' },
    url: { type: 'string' },
  },
}

// ============================================================================
// Phase 1: Reconcile — 前サイクル仮説の実測突合（fail-open: 突合不能は skip + log）
// ============================================================================
phase('Reconcile')

const reconcile = { checked: 0, confirmed: 0, not_confirmed: 0, insufficient: 0, unavailable: 0 }
const revertCandidates = []

const closedList = await agent(
  `## Objective\nlabel self-improve の closed issue 一覧を取得する（dev-improve Reconcile 用）。\n\n`
  + `## Instructions\n次のコマンドをそのまま実行し、stdout の JSON 配列を issues に入れて返せ:\n`
  + `\`gh issue list --label self-improve --state closed --limit 20 --json number,title,body,closedAt,stateReason\`\n`
  + `コマンド失敗時（label 不存在含む）は throw せず ok:false, issues:[] を返すこと。\n`
  + `\n## Output format\n{ "ok": boolean, "issues": [{number, title, body, closedAt, stateReason}] }\n`
  + `\n## Tools\n使用可: Bash のみ\n\n## Boundary\n読み取り専用。ファイル変更・git 操作禁止。\n\n## Token cap\nJSON のみ返す。`,
  { agentType: 'dev-runner-haiku-ro', schema: ISSUE_LIST, label: 'list-closed', phase: 'Reconcile' },
)

const pendingIssues = []
for (const it of (closedList?.ok ? closedList.issues : [])) {
  if (it.stateReason && it.stateReason !== 'COMPLETED') {
    log(`Reconcile: issue #${it.number} は ${it.stateReason} で close — 突合対象外（実装されていない）`)
    continue
  }
  try {
    const hyp = parseHypothesisBlock(it.body ?? '')
    if (hyp && hyp.status === 'pending') pendingIssues.push({ ...it, hyp })
  } catch (e) {
    reconcile.unavailable++
    log(`⚠️ Reconcile: issue #${it.number} の hypothesis parse 失敗 — skip（${e.message}）`)
  }
}
log(`Reconcile: pending 仮説 ${pendingIssues.length} 件`)

for (const it of pendingIssues) {
  const since = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(it.closedAt ?? '')) ? it.closedAt : null
  if (!since) {
    reconcile.unavailable++
    log(`⚠️ Reconcile: issue #${it.number} closedAt 不正 — skip`)
    continue
  }
  reconcile.checked++
  const check = await agent(
    `## Objective\nissue #${it.number} の改善仮説を telemetry 実測と突合する。\n\n`
    + `## Instructions\nインストール済み skills の**固定パス**で次のコマンドをそのまま実行し、stdout JSON をそのまま返せ:\n`
    + `\`bash ~/.claude/skills/dev-flow-improve/scripts/hypothesis-check.sh --metric ${it.hyp.metric} --since ${since} --target ${it.hyp.target} --min-runs ${it.hyp.min_runs}\`\n`
    + `必ずリテラルの \`~/.claude/skills/...\` 絶対パス形で起動せよ（worktree 相対パス禁止）。\n`
    + `コマンド失敗時は throw せず ok:false を返すこと。\n`
    + `\n## Output format\n{ "ok": boolean, "metric": string, "value": number, "runs": number, "verdict": "confirmed"|"not_confirmed"|"insufficient_data" }\n`
    + `\n## Tools\n使用可: Bash, Read\n\n## Boundary\n読み取り専用。ファイル変更・git 操作禁止。\n\n## Token cap\nJSON のみ。`,
    { agentType: 'dev-runner-haiku-ro', schema: HYP_CHECK, label: `hyp-check#${it.number}`, phase: 'Reconcile' },
  )
  if (!check?.ok || !check.verdict) {
    reconcile.unavailable++
    log(`⚠️ Reconcile: issue #${it.number} 突合不能（fail-open）— skip`)
    continue
  }
  if (check.verdict === 'insufficient_data') {
    reconcile.insufficient++
    log(`Reconcile: #${it.number} データ不足（runs=${check.runs}）— 次サイクル持越し`)
    continue
  }

  const newStatus = check.verdict === 'confirmed' ? 'confirmed' : 'not_confirmed'
  let newBody
  try {
    newBody = setHypothesisStatus(it.body, newStatus)
  } catch (e) {
    reconcile.unavailable++
    log(`⚠️ Reconcile: #${it.number} status 更新失敗 — skip（${e.message}）`)
    continue
  }
  reconcile[newStatus]++

  const editRes = await agent(
    `## Objective\nissue #${it.number} の body を hypothesis status=${newStatus} に更新する。\n\n`
    + bodySaveInstr(newBody, 'dev-improve-body', 'DEV_IMPROVE')
    + `## Instructions\n保存した <BODY_FILE> で次を実行: \`gh issue edit ${it.number} --body-file <BODY_FILE>\`\n`
    + `成功時 posted:true。失敗時も throw せず posted:false。\n`
    + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Write\n\n## Boundary\n<BODY_FILE> 以外のファイル変更禁止。git commit 禁止。\n\n## Token cap\n100 語以内。`,
    { agentType: 'dev-runner', schema: POST_RESULT, label: `hyp-update#${it.number}`, phase: 'Reconcile' },
  )
  if (!editRes?.posted) log(`⚠️ Reconcile: #${it.number} body 更新の投稿に失敗（fail-open）`)

  const resultNote = [
    `## dev-improve 仮説突合結果（cycle ${TODAY}）`,
    '',
    `- verdict: **${check.verdict}**`,
    `- metric: \`${it.hyp.metric}\` — 実測 ${check.value}（target: ${it.hyp.target} / 観測 runs: ${check.runs} / since: ${since}）`,
    check.verdict === 'not_confirmed'
      ? '- 効果未確認のため revert / 再設計候補として次サイクルの候補プールに登録（自動 revert はしない — 判断は人間）'
      : '- 期待どおりの telemetry 変化を確認',
  ].join('\n')
  const noteRes = await agent(
    `## Objective\nissue #${it.number} に仮説突合結果コメントを投稿する。\n\n`
    + bodySaveInstr(resultNote, 'dev-improve-note', 'DEV_IMPROVE')
    + `## Instructions\n保存した <BODY_FILE> で次を実行: \`gh issue comment ${it.number} --body-file <BODY_FILE>\`\n`
    + `成功時 posted:true。失敗時も throw せず posted:false。\n`
    + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Write\n\n## Boundary\n<BODY_FILE> 以外のファイル変更禁止。git commit 禁止。\n\n## Token cap\n100 語以内。`,
    { agentType: 'dev-runner', schema: POST_RESULT, label: `hyp-note#${it.number}`, phase: 'Reconcile' },
  )
  if (!noteRes?.posted) log(`⚠️ Reconcile: #${it.number} 突合コメントの投稿に失敗（fail-open）`)

  if (check.verdict === 'not_confirmed') {
    revertCandidates.push({
      source: 'reconcile-revert',
      title: `効果未確認: issue #${it.number}「${it.title}」の改善の revert / 再設計を検討`,
      evidence: [
        `hypothesis 突合: metric=${it.hyp.metric} 実測 ${check.value} が target ${it.hyp.target} に未達（runs=${check.runs}, since=${since}）`,
      ],
      acceptance_criteria: [
        `issue #${it.number} の変更を revert するか、効かなかった原因を特定して再設計するかを判断し実施する`,
        '判断根拠を issue コメントに記録する',
      ],
      expected_metric_delta: {
        metric: it.hyp.metric, current: check.value, target: it.hyp.target, min_runs: it.hyp.min_runs,
      },
      risk: 'medium',
      target_paths: [],
    })
  }
}

// ============================================================================
// Phase 2: Mine — 4 ソース並列マイニング（barrier: Rank は全 miner の結果を要する）
// ============================================================================
phase('Mine')

const MINER_COMMON = `\n## Output format（共通 candidate schema）\n`
  + `candidates 配列で返す（最大 3 件、ゼロ件可）。各要素:\n`
  + `{source, title, evidence[], acceptance_criteria[], body_notes?, target_paths?, expected_metric_delta{metric,current,target,min_runs}, risk}\n`
  + `- evidence: journal entry id / PR 番号 / anomaly type と実測値への具体的参照（非空文字列の配列）。**根拠を示せない候補は返すな**（evidence 空は決定論で棄却される）。\n`
  + `- expected_metric_delta.metric は次の enum から選ぶ: ${METRIC_NAMES.join(' / ')}。**current は必ず突合 oracle 自身で実測せよ**: \`bash ~/.claude/skills/dev-flow-improve/scripts/hypothesis-check.sh --metric <metric> --since <30日前のISO UTC> --target 0 --min-runs 1\` を実行し、その value を current に使う（doctor の集計値は分母定義が異なるため current に使わない）。target は改善後の期待値、min_runs は突合に必要な最小 run 数（3〜10 程度）。\n`
  + `- acceptance_criteria: 実装 PR の受入条件（検証可能な形で 2〜5 件）。\n`
  + `- target_paths: 変更が想定されるファイル/ディレクトリの repo 相対 path。\n`
  + `- risk: low / medium / high。\n`
  + `\n## Tools\n使用可: Bash（読み取りコマンドのみ）, Read, Grep, Glob\n`
  + `\n## Boundary\n読み取り専用 — ファイル変更・git mutation・issue/PR 作成は禁止。repo root は現在の working directory。\n`
  + `\n## Token cap\n出力は JSON のみ。3000 語以内。`

const MINERS = [
  {
    key: 'doctor-anomaly',
    prompt: `## Objective\ndev-flow-doctor の telemetry 分布・anomaly から dev-flow の改善候補を掘る（source: "doctor-anomaly"）。\n\n`
      + `## Instructions\n1. \`bash ~/.claude/skills/dev-flow-doctor/scripts/analyze-dev-flow-telemetry.sh --window 30d\` を実行し JSON を得る（必ずこのリテラル固定パス形で起動）。\n`
      + `2. anomalies（cap_pinned / iterate_unhealthy / micro_nonfiring）と distributions の歪みを読み、dev-flow の仕組み側の改善候補に翻訳する。\n`
      + `3. 各候補の evidence に anomaly type と実測数値を引用する。`
      + MINER_COMMON,
  },
  {
    key: 'failure-rca',
    prompt: `## Objective\n失敗・不完走 run の個別 RCA から改善候補を掘る（source: "failure-rca"）。\n\n`
      + `## Instructions\n1. journal（環境変数 CLAUDE_JOURNAL_DIR、無ければ ~/.claude/journal の *.json）から skill が dev-flow / pr-iterate の entry を読み、timestamp が ${TODAY} から遡って 30 日以内で、iterate_status が lgtm 以外・outcome が failure/partial・final_reconcile/final_ac_reconcile が unavailable・ui_verify が setup_failed のいずれかに該当する run を列挙する（jq 推奨）。\n`
      + `2. 頻出パターン（同じ終端理由・同じ error_category）を特定し、根本原因の仮説と dev-flow/pr-iterate の仕組み側の修正候補に翻訳する。\n`
      + `3. evidence には該当 entry の id / timestamp / フィールド値を引用する。`
      + MINER_COMMON,
  },
  {
    key: 'sunset',
    prompt: `## Objective\nW7 capability-bound distrust 機構の sunset（昇格・撤去）候補を検出する（source: "sunset"）。\n\n`
      + `## Instructions\n1. repo root の AGENTS.md の「distrust 機構の正当化クラス (W7)」節を読み、capability-bound の sunset path（gate_policy / ui-verify advisory / exec-proxy 橋 / sync-inlines 橋）の再評価トリガ条件を確認する。\n`
      + `2. 各トリガ条件が現在満たせる見込みかを、ローカル情報（journal telemetry の蓄積量と分布・\`git log --oneline -20\`）から判定する。トリガ充足の見込みがある機構だけを候補化する。\n`
      + `3. 昇格・撤去は必ず issue → 人間 merge 経由 — acceptance_criteria に再評価の実証手順（calibration 突合等）を含めること。\n`
      + `4. evidence には該当する AGENTS.md の記述と、トリガ充足を示す実測値を引用する。`
      + MINER_COMMON,
  },
  {
    key: 'pr-signal',
    prompt: `## Objective\nPR 由来シグナル（findings 再発・merge tier 推奨と人間判断の乖離）から改善候補を掘る（source: "pr-signal"）。\n\n`
      + `## Instructions\n1. journal（CLAUDE_JOURNAL_DIR 優先、無ければ ~/.claude/journal の *.json）から timestamp が ${TODAY} から遡って 30 日以内の dev-flow / pr-iterate entry の pr_number・repo・telemetry.merge_tier を集める。\n`
      + `2. pr_number があるものについて \`gh pr view <n> --json state,mergedAt,closedAt,url\` で人間の実判断を取得し、merge_tier 推奨との乖離（HOLD なのに即 merge / AUTO 推奨なのに reject 等）を探す。\n`
      + `3. \`gh pr list --state merged --limit 10 --json number,title\` と \`gh pr view <n> --comments\` で pr-iterate の自動レビューコメント（「pr-iterate により自動生成」）を読み、複数 PR で再発している findings パターンを探す。\n`
      + `4. 乖離・再発パターンを dev-flow / pr-iterate の仕組み改善候補に翻訳する。evidence には PR 番号と具体値を引用する。`
      + MINER_COMMON,
  },
]

const minerResults = await parallel(MINERS.map((m) => () =>
  agent(m.prompt, { agentType: 'improve-miner', schema: CANDIDATES, label: `mine:${m.key}`, phase: 'Mine' })
))
const mined = minerResults.filter(Boolean).flatMap((r) => r.candidates)
if (minerResults.some((r) => r == null)) log('⚠️ Mine: 一部 miner が結果を返さず（fail-open）— 残りのソースで続行')

const pool = [...revertCandidates, ...mined]
const candidates = pool.filter((c) => validateCandidate(c, METRIC_NAMES))
if (candidates.length < pool.length) {
  log(`Mine: 決定論バリデーションで ${pool.length - candidates.length} 件棄却（evidence/AC 欠落・out-of-enum）`)
}
log(`Mine: 有効候補 ${candidates.length} 件（revert 候補 ${revertCandidates.length} 件含む）`)

// ============================================================================
// Phase 3: Rank — dedup + judge スコアリング + 決定論 cut
// ============================================================================
phase('Rank')

const openList = await agent(
  `## Objective\nlabel self-improve の open issue 一覧を取得する（dedup と backpressure 判定用）。\n\n`
  + `## Instructions\n次のコマンドをそのまま実行し、stdout の JSON 配列を issues に入れて返せ:\n`
  + `\`gh issue list --label self-improve --state open --limit 50 --json number,title\`\n`
  + `コマンド失敗時は throw せず ok:false, issues:[] を返すこと。\n`
  + `\n## Output format\n{ "ok": boolean, "issues": [{number, title}] }\n`
  + `\n## Tools\n使用可: Bash のみ\n\n## Boundary\n読み取り専用。\n\n## Token cap\nJSON のみ。`,
  { agentType: 'dev-runner-haiku-ro', schema: ISSUE_LIST, label: 'list-open', phase: 'Rank' },
)
// fail-closed: open 数不明のまま issue 化しない（backpressure は人間の merge ペースに同期する
// incentive-structural cap — 取得失敗で緩めない）
const openCount = openList?.ok ? openList.issues.length : Infinity
if (!openList?.ok) log('⚠️ Rank: open issue 取得失敗 — fail-closed（今回サイクルの issue 化を skip し全候補を backlog へ）')

const backlogList = await agent(
  `## Objective\ndev-improve backlog issue（label self-improve-backlog）を取得する。\n\n`
  + `## Instructions\n次のコマンドをそのまま実行し、stdout の JSON 配列を issues に入れて返せ:\n`
  + `\`gh issue list --label self-improve-backlog --state open --limit 1 --json number,title,body\`\n`
  + `コマンド失敗時は throw せず ok:false, issues:[] を返すこと。\n`
  + `\n## Output format\n{ "ok": boolean, "issues": [{number, title, body}] }\n`
  + `\n## Tools\n使用可: Bash のみ\n\n## Boundary\n読み取り専用。\n\n## Token cap\nJSON のみ。`,
  { agentType: 'dev-runner-haiku-ro', schema: ISSUE_LIST, label: 'list-backlog', phase: 'Rank' },
)
const backlogIssue = (backlogList?.ok && backlogList.issues.length > 0) ? backlogList.issues[0] : null

// 決定論 dedup prefilter: 既存 open issue と title fingerprint が一致する候補は落とす
const existingKeys = new Set((openList?.ok ? openList.issues : []).map((x) => candidateKey(x)))
const fresh = candidates.filter((c) => {
  if (existingKeys.has(candidateKey(c))) {
    log(`Rank: dedup 落選（既存 open issue と同一 fingerprint）: ${c.title}`)
    return false
  }
  return true
})

let ranked = []
if (fresh.length > 0) {
  const judge = await agent(
    `## Objective\ndev-improve の改善候補に優先度スコアを付け、既存 open issue との実質重複を検出する。\n\n`
    + `## Input\n候補（index 付き）:\n${JSON.stringify(fresh.map((c, i) => ({ index: i, source: c.source, title: c.title, evidence: c.evidence, expected_metric_delta: c.expected_metric_delta, risk: c.risk })))}\n\n`
    + `既存 open issue タイトル:\n${JSON.stringify((openList?.ok ? openList.issues : []).map((x) => x.title))}\n\n`
    + `## Instructions\n各候補に score（0-100）を付けよ。基準: evidence の定量性（実測値引用の有無）× 期待効果の大きさ × リスクの低さ。`
    + `既存 open issue と実質同一の候補は duplicate_of_existing: true にせよ（score も返す）。全候補に同点を付けない。\n`
    + `\n## Output format\n{ "scores": [{ "index": number, "score": number, "duplicate_of_existing": boolean, "rationale": string }] }\n`
    + `\n## Tools\n使用可: Read, Grep, Glob, Bash（読み取りのみ）\n\n## Boundary\n読み取り専用。\n\n## Token cap\nrationale は各 30 語以内。`,
    { agentType: 'improve-miner', model: QUALITY_MODEL, schema: RANKING, label: 'rank-judge', phase: 'Rank' },
  )
  // judge は gate ではない（絞り込みのみ）— null でも決定論 tie-break で続行（fail-open）
  if (judge == null) log('⚠️ Rank: rank-judge が結果を返さず — score 0 扱いで決定論 tie-break のみで続行')
  const dupIdx = new Set((judge?.scores ?? []).filter((s) => s.duplicate_of_existing === true).map((s) => s.index))
  const dupKeys = new Set(fresh.filter((_, i) => dupIdx.has(i)).map((c) => candidateKey(c)))
  ranked = rankCandidates(fresh, judge?.scores).filter((c) => !dupKeys.has(candidateKey(c)))
  if (dupKeys.size > 0) log(`Rank: judge が実質重複 ${dupKeys.size} 件を検出 — 除外`)
}

const { file: winners, backlog: losers, backpressure } = selectTop(ranked, openCount)
log(`Rank: 通過 ${winners.length} 件 / backlog ${losers.length} 件 / backpressure=${backpressure}（open=${openList?.ok ? openCount : 'unknown'}）`)

// ============================================================================
// Phase 4: File — issue 作成 + backlog 追記 + telemetry
// ============================================================================
phase('File')

const filed = []
for (const c of winners) {
  const hypBlock = buildHypothesisBlock(c.expected_metric_delta)
  const body = buildImproveIssueBody(c, { hypothesisBlock: hypBlock })
  const created = await agent(
    `## Objective\ndev-improve の自己改善 issue を 1 件作成する。\n\n`
    + bodySaveInstr(body, 'dev-improve-issue', 'DEV_IMPROVE')
    + `## Instructions\n`
    + `1. \`gh label create self-improve --color 1D76DB --description "dev-improve self-improvement" --force\` を実行（既存でも成功する）。\n`
    + `2. 保存した <BODY_FILE> で issue を作成: \`gh issue create --title <TITLE> --label self-improve --body-file <BODY_FILE>\`\n`
    + `   <TITLE> は次のタイトルを一字一句そのまま、shell 安全にクォートして渡す: ${JSON.stringify(c.title)}\n`
    + `3. 出力 URL 末尾の issue 番号を number に入れ created:true を返す。失敗時は throw せず created:false。\n`
    + `\n## Output format\n{ "created": boolean, "number": number, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Write\n\n## Boundary\n<BODY_FILE> 以外のファイル変更禁止。git commit 禁止。issue 作成は 1 件のみ。\n\n## Token cap\n100 語以内。`,
    { agentType: 'dev-runner', schema: ISSUE_CREATED, label: `file-issue#${filed.length + 1}`, phase: 'File' },
  )
  if (created?.created && Number.isInteger(created.number)) {
    filed.push(created.number)
    log(`File: issue #${created.number} 起票 — ${c.title}`)
  } else {
    log(`⚠️ File: issue 作成失敗（fail-open）— ${c.title}`)
  }
}

// backlog 追記（dedup: 既に backlog body に同一タイトルがあれば追記しない）
let backlogAdded = 0
if (losers.length > 0) {
  const backlogBody = String(backlogIssue?.body ?? '')
  const newLosers = losers.filter((c) => !backlogBody.includes(c.title))
  if (newLosers.length > 0) {
    const section = buildBacklogSection({ today: TODAY, losers: newLosers })
    const newBody = backlogBody
      ? `${backlogBody}\n\n${section}`
      : `dev-improve の落選候補 backlog。再浮上は telemetry シグナル駆動（miner が再発見する）。\n\n${section}`
    const res = await agent(
      `## Objective\ndev-improve backlog issue を更新（なければ作成）する。\n\n`
      + bodySaveInstr(newBody, 'dev-improve-backlog', 'DEV_IMPROVE')
      + `## Instructions\n`
      + (backlogIssue
        ? `保存した <BODY_FILE> で次を実行: \`gh issue edit ${backlogIssue.number} --body-file <BODY_FILE>\`\n`
        : `1. \`gh label create self-improve-backlog --color C5DEF5 --description "dev-improve backlog" --force\`\n`
          + `2. \`gh issue create --title "dev-improve backlog" --label self-improve-backlog --body-file <BODY_FILE>\`\n`)
      + `成功時 created:true と issue 番号を返す。失敗時は throw せず created:false。\n`
      + `\n## Output format\n{ "created": boolean, "number": number, "url": string }\n`
      + `\n## Tools\n使用可: Bash, Write\n\n## Boundary\n<BODY_FILE> 以外のファイル変更禁止。git commit 禁止。\n\n## Token cap\n100 語以内。`,
      { agentType: 'dev-runner', schema: ISSUE_CREATED, label: 'backlog-append', phase: 'File' },
    )
    if (res?.created) backlogAdded = newLosers.length
    else log('⚠️ File: backlog 更新失敗（fail-open）')
  }
}

// improve-cycle telemetry（journal.sh 直接呼び出し — 値は数値/boolean のみで quoting 安全）
const improveTelemetry = JSON.stringify({
  candidates_found: candidates.length,
  issues_filed: filed.length,
  hypotheses_confirmed: reconcile.confirmed,
  hypotheses_not_confirmed: reconcile.not_confirmed,
  hypotheses_insufficient: reconcile.insufficient,
  hypotheses_unavailable: reconcile.unavailable,
  backlog_added: backlogAdded,
  backpressure_skipped: backpressure,
})
const journalRes = await agent(
  `## Objective\ndev-improve サイクルの telemetry を journal に記録する。\n\n`
  + `## Instructions\n次のコマンドをそのまま実行せよ（リテラル固定パス形）:\n`
  + `\`bash ~/.claude/skills/skill-retrospective/scripts/journal.sh log dev-improve success --telemetry-json '${improveTelemetry}'\`\n`
  + `exit 0 なら logged:true、失敗しても throw せず logged:false を返すこと。\n`
  + `\n## Output format\n{ "logged": boolean, "summary": string }\n`
  + `\n## Tools\n使用可: Bash, Read, Skill\n\n## Boundary\n~/.claude/journal 以外のファイル変更禁止。git 操作禁止。\n\n## Token cap\n50 語以内。`,
  { agentType: 'dev-runner-haiku', schema: JOURNAL_RESULT, label: 'journal-log', phase: 'File' },
)
if (!journalRes?.logged) log('⚠️ journal-log 失敗（fail-open）— telemetry 記録漏れの可能性')

log(`dev-improve 完了: issue化 ${filed.length} 件 / backlog ${backlogAdded} 件 / backpressure=${backpressure}`)

return {
  issues_filed: filed,
  candidates_found: candidates.length,
  reconcile,
  backlog_added: backlogAdded,
  backpressure_skipped: backpressure,
}
