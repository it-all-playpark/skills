---
name: dev-flow
description: |
  Runs the issue-to-LGTM dev-flow pipeline for a GitHub issue: performs isolation
  preflight (dev-flow-prerun: base resolution, worktree creation, deps install in
  parallel with the deterministic issue analyze (analyze-issue --contract + bounded Jev
  judgement); then EnterWorktree) then launches the dev-flow-run dynamic workflow
  (analyze gate (no LLM spawn on the normal path) → implement → validate → security
  floor (effective shape from the realized diff) → evaluate → PR → pr-iterate → merge
  tier). Merge is always human.
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

1. **worktree パスの決定**: worktree dir の候補は 2 つ — 既定 `<repo>/.claude/worktrees/df-<N>`、
   repo 外 `<repo>-wt/df-<N>`（`<repo>` の sibling ディレクトリ。例: `/path/to/repo` に対し
   `/path/to/repo-wt/df-<N>`）。既定候補が存在すればそれを使う。既定候補が無ければ repo 外候補が
   存在すればそれを使う。どちらも存在しなければ既定候補を使う。**worktree ディレクトリ名は
   `df-<N>` 固定**（配置が既定/repo 外いずれでも共通）。

2. **prerun 実行**: リポジトリルート（launch dir）で Bash 1 コマンドとして
   `dev-flow-prerun --issue <N> --worktree <手順1で決めた絶対パス>` を実行する（`args.base` を
   明示する場合のみ `--base <ref>` を付ける）。前置形（`cd X && ...` / `VAR=x ...` /
   `bash <path>` 等）は使わず、bare 名を先頭トークンにする。stdout の JSON 1 行をそのまま
   保持する（`{ok, issue, base, worktree, worktree_status, deps, stack, analyze, epoch, ...}`）。
   `dev-flow-prerun` は base 解決・worktree 作成/再利用・起点一致検証・worktree 直下への
   書き込み probe・`.devflow-tmp` の clean・deps install・issue analyze（`analyze-issue --contract` の
   決定論 parse + Jev 有界判定。deps install と並列）・framework 検出を 1 コマンドで行う。
   `analyze` 段が失敗（GitHub 到達不能 / JSON 不正）しても prerun は `ok:true` のまま
   `analyze.ok:false` + `reason` を返し、`dev-flow-run` が needs_clarification（source=analyze_prerun）で
   人間へ返す。private repo 等で issue 本文を Jev（外部 API）に送りたくない場合は
   `DEVFLOW_JEV_DISABLE=1` を prerun の環境に置く（Jev 判定が要る issue は uncertain として
   needs_clarification に倒れる）。

   結果に応じて分岐する:

   (a) `ok:true` → 手順3 へ進む。

   (b) `worktree_status:"unwritable"`（`worktree_error` に `Permission denied` /
   `Operation not permitted` 等の permission 文言が載る）: 対象 repo の checkout 先が
   書き込み不可の場合の退避。`worktree_removed:true` なら、`--worktree <repo>-wt/df-<N>`
   （repo 外候補）を付けて手順2 をもう一度だけ実行する（作成直後の worktree は
   `dev-flow-prerun` が既に remove 済みなので二重 checkout にならない）。`worktree_removed:false`
   （既存 worktree を再利用したが書けない）なら、そこで停止し `git worktree remove <path>` を
   実行してから再実行するよう人間に報告する。

   (c) それ以外の `ok:false`: `base_error` / `worktree_error` を verbatim で人間に報告して
   停止する（fallback で worktree を自前作成しない）。

   `deps.ok:false` / `clean.ok:false` / `stack.error` / `analyze.ok:false` は advisory なので停止しない
   （Workflow 起動後、run 内で implementer への警告 / needs_clarification として扱われる）。

3. **EnterWorktree**: `EnterWorktree({ path: '<prerun 出力の worktree>' })` を実行する。
   bg 起動セッションからも成立する。

4. **Workflow 起動**: `Workflow({ name: 'dev-flow:dev-flow-run', args: { issue: <N>, setup: <手順2の
   stdout JSON を parse した object> } })`。`setup` は加工・要約・キー削除をせずそのまま渡す。
   `args.base` は渡さない（base は `dev-flow-prerun` が解決済みで、渡すと `dev-flow-run` が
   即 throw する）。

## Implement 経路（全 shape で dev-implement-fable 一本）

Analyze は `args.setup.analyze`（prerun の決定論 analyze）を whitelist 検証して 3 条件ゲート
（AC 空 / comment_conflicts 非空 / uncertain 非空）を判定するだけで、通常経路では agent を起動しない
（ゲートが引いたときだけ sonnet を 1 spawn し、人間向けの missing_context を作って needs_clarification
で終端する）。Analyze 直後に issue から単一 task の plan を合成するだけ（Plan phase は持たず、planner 系
agent は起動しない）で、Implement で `dev-implement-fable`（plan+impl 統合、fable / high）を 1 spawn する。
BLOCKED 再実装（`reimpl-blocked#b`）・Validate の green-fix・Evaluate の差し戻し（`reimpl#i`）も同じ
agent への再 spawn。shape（micro / standard / complex）は Analyze では決めず、Security floor で
realized diff の file 数 + AC 数 / issue_type / 構造化 breaking_change から決定論に決める
（Evaluate の深さ・LITE gate・merge tier の入力）。詳細は `references/pipeline.md` の shape 3 tier 表。

## 直列複数 issue 実行時の worktree 切替

複数 issue を直列に処理する場合は、**issue ごとに手順1-4 を繰り返し**、必ず
`EnterWorktree({ path: '<選択した worktree の絶対パス>' })` で当該 issue の worktree（既定
`<repo>/.claude/worktrees/df-<N>` または repo 外 `<repo>-wt/df-<N>`）へ切り替えてから手順4 の
Workflow を起動する。前 issue の worktree に入ったまま次の issue の Workflow を起動すると、
isolation probe が fail-closed abort する。

## needs_clarification の扱い

`dev-flow-run` が `needs_clarification` を返した場合、AskUserQuestion で人間に確認したうえで、
**同じ worktree を保持したまま手順2 から**やり直す（`dev-flow-prerun` を同じ `--worktree` で
再実行 → 新しい stdout JSON を `setup` として手順4 を起動。手順3 は既に入っているので不要）。
前回の `setup` object を使い回してはならない: isolation probe の token は `setup.epoch` 固定で、
run 内に前回 probe ファイルの cleanup が無いため、同じ epoch で再起動すると Write-only agent が
既存の `.devflow-tmp/.isolation-probe-<epoch>` へ上書きを試みて `written:false` → fail-closed
abort する。`dev-flow-prerun` は再利用経路で `.devflow-tmp` を clean し新しい `epoch` を返すので
衝突しない。
