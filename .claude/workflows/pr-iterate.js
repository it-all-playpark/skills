export const meta = {
  name: 'pr-iterate',
  description: 'PR を review ⇄ fix で LGTM になるまで反復（上限 10）。単体起動も dev-flow からのサブ呼びも可',
  phases: [
    { title: 'Iterate' },
  ],
}

// args 正規化: 単体 /pr-iterate <pr> でも dev-flow からの workflow('pr-iterate', {pr}) でも受ける
const PR = typeof args === 'string' ? args.trim()
  : (args?.pr ?? args?.pr_number ?? args?.[0])
const MAX = Number(args?.max_iterations ?? 10)

if (!PR) throw new Error('pr-iterate: PR number/URL が必要です（args.pr）')

const REVIEW = {
  type: 'object',
  required: ['decision', 'issues', 'summary'],
  properties: {
    decision: { type: 'string', enum: ['approve', 'request-changes', 'comment'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'description'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          file: { type: 'string' },
          line: { type: 'number' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
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

phase('Iterate')

let lastReview = null
let lgtm = false
let i = 0

for (i = 1; i <= MAX; i++) {
  const review = await agent(
    `PR #${PR} を批判的にレビューせよ。gh pr view / gh pr diff で実 diff を確認し、宣言意図に照合する。`,
    { agentType: 'pr-reviewer', schema: REVIEW, label: `review#${i}`, phase: 'Iterate' },
  )
  if (review == null) throw new Error(`pr-iterate: review#${i} が結果を返しませんでした（skip された可能性）`)
  lastReview = review

  if (review.decision === 'approve') {
    lgtm = true
    log(`iteration ${i}: LGTM`)
    break
  }

  const blocking = review.issues.filter((x) => x.severity === 'critical' || x.severity === 'major')
  log(`iteration ${i}: ${review.decision} — blocking ${blocking.length} 件、fix を適用`)

  // pr-fix は portable skill。汎用 workflow agent から Skill 経由で実行する。
  const issuesText = blocking
    .map((x) => `- [${x.severity}] ${x.file ?? ''}${x.line ? ':' + x.line : ''} ${x.description}${x.suggestion ? ' → ' + x.suggestion : ''}`)
    .join('\n')

  // pr-fix は portable skill。Skill を持つ dev-runner agent 経由で実行する。
  await agent(
    `PR #${PR} のレビュー指摘を修正する。次の指摘を解消するため \`Skill: pr-fix ${PR}\` を実行し、`
    + `修正を push まで行え。解消すべき指摘:\n${issuesText}`,
    { agentType: 'dev-runner', schema: FIX, label: `fix#${i}`, phase: 'Iterate' },
  )
}

return {
  pr: PR,
  status: lgtm ? 'lgtm' : 'max_reached',
  iterations: Math.min(i, MAX),
  last_decision: lastReview?.decision ?? null,
  last_summary: lastReview?.summary ?? null,
}
