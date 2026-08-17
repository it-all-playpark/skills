// Isolation probe: dev-flow の Setup phase 完了直後に bg-isolation guard を早期検知する純関数群
// （bg job から dev-flow を起動する際、呼び出し元セッションが自身の cwd を worktree へ isolate
// していないと、harness の bg-isolation guard により implementer の Write/Edit tool 呼び出しが
// 共有チェックアウトへの書き込みとして拒否される。放置すると Implement/Evaluate まで数十 agent
// 分の呼び出しを浪費した後に empty-diff として発覚するため、Setup 完了直後に probe で早期検知する）。
//
// isolationCleanupPrompt: probe の直前に run 専用 scratch `.devflow-tmp/`（gitignored）を除去させる
//   prompt を組み立てる純関数（前 run の残置物を持ち越さない）。
// isolationProbePrompt: dev-runner-haiku へ渡す probe prompt を組み立てる純関数
//   （worktree 直下に Write tool で実際に書き込ませ、成否を {written, error} で verbatim 報告させる）。
// isolationFailureMessage: probe が written:false を返した場合の throw メッセージを組み立てる純関数
//   （branch/起点 ref/workflow 名・args を含む復旧手順 — worktree 作成/EnterWorktree/Workflow 再実行 — を返す）。
//   呼び出し元（dev-flow.js / pr-iterate.js）ごとに workflow 名・再実行 args・回避手順で提示する
//   worktree 先（targetPath）・新規 worktree の起点 ref（startRef）が異なるため、いずれも呼び出し元が
//   明示的に渡す必須引数にする（デフォルト値による暗黙の workflow 名混同を避ける — issue #455 レビュー指摘）。
//   startRef は `origin/<ref>` 等の完全な ref 式を受け取る（関数側で origin/ を補わない）。
//   dev-flow は未実装 issue の作業を base から始めるため `origin/<base>`、pr-iterate は既存 PR の
//   head を再現する必要があるため `origin/<head_ref>` を渡す（base 起点だと PR の変更を含まない
//   worktree を提示してしまう — issue #455 レビュー指摘）。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で workflow へ全文 inline 生成される。
// 直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。
// 制約: ESM import / require / Date.now / Math.random を含めない。export function / export const のみ。
//
// 前 run が残した stale な `.devflow-tmp/.isolation-probe` が存在すると、Write tool の
// 「既存ファイルは同一セッション内で Read 済みでないと上書き拒否」挙動により isolation が正常でも
// written:false → fail-closed abort する（issue #482）。この残置物の除去は probe 実行前の
// isolationCleanupPrompt が担い（除去対象は worktree 内 gitignored の `.devflow-tmp/` に限定）、
// probe prompt 自体は Write 1 回だけの最小契約に保つ（issue #493）。
//
// 不変条件: 本ファイルが生成する prompt / メッセージは、実行制御の名称（sandbox・permission・
// excludedCommands・guard 等）を「だからこの経路を使え」という形の理由として述べない。
// 転写契約に判断余地を持ち込ませないための規範であり、`.claude/rules/dev-flow.md` の exec-proxy 節が
// 正典。canonical と 2 つの inline 生成区間の双方を _lib/isolation-control-reason.test.mjs が pin する。

export function isolationCleanupPrompt(worktree) {
  return `worktree ${worktree} の run 専用 scratch ディレクトリ \`.devflow-tmp\`（gitignored）を除去せよ。手順:\n`
    + `1. \`git -C ${worktree} clean -fdx -- .devflow-tmp\` を 1 回だけ実行する`
    + `（\`.devflow-tmp\` が存在しない場合もこのコマンドは成功する）\n`
    + `2. 成功したら {"cleaned": true} を返せ。\n`
    + `コマンドがエラーを返した場合は、例外を投げずに `
    + `{"cleaned": false, "error": "<エラーメッセージ全文>"} を返せ。\n`
    + `\`.devflow-tmp\` 以外のパスには触れるな。`;
}

export function isolationProbePrompt(worktree) {
  return `worktree ${worktree} 直下に Write tool で \`.devflow-tmp/.isolation-probe\` というファイルを`
    + `内容 "ok" で書き込め。`
    + `成功したら {"written": true} を返せ。`
    + `Write tool がエラー・拒否を返した場合は、例外を投げずに `
    + `{"written": false, "error": "<エラーメッセージ全文>"} を返せ。`;
}

export function isolationFailureMessage({ worktree, branch, startRef, workflowName, workflowArgs, targetPath, error }) {
  const wt = targetPath || worktree;
  const relWt = wt.includes('.claude/worktrees/') ? wt.slice(wt.indexOf('.claude/worktrees/')) : wt;
  return `${workflowName}: worktree isolation エラー — implementer が ${worktree} に書き込めません`
    + `（bg-isolation guard の可能性: 呼び出し元セッションの cwd がこの worktree へ isolate されていない）。\n`
    + `対処: 呼び出し元セッションで以下を実行してから ${workflowName} を再起動してください`
    + `（新しい worktree には前 run の残置物が無いため、残置物が原因だった場合も同時に解消します）:\n`
    + `  1. git worktree add -b ${branch} ${wt} ${startRef}\n`
    + `     （branch ${branch} がローカルに既存なら -b と起点を外して \`git worktree add ${wt} ${branch}\`、`
    + `さらに他 worktree で checkout 済みなら \`git worktree add --force ${wt} ${branch}\`、`
    + `worktree ${wt} 自体が既存なら本手順ごと不要）\n`
    + `  2. EnterWorktree({ path: "${relWt}" })\n`
    + `  3. Workflow({ name: "${workflowName}", args: "${workflowArgs}" }) を再実行\n`
    + (error ? `probe error: ${error}` : '');
}
