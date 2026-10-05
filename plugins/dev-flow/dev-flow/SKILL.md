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
   `dev-flow-prerun` は base 解決・worktree 作成/再利用・起点一致検証（独自コミット・未コミット変更の無い再利用 worktree は base へ fast-forward）・worktree 直下への
   書き込み probe・`.devflow-tmp` の clean・deps install・issue analyze（`analyze-issue --contract` の
   決定論 parse + Jev 有界判定。deps install と並列）・framework 検出を 1 コマンドで行う。
   `analyze` 段が失敗（GitHub 到達不能 / JSON 不正）しても prerun は `ok:true` のまま
   `analyze.ok:false` + `reason` を返し、`dev-flow-run` が needs_clarification（source=analyze_prerun）で
   人間へ返す。private repo 等で issue 本文を Jev（外部 API）に送りたくない場合は
   `DEVFLOW_JEV_DISABLE=1` を prerun の環境に置く（Jev 判定が要る issue は uncertain として
   needs_clarification に倒れる）。Jev は jev-broker（dotfiles の gui ドメイン LaunchAgent。
   `~/.local/state/jev-broker/jev.sock`）経由で呼ぶ。broker が無い環境では macOS Keychain から鍵を読むが、
   Keychain の解除は監査セッションごとに効くので、sandbox 内の Bash と bg job からは解除済みでも届かない。
   Jev 判定が行われないと該当判定は uncertain になり、その文言には原因（jev-broker に接続できない /
   jev-broker 経由の失敗 / Keychain に届かない / Keychain から API 鍵を読めない / API 鍵が無い /
   タイムアウト / 通信失敗 / 応答不正）と exit code が載る。wrapper は鍵の取得経路を探さず、
   needs_clarification をそのまま人間へ返す（broker の起動や実行環境の調整は人間が判断する。
   「Keychain に届かない」を見て Keychain のロック解除を試しても直らない）。

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

## 完了後の返り値の読み方

`test_green` は Validate の最終 test 結果の `green` そのもので、テストが起動できず 0 件実行
（`tests:'error'`）の run でも `false` になる。本物の red と区別するには次の 2 キーを併せて読む:

- `validate_tests`: Validate の最終 test 状態（`'passed' | 'failed' | 'no_tests' | 'error' | null`）
- `ci_test_verified`: 終端サマリーのテスト欄に使った CI 照合結果（`true | false | null`）。
  Validate が `'error'` かつ Final reconcile が skipped の run だけ、PR head sha に pin した CI check を読んで決まる

`validate_tests === 'error' && ci_test_verified === true` は「ローカルではテスト未実行、同じ head sha の
CI test は green」を意味する。呼び出し元は journal・`gh pr checks`・`gh run view` で再検証せず、
その旨をそのまま報告する。`validate_tests === 'error'` で `ci_test_verified` が `true` でなければ
テストは未検証なので、その旨を報告して CI の確認を人間に委ねる。`validate_tests === 'failed'` は本物の red。

## Implement 経路（全 shape で dev-implementer 一本）

Setup 末尾の analyze ゲート（固有の phase は持たない）は `args.setup.analyze`（prerun の決定論 analyze）を
whitelist 検証して 3 条件ゲート（AC 空 / comment_conflicts 非空 / uncertain 非空）を判定するだけで、
通常経路では agent を起動しない（ゲートが引いたときだけ sonnet を 1 spawn し、人間向けの missing_context を
作って needs_clarification で終端する）。ゲート直後に issue から単一 task の plan を合成するだけ（Plan phase は
持たず、planner 系 agent は起動しない）で、Implement で `dev-implementer`（plan+impl 統合、opus / high）を
1 spawn する。BLOCKED 再実装（`reimpl-blocked#b`）・Validate の green-fix・Evaluate の差し戻し（`reimpl#i`）も
同じ agent への再 spawn。shape（micro / standard / complex）は analyze ゲートでは決めず、Security floor で
realized diff の file 数 + AC 数 / issue_type / 構造化 breaking_change から決定論に決める
（Evaluate の深さ・LITE gate・merge tier の入力）。詳細は `references/pipeline.md` の shape 3 tier 表。

## 直列複数 issue 実行時の worktree 切替

複数 issue を直列に処理する場合は、**issue ごとに手順1-4 を繰り返し**、必ず
`EnterWorktree({ path: '<選択した worktree の絶対パス>' })` で当該 issue の worktree（既定
`<repo>/.claude/worktrees/df-<N>` または repo 外 `<repo>-wt/df-<N>`）へ切り替えてから手順4 の
Workflow を起動する。前 issue の worktree に入ったまま次の issue の Workflow を起動すると、
isolation probe が fail-closed abort する。

## 並列実行（dev-flow-ready-set で波を回す）

1 セッションの中では並列にできない（Workflow tool は top-level 専用、EnterWorktree はセッションに 1 つ）。
issue ごとに別セッションで `/dev-flow <N>` を起動すれば、各 run が自分の `df-<N>` worktree と
`feature/issue-<N>` を持つので並列になる。どれを同時に流してよいかは `dev-flow-ready-set` が決める:

```
dev-flow-ready-set [--repo owner/repo] [--label <label>] [--with-in-flight] [<issue>...]
```

リポジトリルートで bare 名を先頭トークンにして実行する（read-only。issue / PR / label・push・ファイルに
書き込まない）。stdout の 1 行 JSON `{ok, launch, in_flight, waiting}` を次の波で回す:

1. `launch[]` の各 issue を **issue ごとに別セッション**で `launch[].command`（`/dev-flow <N>`）として起動する。
   同時に何本起動するかは人間が決める（launch は「同時に流しても衝突しにくい集合」であって起動本数の指示ではない）
2. 各 run が LGTM に達したら人間が merge する（merge は常に人間）
3. merge 後にもう一度 `dev-flow-ready-set` を実行し、新しい `launch[]` で次の波を起こす。blocker の close や
   in_flight の解消で `waiting[]` / `in_flight[]` にいた issue が launch に上がってくる

分類は closed → 出力しない / `human-task` ラベル → waiting `human_task` / open な blocker → waiting `blocked_by`
（判定は prerun と共有の `_lib/scripts/issue-blockers.sh`）/ open な linked PR・`feature/issue-<N>` の local branch・
worktree → in_flight / それ以外 → ready。ready は番号の昇順に貪欲に選び、in_flight と既に選んだ issue の
変更対象パスと重なるものは waiting `path_conflict` に回す。

- **`--with-in-flight`**: 渡した候補に加え、今走っている他 issue（head が `feature/issue-<N>` の open PR・
  `feature/issue-<N>` の local branch・その branch か `df-<N>` の worktree）を自動で in_flight に入れ、その
  変更対象パスを占有にする。無しでは渡した候補の中しか見ないので、別セッションで実行中の run とのパス衝突は
  検出されない。自動で拾った issue は human-task / blocker を見ずに in_flight とし（実際に走っているので占有
  から漏らさない）、closed は残骸として出力しない。`--with-in-flight` 単独なら実行中の一覧だけを返す
- 相手が `## 変更対象パス` の無い issue で全パスと重なっただけなら、`detail` の番号に `(変更対象パスなし)` が付く。
  その issue に申告を足せば再実行で解ける

- **パス申告は見積もり**: 重なり判定は issue 本文の `## 変更対象パス` だけを見る。実際の diff は申告からはみ出し
  得るので、launch に並んでも衝突しないことの保証にはならない。はみ出しによる衝突は pr-iterate の mergeable
  確認と人間の merge 順で吸収する。判定は誤って並列にするより直列に倒す側に寄せてある（glob は静的 prefix に
  縮めて比べ、`## 変更対象パス` が無い・空の issue は全パスと重なる扱いで、他に何も選ばれていないときだけ単独で
  launch、それ以外は waiting `no_declared_paths`）
- **lockfile は常に衝突扱い**: `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lockb` / `Cargo.lock` /
  `go.sum` / `flake.lock` / `uv.lock` / `poetry.lock` は repo 内のどこにあっても互いに重なりとみなす（依存追加は
  別 issue でも同じ lockfile を書き換え、merge 時に必ず衝突するため）。依存を足す issue は lockfile を申告に含める
- **読み取り失敗は ok:false**: gh の読み取りに失敗すると `{"ok":false,"error":...}` で非 0 終了する（失敗した
  issue を ready に倒さない）。`dev-flow-ready-set` が sandbox の `excludedCommands` に登録されていない環境では
  gh の資格情報が読めず、常にこの経路で止まる

## needs_clarification の扱い

`source: "blocked_by"` は open な blocker（GitHub の issue dependencies と本文の `Blocked by #N` 行。
人手作業の human-task issue など）が残っているための停止で、`missing_context` に未完了 issue の
番号と URL が並ぶ。AskUserQuestion で要件を聞き直さず、その未完了 issue をそのまま人間に提示し、
「完了・close した後に `/dev-flow` を再起動する」よう案内して終える（worktree は保持したまま。
再起動時は下記と同じく手順2 からやり直す）。blocker の読み取りに失敗した場合は
`source: "analyze_prerun"` で止まる（fail-closed）。

それ以外の `needs_clarification` は、AskUserQuestion で人間に確認したうえで、
**同じ worktree を保持したまま手順2 から**やり直す（`dev-flow-prerun` を同じ `--worktree` で
再実行 → 新しい stdout JSON を `setup` として手順4 を起動。手順3 は既に入っているので不要）。
前回の `setup` object を使い回してはならない: isolation probe の token は `setup.epoch` 固定で、
run 内に前回 probe ファイルの cleanup が無いため、同じ epoch で再起動すると Write-only agent が
既存の `.devflow-tmp/.isolation-probe-<epoch>` へ上書きを試みて `written:false` → fail-closed
abort する。`dev-flow-prerun` は再利用経路で `.devflow-tmp` を clean し新しい `epoch` を返すので
衝突しない。
