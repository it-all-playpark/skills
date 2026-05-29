// pr-review subagent 縦切り PoC — agentType 本検証用 Workflow script
//
// 次セッションでの本検証手順:
//   1. このブランチ (worktree-pr-review-wf-poc) を含むセッションを開始
//      (= .claude/agents/pr-reviewer.md がセッション開始時に登録される)
//   2. Workflow({ scriptPath: "claudedocs/pr-review-wf-poc.js", args: <PR番号> })
//   3. agentType:'pr-reviewer' が解決され、subagent frontmatter の
//      model:opus + effort:max が継承されるかを確認する
//
// 注: 同一セッションで pr-reviewer.md を新規作成しても agentType は解決できない
//     (subagent はセッション開始時に登録されるため)。必ず再読み込み後に走らせること。

export const meta = {
  name: 'pr-review-poc',
  description: 'pr-review subagent 縦切り PoC — pr-reviewer subagent で PR をレビューし構造化判定を返す',
  phases: [
    { title: 'Review', detail: 'pr-reviewer subagent が PR diff をレビューし {decision, issues, summary} を返す', model: 'opus' },
  ],
}

const pr = args
if (!pr) throw new Error('args に PR 番号が必要 (例: args: 113)')

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['approved', 'request-changes', 'comment'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          message: { type: 'string' },
        },
        required: ['file', 'severity', 'message'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['decision', 'issues', 'summary'],
}

phase('Review')
const review = await agent(
  `## Objective
GitHub PR #${pr} の変更差分をレビューし、単一の判定を構造化して返す。レビュー送信(submit)はしない。

## 手順
1. \`gh pr view ${pr} --json number,title,body,headRefName,baseRefName\` で PR メタを取得
2. \`gh pr diff ${pr}\` で差分を取得
3. 差分を systematically にレビュー（セキュリティ / アーキテクチャ・SOLID / エッジケース・エラーハンドリング / テストカバレッジ）
4. decision を approved / request-changes / comment から1つ決定

## Output
{decision, issues:[{file, line?, severity, message}], summary}。message と summary は日本語。

## Tools
- 使用可: Read, Grep, Glob, Bash(gh pr view / gh pr diff の読み取りのみ)
- 禁止: gh pr review(送信), git commit/push, ファイル編集, ネットワーク書込

## Boundary
- PR 差分範囲のみ対象。PR 外ファイルへの指摘禁止。作業ツリー書換・main/dev操作・submit 禁止。subagent を spawn しない。

## Token cap
1500 語以内、issues 最大 20 件`,
  { agentType: 'pr-reviewer', schema: REVIEW_SCHEMA, label: `review:pr-${pr}`, phase: 'Review' }
)

log(`PR #${pr}: decision=${review.decision}, issues=${review.issues.length}`)
return { pr, ...review }
