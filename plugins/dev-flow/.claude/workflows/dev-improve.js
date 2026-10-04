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
const QUALITY_MODEL = 'fable'
// ==== END inline: _lib/quality-model.mjs ====
// ==== BEGIN inline: _lib/agent-namespace.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====
const AGENT_NAMESPACE = 'dev-flow:'

function nsAgentOpts(opts) {
  const bare = opts == null ? undefined : opts.agentType
  if (typeof bare !== 'string' || bare.trim() === '') {
    throw new Error('nsAgentOpts: opts.agentType が必要（受信: ' + JSON.stringify(bare) + '）')
  }
  if (bare.indexOf(':') !== -1) {
    throw new Error(
      'nsAgentOpts: agentType は bare な論理名で渡す（namespace はここで付与する。受信: '
      + JSON.stringify(bare) + '）',
    )
  }
  return { ...opts, agentType: AGENT_NAMESPACE + bare }
}
// ==== END inline: _lib/agent-namespace.mjs ====

// ==== BEGIN inline: _lib/improve-hypothesis.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====

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

const IMPROVE_MAX = 2;
const IMPROVE_BACKPRESSURE_OPEN = 2;
const IMPROVE_SOURCES = Object.freeze([
  'doctor-anomaly', 'failure-rca', 'sunset', 'pr-signal', 'reconcile-revert',
]);
const IMPROVE_RISKS = Object.freeze(['low', 'medium', 'high']);
const IMPROVE_CORE_PREFIXES = Object.freeze([
  'plugins/dev-flow/.claude/workflows/', 'plugins/dev-flow/_lib/',
  'plugins/dev-flow/agents/', 'plugins/dev-flow/.claude/agents/', 'tools/',
]);

function candidateKey(c) {
  return String(c?.title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

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

function selectTop(ranked, openImproveCount) {
  if (Number(openImproveCount) >= IMPROVE_BACKPRESSURE_OPEN) {
    return { file: [], backlog: ranked.slice(), backpressure: true };
  }
  return { file: ranked.slice(0, IMPROVE_MAX), backlog: ranked.slice(IMPROVE_MAX), backpressure: false };
}

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
  lines.push('## 受け入れ条件');
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

function bodySaveInstr(body, { bodyFile, saveDir, fileName }, delimName) {
  const resolve = bodyFile
    ? `保存先は固定パス \`${bodyFile}\` とし、以降 <BODY_FILE> はこのパスを指す。\n`
    : `まず Bash で \`printf '%s\\n' "${saveDir}/${fileName}"\` を 1 回だけ実行し、出力された絶対パスを <BODY_FILE> とする。\n`
  return `## 本文の保存\n`
    + resolve
    + `<BODY_FILE> は Bash で事前に作らない（空ファイルの作成も禁止）。**Write tool** で新規作成する。\n`
    + `<BODY_FILE> が既に存在する場合（前回の残り）のみ、先に **Read tool** で読んでから Write tool で上書きせよ。\n`
    + `**Write tool** を使い、下記 delimiter 内の本文を\n`
    + `**一字一句そのまま** <BODY_FILE> へ書き出せ。本文は絶対に shell（echo/printf/heredoc 等）へ\n`
    + `渡さず、必ず Write tool の content 引数として渡すこと。backtick やコードフェンスを\n`
    + `エスケープ・改変しないこと。以降のコマンドの \`--body-file\` には <BODY_FILE> を指定する。\n`
    + `<<<${delimName}_BODY_BEGIN>>>\n${body}\n<<<${delimName}_BODY_END>>>\n\n`
}

function ghBareStepInstr(cmd) {
  return `\`${cmd}\` を先頭トークンが gh の bare 単文で 1 回だけ実行せよ`
    + `（cd 前置・bash 前置・環境変数代入前置・&& 連結・パイプ・リダイレクト禁止）。\n`
}
// ==== END inline: _lib/workflow-post-helpers.mjs ====
// ==== BEGIN inline: _lib/journal-handoff.mjs (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====

const JOURNAL_PENDING_DIR = '~/.claude/journal/pending';

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
  error_phase,
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
  if (error_phase) payload.error_phase = String(error_phase);
  return JSON.stringify(payload);
}

function fnv1a32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ (c >>> 8), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function journalEffectId(payload) {
  const s = String(payload ?? '');
  const lo = fnv1a32(s, 0x811c9dc5);
  const hi = fnv1a32(s, 0x811c9dc5 ^ 0x9e3779b9);
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

function buildJournalPendingPath({ prefix, id, effectId }) {
  const safePrefix = String(prefix ?? '').trim();
  const safeId = String(id ?? '').trim();
  if (!/^[a-z][a-z0-9-]*$/.test(safePrefix)) {
    throw new Error(`journal-handoff: invalid prefix: ${JSON.stringify(prefix)}`);
  }
  if (!/^[1-9][0-9]*$/.test(safeId)) {
    throw new Error(`journal-handoff: invalid id: ${JSON.stringify(id)}`);
  }
  if (!/^[0-9a-f]{16}$/.test(String(effectId ?? ''))) {
    throw new Error(`journal-handoff: invalid effectId: ${JSON.stringify(effectId ?? null)}`);
  }
  return `${JOURNAL_PENDING_DIR}/${safePrefix}-${safeId}-effect-${effectId}.json`;
}

const JOURNAL_LOG_STATUSES = ['logged', 'save_failed', 'log_failed'];

function classifyJournalLogStatus({ saved, logged }) {
  if (saved !== true) return 'save_failed';
  if (logged === true) return 'logged';
  return 'log_failed';
}

const JOURNAL_PAYLOAD_BASENAME_RE = /^payload-[A-Za-z0-9._-]+\.json$/;

function buildJournalSaveInstr({ payload, savePath, saveDir, fileName }) {
  if (payload == null) throw new Error('journal-handoff: payload is required');
  if (savePath != null && saveDir != null) {
    throw new Error('journal-handoff: savePath と saveDir は同時に指定できません');
  }

  const bodyBlock = `<<<JOURNAL_HANDOFF_BODY_BEGIN>>>\n${payload}\n<<<JOURNAL_HANDOFF_BODY_END>>>\n\n`;
  const verbatimRule = `本文は絶対に shell（echo/printf/heredoc 等）へ渡さず、必ず Write tool の\n`
    + `content 引数として渡すこと。エスケープ・改変・pretty-print も禁止する。\n`;
  const idempotentReadRule = (target) => `${target} が既に存在する場合は、先に **Read tool** で同ファイルを`
    + `読んでから **Write tool** で上書きせよ（Write tool は既存ファイルを未 Read のまま上書きできない）。`
    + `Read が失敗しても Write は必ず試み、Read の成否を saved の判定に混ぜないこと。\n`;

  if (savePath != null) {
    if (!validateJournalSavedPath(savePath)) {
      throw new Error(`journal-handoff: invalid savePath: ${JSON.stringify(savePath)}`);
    }
    return `## Journal handoff payload の保存\n`
      + `1. ${idempotentReadRule(`\`${savePath}\``)}`
      + `2. **Write tool** を使い、下記 delimiter 内の JSON を **一字一句そのまま**\n`
      + `\`${savePath}\` へ書き出せ。${verbatimRule}`
      + `Bash は使うな。保存先は上記のパスで固定されており、一時ファイル名を作る必要はない。\n`
      + bodyBlock
      + `3. 書き出しに成功したら {saved:true, path:"${savePath}"} を返せ。\n`
      + `失敗した場合は throw せず {saved:false} を返せ。\n`;
  }

  if (!saveDir) throw new Error('journal-handoff: savePath か saveDir のどちらかが必要です');
  if (!JOURNAL_PAYLOAD_BASENAME_RE.test(String(fileName ?? ''))) {
    throw new Error(`journal-handoff: invalid fileName: ${JSON.stringify(fileName ?? null)}`);
  }
  const resolveCmd = `mkdir -p "${saveDir}" && printf '%s\\n' "${saveDir}/${fileName}"`;

  return `## Journal handoff payload の保存\n`
    + `1. まず Bash で \`${resolveCmd}\` を実行し、\n`
    + `出力された絶対パスを <PAYLOAD_FILE> とする。\n`
    + `2. ${idempotentReadRule('<PAYLOAD_FILE>')}`
    + `3. 次に **Write tool** を使い、下記 delimiter 内の JSON を\n`
    + `**一字一句そのまま** <PAYLOAD_FILE> へ書き出せ。${verbatimRule}`
    + bodyBlock
    + `4. 書き出しに成功したら {saved:true, path:<PAYLOAD_FILE の絶対パス>} を返せ。\n`
    + `失敗した場合は throw せず {saved:false} を返せ。\n`;
}

const JOURNAL_TILDE_PREFIX = '~/.claude/journal/';

function validateJournalSavedPath(path, { requiredDirSuffix } = {}) {
  if (typeof path !== 'string' || path === '') return false;
  const abs = path.startsWith(JOURNAL_TILDE_PREFIX) ? path.slice(1) : path;
  if (!abs.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._\/-]+$/.test(abs)) return false;
  if (abs.includes('..')) return false;

  const idx = abs.lastIndexOf('/');
  const dirPart = idx === 0 ? '/' : abs.slice(0, idx);
  const basePart = abs.slice(idx + 1);
  if (!JOURNAL_PAYLOAD_BASENAME_RE.test(basePart)) return false;
  if (requiredDirSuffix && !dirPart.endsWith(requiredDirSuffix)) return false;

  return true;
}

function buildJournalLogInstr({ prefix, id, payloadPath, payload }) {
  if (!validateJournalSavedPath(payloadPath)) {
    throw new Error(`journal-handoff: invalid payloadPath: ${JSON.stringify(payloadPath ?? null)}`);
  }
  if (typeof payload !== 'string' || payload === '') {
    throw new Error(`journal-handoff: payload is required for effect ID derivation`);
  }
  const pendingPath = buildJournalPendingPath({ prefix, id, effectId: journalEffectId(payload) });

  return `## Journal pending への書き出し\n`
    + `1. **Read tool** で \`${payloadPath}\` を読め。\n`
    + `2. 読み取った内容を **一字一句そのまま**、**Write tool** で \`${pendingPath}\` へ書け。\n`
    + `再整形・pretty-print・truncate は禁止する。**Bash は使うな** — 書き込みは Write tool のみで行う。\n`
    + `${pendingPath} が既に存在する場合は、先に **Read tool** で読んでから Write tool で上書きせよ\n`
    + `（Write tool は既存ファイルを未 Read のまま上書きできない）。\n`
    + `3. 書き込みに成功したら {logged:true} を返せ。どの手順で失敗しても throw せず {logged:false} を返せ。\n`;
}

async function runJournalHandoff({ agent: runAgent, log, saveSchema, logSchema, payload, savePath, prefix, id, subject, logLabel, phase }) {
  let journalLogStatus = 'save_failed'
  try {
    const journalSaveRes = await runAgent(
      `## Objective\n${subject}の telemetry handoff payload を一時ファイルへ保存する。\n\n`
      + `## Instructions\n`
      + buildJournalSaveInstr({ payload, savePath })
      + `\n## Output format\n{ "saved": boolean, "path": string }\n`
      + `\n## Tools\n使用可: Write, Read（保存先は指示で固定済み — Bash は不要。Read は既存 payload の\n`
      + `冪等上書きに必要）\n`
      + `\n## Boundary\n作成した一時ファイル以外のファイルを変更しない。git 操作禁止。\n`
      + `\n## Token cap\n120 語以内。`,
      { agentType: 'dev-runner-haiku', schema: saveSchema, label: 'journal-save', phase },
    )
    const journalSavedPath = journalSaveRes?.saved === true ? savePath : null
    if (journalSavedPath) {
      journalLogStatus = classifyJournalLogStatus({ saved: true, logged: false })
      const journalPost = await runAgent(
        `## Objective\n${subject}の telemetry handoff を ~/.claude/journal/pending/ に書き出す（Stop hook が journal へ flush する）。\n\n`
        + `## Instructions\n`
        + buildJournalLogInstr({ prefix, id, payloadPath: journalSavedPath, payload })
        + `\n## Output format\n{ "logged": boolean, "summary": string }\n`
        + `\n## Tools\n使用可: Read, Write のみ\n`
        + `\n## Boundary\n~/.claude/journal 以外のファイルを変更しない。git 操作禁止。\n`
        + `\n## Token cap\n100 語以内で完結すること。`,
        { agentType: 'dev-runner-haiku', schema: logSchema, label: logLabel, phase },
      )
      journalLogStatus = classifyJournalLogStatus({ saved: true, logged: journalPost?.logged === true })
      if (!journalPost?.logged) log(`⚠️ ${logLabel} の記録に失敗しました（logged=${journalPost?.logged ?? 'null'}）。ワークフローは継続します。`)
    } else {
      journalLogStatus = classifyJournalLogStatus({ saved: false })
      log('⚠️ journal-save 失敗（fail-open）— telemetry 記録漏れの可能性')
    }
  } catch (e) {
    log(`⚠️ journal handoff 失敗（fail-open）: ${e?.message ?? e}`)
  }
  return journalLogStatus
}

const ABORT_ERROR_CATEGORY = 'abort';
const ABORT_ERROR_MSG_MAX = 500;

function buildAbortErrorMsg({ phase, label, error }) {
  const raw = error && typeof error === 'object' && 'message' in error ? error.message : error;
  const msg = String(raw ?? 'unknown error').replace(/\s+/g, ' ').trim() || 'unknown error';
  return `abort@${phase || '?'}/${label || '?'}: ${msg}`.slice(0, ABORT_ERROR_MSG_MAX);
}

function buildAbortHandoffPayload({ skill, args, issue, repo, pr_number, journal_sh, phase, label, error, telemetry }) {
  return buildJournalHandoffPayload({
    skill,
    outcome: 'failure',
    args,
    issue,
    repo,
    pr_number,
    journal_sh,
    error_category: ABORT_ERROR_CATEGORY,
    error_msg: buildAbortErrorMsg({ phase, label, error }),
    error_phase: phase || undefined,
    telemetry: { ...(telemetry ?? {}), abort_phase: phase ?? null, abort_label: label ?? null },
  });
}

function repoFromGithubUrl(url) {
  const match = String(url ?? '').match(
    /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+)(?:[\/#?]|$)/,
  );
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
// ==== END inline: _lib/journal-handoff.mjs ====

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
          url: { type: 'string' },
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

// issue body / comment 本文の保存先ディレクトリ（bodySaveInstr の saveDir モード）。dev-improve は
// run 専用 worktree を持たないため `.devflow-tmp` ではなく journal-save と同じ TMPDIR 配下に置く。
const IMPROVE_BODY_DIR = '${TMPDIR:-/tmp}/dev-improve'

// journal-save（stage1）の返り値 schema。JOURNAL_RESULT（journal-log/stage2）と対で使う。
const JOURNAL_SAVE_RESULT = {
  type: 'object',
  required: ['saved'],
  properties: {
    saved: { type: 'boolean' },
    path: { type: 'string' },
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
  + `\`gh issue list --label self-improve --state closed --limit 20 --json number,title,body,closedAt,stateReason,url\`\n`
  + `コマンド失敗時（label 不存在含む）は throw せず ok:false, issues:[] を返すこと。\n`
  + `\n## Output format\n{ "ok": boolean, "issues": [{number, title, body, closedAt, stateReason, url}] }\n`
  + `\n## Tools\n使用可: Bash のみ\n\n## Boundary\n読み取り専用。ファイル変更・git 操作禁止。\n\n## Token cap\nJSON のみ返す。`,
  nsAgentOpts({ agentType: 'dev-runner-haiku-ro', schema: ISSUE_LIST, label: 'list-closed', phase: 'Reconcile' }),
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
    + `## Instructions\n次のコマンドを**この形のまま**（bare 名を先頭トークンとする単文で）実行し、stdout JSON をそのまま返せ:\n`
    + `\`hypothesis-check --metric ${it.hyp.metric} --since ${since} --target ${it.hyp.target} --min-runs ${it.hyp.min_runs}\`\n`
    + `cd 前置・bash 前置・パス付与をせずこの形のまま起動せよ（worktree 相対パス禁止）。\n`
    + `コマンド失敗時は throw せず ok:false を返すこと。\n`
    + `\n## Output format\n{ "ok": boolean, "metric": string, "value": number, "runs": number, "verdict": "confirmed"|"not_confirmed"|"insufficient_data" }\n`
    + `\n## Tools\n使用可: Bash, Read\n\n## Boundary\n読み取り専用。ファイル変更・git 操作禁止。\n\n## Token cap\nJSON のみ。`,
    nsAgentOpts({ agentType: 'dev-runner-haiku-ro', schema: HYP_CHECK, label: `hyp-check#${it.number}`, phase: 'Reconcile' }),
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
    + bodySaveInstr(newBody, { saveDir: IMPROVE_BODY_DIR, fileName: `dev-improve-body-${it.number}.md` }, 'DEV_IMPROVE')
    + `## Instructions\n保存した <BODY_FILE> で次を実行: \`gh issue edit ${it.number} --body-file <BODY_FILE>\`\n`
    + `成功時 posted:true。失敗時も throw せず posted:false。\n`
    + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Read, Write\n\n## Boundary\n<BODY_FILE> 以外のファイル変更禁止。git commit 禁止。\n\n## Token cap\n100 語以内。`,
    nsAgentOpts({ agentType: 'dev-runner', schema: POST_RESULT, label: `hyp-update#${it.number}`, phase: 'Reconcile' }),
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
  // --repo は list-closed が返した issue URL から解決する（dev-improve は repo を args で受け取らない）
  const noteRepo = repoFromGithubUrl(it.url)
  const noteRes = await agent(
    `## Objective\nissue #${it.number} に仮説突合結果コメントを投稿する。\n\n`
    + bodySaveInstr(resultNote, { saveDir: IMPROVE_BODY_DIR, fileName: `dev-improve-note-${it.number}.md` }, 'DEV_IMPROVE')
    + `## Instructions\n`
    + ghBareStepInstr(`gh issue comment ${it.number}${noteRepo ? ` --repo ${noteRepo}` : ''} --body-file <BODY_FILE>`)
    + `成功時 posted:true。失敗時も throw せず posted:false。原因調査・再試行・別の起動形での実行はしない。\n`
    + `\n## Output format\n{ "posted": boolean, "method": string, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Read, Write\n\n## Boundary\n<BODY_FILE> 以外のファイル変更禁止。git commit 禁止。\n\n## Token cap\n100 語以内。`,
    nsAgentOpts({ agentType: 'dev-runner', schema: POST_RESULT, label: `hyp-note#${it.number}`, phase: 'Reconcile' }),
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
  + `- expected_metric_delta.metric は次の enum から選ぶ: ${METRIC_NAMES.join(' / ')}。**current は必ず突合 oracle 自身で実測せよ**: \`hypothesis-check --metric <metric> --since <30日前のISO UTC> --target 0 --min-runs 1\` を実行し、その value を current に使う（doctor の集計値は分母定義が異なるため current に使わない）。target は改善後の期待値、min_runs は突合に必要な最小 run 数（3〜10 程度）。\n`
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
      + `## Instructions\n1. \`analyze-dev-flow-telemetry --window 30d\` を実行し JSON を得る（必ずこの形のまま起動）。\n`
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
  agent(m.prompt, nsAgentOpts({ agentType: 'improve-miner', schema: CANDIDATES, label: `mine:${m.key}`, phase: 'Mine' }))
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
  nsAgentOpts({ agentType: 'dev-runner-haiku-ro', schema: ISSUE_LIST, label: 'list-open', phase: 'Rank' }),
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
  nsAgentOpts({ agentType: 'dev-runner-haiku-ro', schema: ISSUE_LIST, label: 'list-backlog', phase: 'Rank' }),
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
    nsAgentOpts({ agentType: 'improve-miner', model: QUALITY_MODEL, schema: RANKING, label: 'rank-judge', phase: 'Rank' }),
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
    + bodySaveInstr(body, { saveDir: IMPROVE_BODY_DIR, fileName: `dev-improve-issue-${filed.length + 1}.md` }, 'DEV_IMPROVE')
    + `## Instructions\n`
    + `1. \`gh label create self-improve --color 1D76DB --description "dev-improve self-improvement" --force\` を実行（既存でも成功する）。\n`
    + `2. 保存した <BODY_FILE> に対し次を実行: \`ac-lint <BODY_FILE>\`（bare 名を先頭トークンとする単文）。\n`
    + `   exit code 3（stdout JSON の verdict が non_compliant）の場合は issue を作成せず、throw もせず created:false を返せ（lint の stdout JSON は url フィールドではなく応答テキストにも含めず created:false のみ返す）。\n`
    + `   exit 0（verdict が t1 または t2）なら次 step へ進め。lint スクリプト自体が実行不能（not found 等の exit 1 / コマンド失敗）の場合は fail-open — 警告として扱い issue 作成を続行せよ。\n`
    + `3. 保存した <BODY_FILE> で issue を作成: \`gh issue create --title <TITLE> --label self-improve --body-file <BODY_FILE>\`\n`
    + `   <TITLE> は次のタイトルを一字一句そのまま、shell 安全にクォートして渡す: ${JSON.stringify(c.title)}\n`
    + `4. 出力 URL 末尾の issue 番号を number に入れ created:true を返す。失敗時は throw せず created:false。\n`
    + `\n## Output format\n{ "created": boolean, "number": number, "url": string }\n`
    + `\n## Tools\n使用可: Bash, Read, Write\n\n## Boundary\n<BODY_FILE> 以外のファイル変更禁止。git commit 禁止。issue 作成は 1 件のみ。\n\n## Token cap\n100 語以内。`,
    nsAgentOpts({ agentType: 'dev-runner', schema: ISSUE_CREATED, label: `file-issue#${filed.length + 1}`, phase: 'File' }),
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
      + bodySaveInstr(newBody, { saveDir: IMPROVE_BODY_DIR, fileName: 'dev-improve-backlog.md' }, 'DEV_IMPROVE')
      + `## Instructions\n`
      + (backlogIssue
        ? `保存した <BODY_FILE> で次を実行: \`gh issue edit ${backlogIssue.number} --body-file <BODY_FILE>\`\n`
        : `1. \`gh label create self-improve-backlog --color C5DEF5 --description "dev-improve backlog" --force\`\n`
          + `2. \`gh issue create --title "dev-improve backlog" --label self-improve-backlog --body-file <BODY_FILE>\`\n`)
      + `成功時 created:true と issue 番号を返す。失敗時は throw せず created:false。\n`
      + `\n## Output format\n{ "created": boolean, "number": number, "url": string }\n`
      + `\n## Tools\n使用可: Bash, Read, Write\n\n## Boundary\n<BODY_FILE> 以外のファイル変更禁止。git commit 禁止。\n\n## Token cap\n100 語以内。`,
      nsAgentOpts({ agentType: 'dev-runner', schema: ISSUE_CREATED, label: 'backlog-append', phase: 'File' }),
    )
    if (res?.created) backlogAdded = newLosers.length
    else log('⚠️ File: backlog 更新失敗（fail-open）')
  }
}

// improve-cycle telemetry — journal-save（結果データをファイルへ verbatim 永続化）→
// journal-log（検証済みファイルパスを jq で読み出す finalize コマンドのみ）の 2 段構成。
// 結論値リテラル（outcome）と journal.sh 呼び出し語彙が同一 prompt に同居しないようにする。
const improveHandoff = JSON.stringify({
  outcome: 'success',
  telemetry: {
    candidates_found: candidates.length,
    issues_filed: filed.length,
    hypotheses_confirmed: reconcile.confirmed,
    hypotheses_not_confirmed: reconcile.not_confirmed,
    hypotheses_insufficient: reconcile.insufficient,
    hypotheses_unavailable: reconcile.unavailable,
    backlog_added: backlogAdded,
    backpressure_skipped: backpressure,
  },
})

let journalLogStatus = 'save_failed'
try {
  const saveRes = await agent(
    `## Objective\ndev-improve サイクルの journal handoff payload を一時ファイルへ保存する。\n\n`
    + `## Instructions\n`
    // dev-improve は run 専用 worktree を持たない（issue を起票するだけで作業ツリーを作らない）ため、
    // dev-flow / pr-iterate のような `<worktree>/.devflow-tmp` は使えない。代わりに TMPDIR 配下の
    // 固定サブディレクトリへ置き、requiredDirSuffix で保存先を pin する（他 2 経路と同じ
    // ディレクトリ固定の防御を維持するため。展開は shell 側で行われる）。
    + buildJournalSaveInstr({ payload: improveHandoff, saveDir: '${TMPDIR:-/tmp}/dev-improve', fileName: 'payload-dev-improve.json' })
    + `\n## Output format\n{ "saved": boolean, "path": string }\n`
    + `\n## Tools\n使用可: Bash, Write, Read（Read は既存 payload の冪等上書きに必要）\n\n## Boundary\n作成した一時ファイル以外のファイルを変更しない。git 操作禁止。\n\n## Token cap\n120 語以内。`,
    nsAgentOpts({ agentType: 'dev-runner-haiku', schema: JOURNAL_SAVE_RESULT, label: 'journal-save', phase: 'File' }),
  )
  const savedPath = saveRes?.saved === true && validateJournalSavedPath(saveRes.path, { requiredDirSuffix: '/dev-improve' }) ? saveRes.path : null

  if (savedPath) {
    // stage1 は成功済み。stage2 が throw（schema 不一致・proxy 実行失敗等）すると catch へ
    // 抜けて代入が走らないため、呼び出し前に log_failed へ倒しておく。こうしないと stage2 の
    // 失敗が save_failed として報告され、観測した status が実際の失敗段と食い違う。
    journalLogStatus = classifyJournalLogStatus({ saved: true, logged: false })
    const journalRes = await agent(
      `## Objective\ndev-improve サイクルの telemetry を journal に記録する。\n\n`
      + `## Instructions\n次のコマンドをそのまま実行せよ（bare 名を先頭トークンとする形）:\n`
      + `\`journal log dev-improve "$(jq -r .outcome '${savedPath}')" --telemetry-json "$(jq -c .telemetry '${savedPath}')"\`\n`
      + `exit 0 なら logged:true、失敗しても throw せず logged:false を返すこと。\n`
      + `\n## Output format\n{ "logged": boolean, "summary": string }\n`
      + `\n## Tools\n使用可: Bash, Read, Skill\n\n## Boundary\n~/.claude/journal 以外のファイル変更禁止。git 操作禁止。\n\n## Token cap\n50 語以内。`,
      nsAgentOpts({ agentType: 'dev-runner-haiku', schema: JOURNAL_RESULT, label: 'journal-log', phase: 'File' }),
    )
    journalLogStatus = classifyJournalLogStatus({ saved: true, logged: journalRes?.logged === true })
    if (!journalRes?.logged) log('⚠️ journal-log 失敗（fail-open）— telemetry 記録漏れの可能性')
  } else {
    journalLogStatus = classifyJournalLogStatus({ saved: false })
    log('⚠️ journal-save 失敗（fail-open）— telemetry 記録漏れの可能性')
  }
} catch (e) {
  log(`⚠️ journal handoff 失敗（fail-open）: ${e?.message ?? e}`)
}

log(`dev-improve 完了: issue化 ${filed.length} 件 / backlog ${backlogAdded} 件 / backpressure=${backpressure}`)

return {
  issues_filed: filed,
  candidates_found: candidates.length,
  reconcile,
  backlog_added: backlogAdded,
  backpressure_skipped: backpressure,
  journal_log_status: journalLogStatus,
}
