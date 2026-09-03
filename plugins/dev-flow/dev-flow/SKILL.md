---
name: dev-flow
description: |
  Runs the issue-to-LGTM dev-flow pipeline for a GitHub issue: performs isolation
  preflight (base resolution, worktree creation, EnterWorktree) then launches the
  dev-flow-run dynamic workflow (analyze → plan → implement → validate → evaluate →
  PR → pr-iterate → merge tier). Merge is always human.
  Use when: (1) user asks to implement a GitHub issue end-to-end,
  (2) /dev-flow <issue>, (3) keywords: dev-flow, issue実装, issue→PR, 自動実装.
---

# dev-flow

Issue から LGTM までの pipeline を起動する wrapper skill。orchestration の実体は dynamic
workflow `dev-flow-run`（`plugins/dev-flow/.claude/workflows/dev-flow.js`）が持つ。本 skill は
**isolation preflight**（worktree を先に用意してから Workflow を起動する）を行う。

## なぜ preflight が必要か

bg 起動セッションで、呼び出し元 cwd が共有 checkout のまま `Workflow({ name: 'dev-flow:dev-flow-run' })`
を直接起動すると、Setup phase 直後の isolation probe（worktree 直下 `.devflow-tmp/.isolation-probe`
への Write 検証）が `written:false` となり run 全体が fail-closed abort する。preflight で先に
worktree を作り `EnterWorktree` しておくことで probe が成立する。

## Preflight 手順（issue ごとに 1-4 を実行）

1. **base 解決**: `args.base` が明示されていれば `git ls-remote --heads origin <base>` で
   origin に存在することを検証する（無ければ error で停止し人間に報告）。未指定なら
   `origin/dev` が存在すれば `dev`、無ければ `origin/HEAD` の指す default branch を base とする
   （`dev-flow-run` の Setup phase の resolve-base と同一の優先順位: 明示指定→検証 /
   未指定→origin/dev→origin/HEAD）。
2. **worktree 作成/再利用**: リポジトリルートで `git fetch origin` した後、worktree dir の候補は
   2 つ — 既定 `<repo>/.claude/worktrees/df-<N>`、repo 外 `<repo>-wt/df-<N>`（`<repo>` の
   sibling ディレクトリ。例: `/path/to/repo` に対し `/path/to/repo-wt/df-<N>`）。既定候補が
   存在すればそれを再利用する。既定候補が無ければ repo 外候補を確認し、存在すればそれを
   再利用する（両方存在する場合は既定候補を優先）。どちらも存在しなければ
   `git worktree add -b feature/issue-<N> <repo>/.claude/worktrees/df-<N> origin/<base>`
   を実行する。これが `Operation not permitted` / permission 系エラーで失敗した場合のみ
   `git worktree add -b feature/issue-<N> <repo>-wt/df-<N> origin/<base>` で repo 外へ作成する
   （対象 repo が書き込み不可の場合の退避先。branch `feature/issue-<N>` が既に存在する場合は
   いずれも `-b` を外して既存 branch を checkout）。
   **worktree ディレクトリ名は `df-<N>` 固定**（配置が既定/repo 外いずれでも共通） —
   `dev-flow-run` の Setup phase が両候補を同じ優先順（既定→repo 外）で探索して再利用判定
   するため、別名だと二重 worktree になる。
3. **EnterWorktree**: `EnterWorktree({ path: '<選択した worktree の絶対パス>' })` を実行する。
   手順2 で選ばれた worktree（既定配置・repo 外配置のいずれでも）の絶対パスを渡せば成立する。
   bg 起動セッションからも成立する。
4. **Workflow 起動**: `Workflow({ name: 'dev-flow:dev-flow-run', args: { issue: <N>, base: '<base>' } })`。
   base は手順1で明示指定されていた場合のみ渡す（未指定なら `args: <N>` の bare 形でよい）。

## 直列複数 issue 実行時の worktree 切替

複数 issue を直列に処理する場合は、**issue ごとに手順2-4 を繰り返し**、必ず
`EnterWorktree({ path: '<選択した worktree の絶対パス>' })` で当該 issue の worktree（既定
`<repo>/.claude/worktrees/df-<N>` または repo 外 `<repo>-wt/df-<N>`）へ切り替えてから手順4 の
Workflow を起動する。前 issue の worktree に入ったまま次の issue の Workflow を起動すると、
isolation probe が fail-closed abort する。

## needs_clarification の扱い

`dev-flow-run` が `needs_clarification` を返した場合、AskUserQuestion で人間に確認したうえで、
**同じ worktree を保持したまま**手順4（`Workflow({ name: 'dev-flow:dev-flow-run', ... })`）のみを
再実行する。worktree の作り直しは不要。
