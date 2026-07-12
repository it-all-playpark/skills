export const meta = {
  name: 'dev-flow-canary',
  description: 'dev-flow harness capability の read-only canary: schema付きagent/parallel/nested workflow/model・effort routing/pause・resume/direct fs・shell・import を pass/fail/unsupported で構造化出力。repo/git/GitHub state 不変。bridge 撤去は行わない（report のみ）。結果は dev-flow-doctor run-diagnostics.sh --canary で取り込む',
  phases: [
    { title: 'Probe' },
    { title: 'Agents' },
    { title: 'Nested' },
    { title: 'Report' },
  ],
}

// dev-flow-canary は self-contained workflow（tools/sync-inlines.mjs による _lib inline 生成を使わない）。
// 検証対象そのものが inline bridge であるため、bridge に依存しない独立実装が診断の独立性を保つ
// （AGENTS.md「canary は self-contained な workflow ファイルとして実装」参照）。
//
// read-only 保証（AC1）: このファイルには mutating な git 操作（commit・push・add・worktree 作成等）・gh コマンドを一切含めない。
// 全 probe / model-report / parallel echo は dev-runner-haiku-ro（read-only exec-proxy）へ委譲し、
// report 書き出しのみ dev-runner-haiku（repo 外 ~/.claude/logs への書き込み）を使う。

// ---- Schemas ----------------------------------------------------------------------------------

const VERSION_PROBE = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    version: { type: 'string' },
    timestamp_utc: { type: 'string' },
  },
  required: ['ok', 'version'],
}

const MODEL_REPORT = {
  type: 'object',
  properties: {
    model_id: { type: 'string' },
    effort_visible: { type: 'boolean' },
    effort: { type: 'string' },
  },
  required: ['model_id'],
}

const ECHO = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    token: { type: 'string' },
  },
  required: ['ok', 'token'],
}

const WRITE_RESULT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    path: { type: 'string' },
  },
  required: ['ok'],
}

// ---- direct capability probes（副作用ゼロ。すべて関数内に閉じる — top-level require/Date.now lint 回避）------

function probeRequireModule(moduleId, capLabel) {
  if (typeof require !== 'function') {
    return {
      status: 'unsupported',
      detail: `require が workflow runtime に公開されていない — ${capLabel} は probe 不能（module ロード自体は試みていない）`,
    }
  }
  try {
    require(moduleId)
    return {
      status: 'pass',
      detail: `require('${moduleId}') 成功 — ${capLabel} は module ロード可能`,
    }
  } catch (e) {
    return {
      status: 'fail',
      detail: `require('${moduleId}') が存在するが失敗: ${e?.message ?? String(e)}`,
    }
  }
}

async function probeDirectImport() {
  try {
    await import('node:fs')
    return { status: 'pass', detail: "await import('node:fs') 成功 — dynamic import 対応" }
  } catch (e) {
    return {
      status: 'unsupported',
      detail: `await import() が未対応（${e?.message ?? String(e)}）— harness が dynamic import callback を提供していない可能性`,
    }
  }
}

function probePauseResume() {
  const candidates = ['pause', 'resume', 'checkpoint', 'suspend']
  const present = candidates.filter((name) => typeof globalThis[name] === 'function')
  if (present.length > 0) {
    return {
      status: 'pass',
      detail: `API present (${present.join(', ')}) — not invoked to avoid suspending canary; 実 suspend 検証は不能`,
    }
  }
  return {
    status: 'unsupported',
    detail: 'no pause/resume API exposed to workflow runtime — resume cache は同一 session 内から観測不能',
  }
}

function probeDirectCapabilities() {
  return {
    direct_fs: probeRequireModule('node:fs', 'direct_fs'),
    direct_shell: probeRequireModule('node:child_process', 'direct_shell'),
    pause_resume: probePauseResume(),
  }
}

// ---- agent prompt builders（必須5要素: Objective/Output format/Tools/Boundary/Token cap）--------------------

function versionProbePrompt() {
  return [
    '## Objective',
    'Claude Code の CLI version 文字列と現在時刻（UTC）を取得する。',
    '',
    '## Output format',
    'JSON: {"ok": boolean, "version": string, "timestamp_utc": string}。'
    + ' version は `claude --version` の生出力、timestamp_utc は `date -u +%Y-%m-%dT%H:%M:%SZ` の生出力を verbatim で入れる。',
    '',
    '## Tools',
    '実行してよいコマンドは次の2つのみ: `claude --version` と `date -u +%Y-%m-%dT%H:%M:%SZ`。他のコマンドは一切実行しない。',
    '',
    '## Boundary',
    'ファイル書き込み・git 操作・gh コマンドは禁止。read-only probe のみ。',
    '',
    '## Token cap',
    '出力は schema フィールドのみ。説明文は不要。',
  ].join('\n')
}

function modelReportPrompt() {
  return [
    '## Objective',
    'ツールを一切使わず、自分の system prompt から model ID と effort 設定の可視性を報告する。',
    '',
    '## Output format',
    'JSON: {"model_id": string, "effort_visible": boolean, "effort"?: string}。'
    + ' model_id は system prompt 中の "The exact model ID is ..." の値を verbatim で返す。'
    + ' effort 設定値が system prompt から確認できる場合のみ effort_visible:true と effort を返し、'
    + ' 確認できなければ effort_visible:false のみ返す。',
    '',
    '## Tools',
    'ツール不使用（Bash/Read 等は呼ばない）。system prompt の自己観測のみ。',
    '',
    '## Boundary',
    'ファイル変更・git/gh 操作は禁止。',
    '',
    '## Token cap',
    '出力は schema フィールドのみ。',
  ].join('\n')
}

function echoPrompt(token) {
  return [
    '## Objective',
    `ツールを一切使わず、固定トークン "${token}" をそのまま echo する。`,
    '',
    '## Output format',
    `JSON: {"ok": true, "token": "${token}"}`,
    '',
    '## Tools',
    'ツール不使用。',
    '',
    '## Boundary',
    'ファイル変更・git/gh 操作は禁止。',
    '',
    '## Token cap',
    '出力は schema フィールドのみ。',
  ].join('\n')
}

function buildCanaryReportWriteCommand(report) {
  const json = JSON.stringify(report, null, 2)
  return `mkdir -p ~/.claude/logs/dev-flow-canary && cat > ~/.claude/logs/dev-flow-canary/canary-$(date +%s).json <<'CANARY_EOF'\n${json}\nCANARY_EOF`
}

function reportWritePrompt(report) {
  const cmd = buildCanaryReportWriteCommand(report)
  return [
    '## Objective',
    '下記 Bash コマンドをそのまま実行し、書き込んだファイルの絶対パスを報告する。',
    '',
    '## Output format',
    'JSON: {"ok": boolean, "path": string}。path は書き込み先の絶対パス（~ を展開した実パス）。',
    '',
    '## Tools',
    'Bash のみ。下記コマンド以外は実行しない:',
    '```bash',
    cmd,
    '```',
    '',
    '## Boundary',
    'このコマンド以外のファイル書き込み・git/gh 操作は一切禁止。repo 内には何も書かない（書き込み先は repo 外 ~/.claude/logs/dev-flow-canary/ のみ）。',
    '',
    '## Token cap',
    '出力は schema フィールドのみ。',
  ].join('\n')
}

// ============================================================
// Phase: Probe
// ============================================================

phase('Probe')
log('dev-flow-canary: harness capability probe を開始（read-only, repo/git/GitHub state 不変）')

const direct = probeDirectCapabilities()
const directImport = await probeDirectImport()

const versionProbe = await agent(
  versionProbePrompt(),
  { agentType: 'dev-runner-haiku-ro', schema: VERSION_PROBE, label: 'canary:version', phase: 'Probe' },
)
const claudeCodeVersion = (versionProbe && versionProbe.ok !== false && typeof versionProbe.version === 'string')
  ? versionProbe.version
  : 'unknown'
const timestampUtc = (versionProbe && versionProbe.ok !== false && typeof versionProbe.timestamp_utc === 'string')
  ? versionProbe.timestamp_utc
  : 'unknown'
if (claudeCodeVersion === 'unknown') {
  log('⚠️ version probe が null/ok:false — claude_code_version=unknown（fail-open、throw しない）')
}

// ============================================================
// Phase: Agents
// ============================================================

phase('Agents')
log('agent schema / model routing / effort routing / parallel fanout を probe する')

const modelReport = await agent(
  modelReportPrompt(),
  { agentType: 'dev-runner-haiku-ro', schema: MODEL_REPORT, label: 'canary:model-report', phase: 'Agents' },
)

const agentSchema = (modelReport != null && typeof modelReport.model_id === 'string')
  ? { status: 'pass', detail: 'schema-constrained agent が model_id 付き object を返した' }
  : { status: 'fail', detail: 'schema-constrained agent returned null' }

const modelId = modelReport?.model_id ?? ''
const modelRouting = /haiku/i.test(modelId)
  ? { status: 'pass', detail: `model_id=${modelId}（dev-runner-haiku-ro frontmatter の model:haiku が適用されている証拠）` }
  : { status: 'fail', detail: `model_id=${modelId || '<none>'}（haiku 系 model_id を期待したが一致しない）` }

const effortRouting = modelReport?.effort_visible === true
  ? { status: 'pass', detail: `effort=${modelReport.effort}` }
  : { status: 'unsupported', detail: 'effort は subagent の system prompt から観測不能 — frontmatter effort の適用は runtime 非公開' }

const parTokens = ['A', 'B']
const parThunks = parTokens.map((t) => () => agent(
  echoPrompt(t),
  { agentType: 'dev-runner-haiku-ro', schema: ECHO, label: `canary:par:${t}`, phase: 'Agents' },
))
const parResults = await parallel(parThunks)
const parallelOk = Array.isArray(parResults)
  && parResults.length === parTokens.length
  && parTokens.every((t, i) => parResults[i]?.ok === true && parResults[i]?.token === t)
const parallelFanout = parallelOk
  ? { status: 'pass', detail: `parallel([A,B]) 結果一致: ${JSON.stringify(parResults)}` }
  : { status: 'fail', detail: `parallel() 結果不一致/欠落: ${JSON.stringify(parResults)}` }

// ============================================================
// Phase: Nested
// ============================================================

phase('Nested')
log('nested workflow（1段）を probe する')

let nestedWorkflow
try {
  const child = await workflow('dev-flow-canary-child', { token: 'canary-nested-probe' })
  if (child?.child_ok === true && child?.echo === 'canary-nested-probe') {
    nestedWorkflow = { status: 'pass', detail: 'workflow() nested 1段呼び出しが期待 shape を返した' }
  } else {
    nestedWorkflow = { status: 'fail', detail: `nested workflow の戻り値が期待 shape と不一致: ${JSON.stringify(child)}` }
  }
} catch (e) {
  nestedWorkflow = { status: 'unsupported', detail: `workflow() threw: ${e?.message ?? String(e)}` }
}

// ============================================================
// Phase: Report
// ============================================================

phase('Report')
log('capability report を組み立てる')

const capabilities = [
  { id: 'agent_schema', ...agentSchema },
  { id: 'model_routing', ...modelRouting },
  { id: 'effort_routing', ...effortRouting },
  { id: 'parallel_fanout', ...parallelFanout },
  { id: 'nested_workflow', ...nestedWorkflow },
  { id: 'pause_resume', ...direct.pause_resume },
  { id: 'direct_fs', ...direct.direct_fs },
  { id: 'direct_shell', ...direct.direct_shell },
  { id: 'direct_import', ...directImport },
]

const execProxyRemovable = direct.direct_fs.status === 'pass' && direct.direct_shell.status === 'pass'
const inlineGeneratorRemovable = directImport.status === 'pass'
const bridgeVerdict = (execProxyRemovable && inlineGeneratorRemovable) ? 'reevaluate-bridges' : 'keep-bridges'

const report = {
  canary_version: '1.0.0',
  claude_code_version: claudeCodeVersion,
  timestamp_utc: timestampUtc,
  capabilities,
  bridge_sunset: {
    exec_proxy_removable: execProxyRemovable,
    inline_generator_removable: inlineGeneratorRemovable,
    verdict: bridgeVerdict,
    note: 'capability report only — bridge 撤去は別 issue + human review でのみ実施',
  },
  report_path: null,
}

const writeResult = await agent(
  reportWritePrompt(report),
  { agentType: 'dev-runner-haiku', schema: WRITE_RESULT, label: 'canary:report-write', phase: 'Report' },
)
report.report_path = (writeResult && writeResult.ok !== false && typeof writeResult.path === 'string')
  ? writeResult.path
  : null
if (report.report_path === null) {
  log('⚠️ canary report の書き出しに失敗（fail-open） — report_path=null。dev-flow-doctor --canary への手動取り込みは今回不可')
}

const passCount = capabilities.filter((c) => c.status === 'pass').length
const failCount = capabilities.filter((c) => c.status === 'fail').length
const unsupportedCount = capabilities.filter((c) => c.status === 'unsupported').length
log(
  `dev-flow-canary summary: claude_code_version=${claudeCodeVersion} `
  + `pass=${passCount} fail=${failCount} unsupported=${unsupportedCount} `
  + `bridge_verdict=${bridgeVerdict} report_path=${report.report_path ?? 'null'}`,
)

return report
