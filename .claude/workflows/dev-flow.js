export const meta = {
  name: 'dev-flow',
  description: 'Issue から LGTM まで: 分析→計画(レビュー上限20)→実装(並列/直列)→test green→評価(差し戻し上限10)→PR→pr-iterate。merge は手動',
  phases: [
    { title: 'Setup' },
    { title: 'Analyze' },
    { title: 'Plan' },
    { title: 'Implement' },
    { title: 'Validate' },
    { title: 'Evaluate' },
    { title: 'PR' },
    // 注: 最終の PR レビュー&fix ループは workflow('pr-iterate') がサブ workflow として
    //     自前の 'Iterate' phase を持つ。親 meta には現れない。
  ],
}

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

// ---- args ----
const ISSUE = resolvePositiveIntArg(args, 'issue')
const BASE = args?.base ?? 'dev'
const TESTING = args?.testing ?? 'tdd'
const DEPTH = args?.depth ?? 'standard'
const PLAN_MAX = 8         // 計画レビュー上限（収束モデルにより happy path は数回で抜ける。issue #123）
const PLAN_STUCK = 2       // 同一 topic がこの回数出たら stuck と判定（moving target 打ち切り。issue #123）
const PLAN_RELAX_FROM = 3  // この iteration 以降は critical 無しなら収束を許容（issue #123）
const EVAL_MAX = 10   // 本質: 評価差し戻し上限
const GREEN_MAX = 3   // test green までの実装差し戻し上限
const BLOCK_MAX = 2   // BLOCKED 由来の再計画上限
if (!ISSUE) throw new Error('dev-flow: issue 番号が必要です（args.issue）')

// agent() は user skip 時 null を返しうる。load-bearing な結果はここで弾く。
function need(result, what) {
  if (result == null) throw new Error(`dev-flow: ${what} が結果を返しませんでした（skip された可能性）`)
  return result
}

// ---- Plan 収束モデル（issue #123）----
// cold start の plan-reviewer は moving target を生む（毎回 fresh context で新しい観点の major を
// 捻り出し、major 1 件で revise 確定 → 上限まで収束しない）。orchestrator 側で収束を判断する:
//   1. 既出 findings を planner/reviewer に渡し「対応済み・新規 critical/major のみ」を強制（蒸し返し抑制）
//   2. 同一 topic が PLAN_STUCK 回出たら stuck と判定（fingerprint を JS 側で突合）
//   3. iteration >= PLAN_RELAX_FROM、または stuck なら、critical が無い限り収束を許容
//   4. critical は常にブロック（大 issue の品質ゲートは後退させない）
//   5. 上限到達でも throw せず、未解消 findings を concerns として Evaluate phase へ委譲
function planHasCritical(rev) {
  return (rev.findings ?? []).some((f) => f && f.severity === 'critical')
}
// 収束判定。critical が残る限り収束しない。pass / relax(iteration 経過) / stuck で受理。
function planConverged(rev, iteration, stuck) {
  if (rev.verdict === 'pass') return true
  if (planHasCritical(rev)) return false
  return stuck || iteration >= PLAN_RELAX_FROM
}
// 未解消 findings を Evaluate 用 concerns 文字列に整形する。
function findingsToConcerns(rev) {
  return (rev.findings ?? []).map(
    (f) => `[plan:${f?.severity ?? '?'}] ${f?.topic ?? ''}: ${f?.description ?? ''}`)
}

// ---- schemas ----
const SETUP = {
  type: 'object', required: ['worktree', 'branch'],
  properties: { worktree: { type: 'string' }, branch: { type: 'string' } },
}
const REQ = {
  type: 'object', required: ['summary', 'acceptance_criteria'],
  properties: {
    summary: { type: 'string' },
    issue_type: { type: 'string' },
    acceptance_criteria: { type: 'array', items: { type: 'string' } },
    scope: { type: 'string' },
  },
}
const TASK = {
  type: 'object', required: ['id', 'desc'],
  properties: {
    id: { type: 'string' }, desc: { type: 'string' },
    file_changes: { type: 'array', items: { type: 'string' } },
    test_plan: { type: 'string' },
    depends_on: { type: 'array', items: { type: 'string' } },
  },
}
const PLAN = {
  type: 'object', required: ['summary', 'serial', 'parallel'],
  properties: {
    summary: { type: 'string' },
    architecture_decisions: { type: 'array' },
    serial: { type: 'array', items: TASK },
    parallel: { type: 'array', items: TASK },
    edge_cases: { type: 'array' },
    notes_for_retry: { type: 'string' },
  },
}
const VERDICT = {
  type: 'object', required: ['score', 'verdict', 'findings', 'summary'],
  properties: {
    score: { type: 'number' },
    verdict: { type: 'string', enum: ['pass', 'revise', 'block'] },
    pass_threshold: { type: 'number' },
    findings: { type: 'array' },
    summary: { type: 'string' },
  },
}
const IMPL = {
  type: 'object', required: ['status', 'task_id'],
  properties: {
    status: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED', 'NEEDS_CONTEXT'] },
    task_id: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    concerns: { type: 'array' },
    blocking_reason: { type: ['string', 'null'] },
    missing_context: { type: ['string', 'null'] },
  },
}
const GREEN = {
  type: 'object', required: ['tests', 'green'],
  properties: {
    tests: { type: 'string', enum: ['passed', 'failed', 'no_tests'] },
    green: { type: 'boolean' },
    summary: { type: 'string' },
  },
}
const EVAL = {
  type: 'object', required: ['verdict', 'total'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    score: { type: 'object' },
    total: { type: 'number' },
    threshold: { type: 'number' },
    feedback: { type: 'array' },
    feedback_level: { type: 'string', enum: ['design', 'implementation'] },
    task_type: { type: 'string' },
  },
}
const PRURL = {
  type: 'object', required: ['pr_url', 'pr_number'],
  properties: {
    pr_url: { type: 'string' }, pr_number: { type: ['string', 'number'] },
    committed: { type: 'boolean' },
  },
}

// ---- helpers ----
let WT // Setup で確定

function implPrompt(t, fixFeedback) {
  return `cd ${WT} で作業（Bash 呼び出しごとに必ず先頭で cd ${WT} すること。agent の cwd は毎回リセットされる）。`
    + `次の task を ${TESTING} 戦略で実装せよ。共有 worktree のため自分の task の file_changes 以外は触るな。`
    + `git add / commit はするな。\n`
    + `task: ${JSON.stringify(t)}\n`
    + (fixFeedback ? `修正指摘（各項目を解消）:\n${JSON.stringify(fixFeedback)}\n` : '')
}

// 計画の serial → 順次、parallel → 同時。drop（throw→null）を可視化して返す。
async function runImplement(p, fixFeedback, tag) {
  const results = []
  for (const t of (p.serial ?? [])) {
    const r = await agent(implPrompt(t, fixFeedback),
      { agentType: 'implementer', schema: IMPL, label: `${tag}:serial:${t.id}`, phase: 'Implement' })
    if (r) results.push(r)
  }
  const par = (p.parallel ?? []).map((t) => () =>
    agent(implPrompt(t, fixFeedback),
      { agentType: 'implementer', schema: IMPL, label: `${tag}:par:${t.id}`, phase: 'Implement' }))
  const parResults = await parallel(par)
  const ok = parResults.filter(Boolean)
  const dropped = parResults.length - ok.length
  if (dropped) log(`⚠️ ${tag}: parallel implementer ${dropped} 件が失敗(null) — 要確認`)
  results.push(...ok)
  return results
}

// ============================================================
// Phase Setup: 単一 worktree + branch を作る。全 agent が同じパスで作業し成果を集約する。
// （isolation:'worktree' は使わない — 各 agent が別 worktree になり並列実装の成果が分散するため。
//  並列は同一 worktree 内で「file_changes が disjoint な」task のみ。plan-reviewer が検証する。）
// ============================================================
phase('Setup')
const branch = `feature/issue-${ISSUE}`
const setup = need(await agent(
  `git worktree を 1 つ作って絶対パスを返せ。手順:\n`
  + `1. リポジトリルートで \`git fetch origin\`\n`
  + `2. worktree dir \`<repo>/.claude/worktrees/df-${ISSUE}\` が既に存在すれば再利用、無ければ\n`
  + `   \`git worktree add -b ${branch} <repo>/.claude/worktrees/df-${ISSUE} origin/${BASE}\`\n`
  + `   （branch が既に存在する場合は -b を外して既存 branch を checkout）\n`
  + `3. 作成/再利用した worktree の絶対パスと branch 名を返す`,
  { agentType: 'dev-runner', schema: SETUP, label: 'worktree', phase: 'Setup' },
), 'Setup(worktree)')
WT = setup.worktree
log(`worktree: ${WT} (branch ${setup.branch})`)

// ============================================================
// Phase Analyze: issue 分析（dev-issue-analyze skill を dev-runner 経由で呼ぶ）
// ============================================================
phase('Analyze')
const req = need(await agent(
  `cd ${WT} で作業。\`Skill: dev-issue-analyze ${ISSUE} --depth ${DEPTH}\` を実行し、`
  + `issue #${ISSUE} の要件・受入条件・issue type を抽出して返せ。`,
  { agentType: 'dev-runner', schema: REQ, label: `analyze#${ISSUE}`, phase: 'Analyze' },
), 'Analyze')

// ============================================================
// Phase Plan: dev-planner ⇄ plan-reviewer ループ。
// 収束は planConverged() が判断する（issue #123。基準は同関数上のコメント参照）:
//   既出 findings 累積で cold start を補償 / 同一 topic 反復で stuck 打ち切り /
//   iteration 経過で relax / critical は常にブロック / 上限到達でも throw せず Evaluate へ委譲。
// ============================================================
phase('Plan')
let plan = null
let planVerdict = null
const planSeen = {}        // topic → { finding, count }（findings 累積 & stuck 検出。issue #123）
let planConcerns = []      // 収束時に残った未解消 findings（Evaluate の focus_areas へ）
for (let i = 1; i <= PLAN_MAX; i++) {
  const prior = Object.values(planSeen).map((s) => s.finding)   // 前 iteration までの累積 findings
  plan = need(await agent(
    `cd ${WT} で作業。issue 要件と${prior.length ? 'レビュー指摘' : '初回計画'}に基づき実装計画を立てよ。\n`
    + `requirements: ${JSON.stringify(req)}\n`
    + `testing: ${TESTING}\n`
    + (prior.length
        ? `これまでの plan-reviewer findings（過去 iteration 全件の累積。既に解消した項目は再対応不要。`
          + `同じ topic が繰り返し残るなら同じ直し方をやめてアプローチを変えよ）:\n${JSON.stringify(prior)}\n`
        : '')
    + `serial（依存あり）と parallel（独立かつ file_changes が disjoint）に分解し、各 task は self-contained に書け。`,
    { agentType: 'dev-planner', schema: PLAN, label: `plan#${i}`, phase: 'Plan' },
  ), `Plan(planner#${i})`)
  const rev = need(await agent(
    `cd ${WT} で作業。次の実装計画を批判的にレビューせよ（実コードベースに照合）。\n`
    + `requirements: ${JSON.stringify(req)}\n`
    + `plan: ${JSON.stringify(plan)}\n`
    + (prior.length
        ? `既出 findings（前 iteration までに指摘済み。planner は対応済みのはず）:\n${JSON.stringify(prior)}\n`
          + `**新規の critical/major のみ報告**せよ。既出論点の蒸し返し・別観点の上乗せ（moving target）は禁止。`
          + `同一問題には既出と同じ topic 文字列を再利用せよ。`
        : ''),
    { agentType: 'plan-reviewer', schema: VERDICT, label: `review#${i}`, phase: 'Plan' },
  ), `Plan(reviewer#${i})`)
  planVerdict = rev

  // findings を topic 単位で累積し出現回数を数える（stuck 検出 fingerprint）
  for (const f of (rev.findings ?? [])) {
    if (!f) continue
    const t = f.topic ?? f.description ?? JSON.stringify(f)
    if (planSeen[t]) { planSeen[t].finding = f; planSeen[t].count += 1 }
    else planSeen[t] = { finding: f, count: 1 }
  }
  const stuckTopics = Object.entries(planSeen).filter(([, s]) => s.count >= PLAN_STUCK).map(([t]) => t)
  const stuck = stuckTopics.length > 0
  log(`plan iteration ${i}: ${rev.verdict} (score ${rev.score})${stuck ? ` [stuck: ${stuckTopics.join(' / ')}]` : ''}`)

  if (planConverged(rev, i, stuck)) {
    if (rev.verdict !== 'pass') {
      planConcerns = findingsToConcerns(rev)
      log(`plan 収束（verdict=${rev.verdict}, iter ${i}${stuck ? ', stuck' : ', relaxed'}）— `
        + `未解消 ${planConcerns.length} 件を Evaluate へ委譲`)
    }
    break
  }
  if (i === PLAN_MAX) {
    planConcerns = findingsToConcerns(rev)
    log(`⚠️ plan は ${PLAN_MAX} iteration で収束せず（verdict=${rev.verdict}）— `
      + `throw せず未解消 ${planConcerns.length} 件を Evaluate/human review へ委譲`)
  }
}

// ============================================================
// Phase Implement: 実装 → BLOCKED があれば別アプローチで再計画して再実装（上限 BLOCK_MAX）
// ============================================================
phase('Implement')
let implResults = await runImplement(plan, null, 'impl')
let blockedConcerns = []
for (let b = 1; b <= BLOCK_MAX; b++) {
  const blocked = implResults.filter((r) => r && r.status === 'BLOCKED')
  if (!blocked.length) break
  log(`implement: ${blocked.length} task が BLOCKED — 別アプローチで再計画 (${b}/${BLOCK_MAX})`)
  const blockFindings = blocked.map((r) => ({
    severity: 'critical', dimension: 'approach_mismatch',
    topic: String(r.blocking_reason ?? '').slice(0, 60),
    description: r.blocking_reason ?? 'BLOCKED',
    suggestion: '同アプローチでは進行不可。代替設計を立案すること（現アプローチの再試行は禁止）。',
  }))
  plan = need(await agent(
    `cd ${WT} で作業。前回実装が BLOCKED になった。別アプローチで計画を立て直せ。\n`
    + `requirements: ${JSON.stringify(req)}\n`
    + `現計画: ${JSON.stringify(plan)}\n`
    + `approach_mismatch findings:\n${JSON.stringify(blockFindings)}`,
    { agentType: 'dev-planner', schema: PLAN, label: `replan-blocked#${b}`, phase: 'Implement' },
  ), `Implement(replan#${b})`)
  implResults = await runImplement(plan, null, `reimpl-blocked#${b}`)
  if (b === BLOCK_MAX) {
    const stillBlocked = implResults.filter((r) => r && r.status === 'BLOCKED')
    if (stillBlocked.length) {
      blockedConcerns = stillBlocked.map((r) => r.blocking_reason ?? 'BLOCKED')
      log(`⚠️ ${BLOCK_MAX} 回再計画しても ${stillBlocked.length} task が BLOCKED — Evaluate/human review へ`)
    }
  }
}
// DONE_WITH_CONCERNS / 未解消 BLOCKED を evaluator の focus_areas に渡す材料にする
const concerns = [
  ...planConcerns,
  ...implResults.flatMap((r) => (r && Array.isArray(r.concerns)) ? r.concerns : []),
  ...blockedConcerns,
]

// ============================================================
// Phase Validate: test green を確認し、green でなければ implementer に差し戻し（上限 GREEN_MAX）
// （format/lint は hook 責務でここでは扱わない）
// ============================================================
phase('Validate')
let val = null
for (let i = 1; i <= GREEN_MAX; i++) {
  val = need(await agent(
    `cd ${WT} で作業。テストスイートを実行し（npm test / pytest / cargo test 等、プロジェクトに合わせる）、`
    + `green かどうか判定せよ。format/lint はこの phase の責務外。test の結果のみ報告せよ。`,
    { agentType: 'dev-runner', schema: GREEN, label: `test#${i}`, phase: 'Validate' },
  ), `Validate(test#${i})`)
  log(`validate iteration ${i}: tests=${val.tests} green=${val.green}`)
  if (val.green || val.tests === 'no_tests') break
  if (i === GREEN_MAX) {
    log(`⚠️ ${GREEN_MAX} 回試行しても test green にならず — Evaluate へ（human review 想定）`)
    break
  }
  await agent(
    `cd ${WT} で作業（Bash ごとに先頭で cd すること）。テストが失敗している。原因を分析して実装/テストを修正し`
    + `green を目指せ。共有 worktree のため無関係ファイルは触るな。git add / commit はするな。\n`
    + `失敗内容: ${val.summary ?? '(詳細はテスト出力を確認)'}`,
    { agentType: 'implementer', schema: IMPL, label: `green-fix#${i}`, phase: 'Validate' },
  )
}

// ============================================================
// Phase Evaluate: evaluator → fail なら design=再計画+再実装 / implementation=implementer 修正（上限 10）
// 初回は implement で出た concerns / 未解消 BLOCKED を focus_areas として重点監査させる。
// ============================================================
phase('Evaluate')
let evalResult = null
for (let i = 1; i <= EVAL_MAX; i++) {
  const ev = need(await agent(
    `cd ${WT} で作業。実装品質を独立評価せよ（base は origin/${BASE}。`
    + `\`git diff $(git merge-base HEAD origin/${BASE})..HEAD\` で実 diff を確認し、テストを実際に走らせる）。\n`
    + `requirements: ${JSON.stringify(req)}\n`
    + `plan: ${JSON.stringify(plan)}\n`
    + ((i === 1 && concerns.length) ? `focus_areas（重点監査せよ。implementer の自己申告した弱点/未解消BLOCKED）:\n${JSON.stringify(concerns)}\n` : ''),
    { agentType: 'evaluator', schema: EVAL, label: `eval#${i}`, phase: 'Evaluate' },
  ), `Evaluate(eval#${i})`)
  evalResult = ev
  log(`evaluate iteration ${i}: ${ev.verdict} (total ${ev.total})`)
  if (ev.verdict === 'pass') break
  if (i === EVAL_MAX) {
    log(`evaluate: ${EVAL_MAX} 回で pass せず — 現状で PR へ進む（human review に委ねる）`)
    break
  }
  if (ev.feedback_level === 'design') {
    plan = need(await agent(
      `cd ${WT} で作業。evaluator が設計レベルの問題を指摘した。計画を revise せよ。\n`
      + `requirements: ${JSON.stringify(req)}\n`
      + `現計画: ${JSON.stringify(plan)}\n`
      + `evaluator feedback: ${JSON.stringify(ev.feedback)}`,
      { agentType: 'dev-planner', schema: PLAN, label: `replan#${i}`, phase: 'Evaluate' },
    ), `Evaluate(replan#${i})`)
    await runImplement(plan, ev.feedback, `reimpl#${i}`)
  } else {
    await agent(
      `cd ${WT} で作業（Bash ごとに先頭で cd すること）。evaluator が実装レベルの問題を指摘した。`
      + `既存計画のまま修正せよ。無関係ファイルは触るな。git add / commit はするな。\n`
      + `evaluator feedback: ${JSON.stringify(ev.feedback)}`,
      { agentType: 'implementer', schema: IMPL, label: `fix#${i}`, phase: 'Evaluate' })
  }
}

// ============================================================
// Phase PR: git-commit + git-pr skill を dev-runner で実行し PR URL を取得。
// ============================================================
phase('PR')
const pr = need(await agent(
  `cd ${WT} で作業。次を順に実行せよ:\n`
  + `1. \`Skill: git-commit --all --worktree ${WT}\`（変更を日本語メッセージで commit）\n`
  + `2. \`Skill: git-pr ${ISSUE} --base ${BASE} --lang ja --worktree ${WT}\`（PR 作成）\n`
  + `作成された PR の URL と番号を返せ。`,
  { agentType: 'dev-runner', schema: PRURL, label: `pr#${ISSUE}`, phase: 'PR' },
), 'PR')
log(`PR created: ${pr.pr_url}`)

// ============================================================
// pr-iterate をサブ workflow として呼ぶ（review ⇄ fix, LGTM まで, 上限10）。
// 注: これは「親 workflow の中の workflow()」= ネスト1段で合法。
//     pr-iterate.js 内に workflow() を足すと2段になり throw するので入れないこと。
// ============================================================
const iterate = await workflow('pr-iterate', { pr: pr.pr_number })

return {
  issue: ISSUE,
  worktree: WT,
  branch: setup.branch,
  pr_url: pr.pr_url,
  pr_number: pr.pr_number,
  plan_verdict: planVerdict?.verdict ?? null,
  eval_verdict: evalResult?.verdict ?? null,
  test_green: val?.green ?? null,
  iterate_status: iterate?.status ?? null,
  note: 'merge は手動で行ってください',
}
