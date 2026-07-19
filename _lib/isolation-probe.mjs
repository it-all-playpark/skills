// Isolation probe: dev-flow の Setup phase 完了直後に bg-isolation guard を早期検知する純関数群
// （bg job から dev-flow を起動する際、呼び出し元セッションが自身の cwd を worktree へ isolate
// していないと、harness の bg-isolation guard により implementer の Write/Edit tool 呼び出しが
// 共有チェックアウトへの書き込みとして拒否される。放置すると Implement/Evaluate まで数十 agent
// 分の呼び出しを浪費した後に empty-diff として発覚するため、Setup 完了直後に probe で早期検知する）。
//
// isolationProbePrompt: dev-runner-haiku へ渡す probe prompt を組み立てる純関数
//   （worktree 直下に Write tool で実際に書き込ませ、成否を {written, error} で verbatim 報告させる）。
// isolationFailureMessage: probe が written:false を返した場合の throw メッセージを組み立てる純関数
//   （branch/base/issue を含む復旧手順 — worktree 作成/EnterWorktree/Workflow 再実行 — を返す）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。

export function isolationProbePrompt(worktree) {
  return `worktree ${worktree} 直下に Write tool で \`.devflow-tmp/.isolation-probe\` というファイルを`
    + `内容 "ok" で書き込め。成功したら {"written": true} を返せ。`
    + `Write tool がエラー・拒否を返した場合は、例外を投げずに `
    + `{"written": false, "error": "<エラーメッセージ全文>"} を返せ。`;
}

export function isolationFailureMessage(worktree, branch, base, issue, error) {
  const relWt = worktree.includes('.claude/worktrees/') ? worktree.slice(worktree.indexOf('.claude/worktrees/')) : worktree;
  return `dev-flow: worktree isolation エラー — implementer が ${worktree} に書き込めません`
    + `（bg-isolation guard の可能性: 呼び出し元セッションの cwd がこの worktree へ isolate されていない）。\n`
    + `対処: 呼び出し元セッションで以下を実行してから dev-flow を再起動してください:\n`
    + `  1. git worktree add -b ${branch} ${worktree} origin/${base}（既に存在する場合は不要）\n`
    + `  2. EnterWorktree({ path: "${relWt}" })\n`
    + `  3. Workflow({ name: "dev-flow", args: "${issue}" }) を再実行\n`
    + (error ? `probe error: ${error}` : '');
}
