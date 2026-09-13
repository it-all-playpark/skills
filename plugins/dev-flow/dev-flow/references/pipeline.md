# dev-flow パイプライン詳細

phase 経路 / shape 3 tier / lite route / subagent の model・effort 割り当て / isolation probe /
gate_policy・block_class の詳細。不変条件は `.claude/rules/dev-flow.md` を参照。
本文中の `.claude/workflows/` / `agents/` / `_lib/` / `_shared/` は `plugins/dev-flow/` を root とする
plugin 相対パス。`tools/sync-inlines.mjs` のみ repo root。

## dev-flow (dynamic workflow)

`/dev-flow <issue>` は skill wrapper (`dev-flow/SKILL.md`) が `dev-flow-prerun --issue <N>
--worktree <path>`（top-level Bash、bare 形）で base 解決・worktree 作成/再利用・起点検証・
書き込み probe・`.devflow-tmp` clean・deps install・framework 検出を 1 コマンドで行い、stdout
JSON を `Workflow({ args: { issue, setup } })` の `args.setup` に渡してから `EnterWorktree` する。
dev-flow-run の Setup phase は `args.setup` を fail-closed に検証し、subagent 起動は
isolation-probe の 1 回のみ。orchestration (phase 遷移 / plan-review・evaluate・pr-iterate の
各ループ / 並列実装の fan-out) は workflow script が JS で保持し、中間 state は script 変数に
持つ (外部 state JSON は持たない)。workflow の `meta.name` は `dev-flow-run` だが、telemetry
handoff の `skill` キーは `'dev-flow'` のまま据え置く（集計連続性の不変条件、静的テストで pin 済み）。

```
/dev-flow <issue>   → [wrapper preflight] → Setup → Analyze(shape 判定) → Plan
                      → Implement(serial/parallel) → Validate(test green)
                      → Evaluate → PR → workflow('pr-iterate')
                      → Final reconcile(fixes_applied>0 のみ) → Merge tier
/pr-iterate <pr>    → review ⇄ fix loop (LGTM まで, 上限10)。単体起動可
```

`/pr-iterate <pr>` を単体起動する際の Workflow 名は `dev-flow:pr-iterate`（namespaced 名。bare 名
`pr-iterate` へのフォールバックは無い）。

Merge tier を pr-iterate の後に置くのは、fix 適用後の最終 tree に対して danger-grep 再実行・danger 再
reconcile を行い、merge 判定を最新の PR 内容に基づかせるため。pr-iterate が fix を適用した run では
Final reconcile phase が worktree を PR 最終 HEAD へ同期し test suite を一発再実行する（red / 再検証
不能は merge tier HOLD。fixes_applied=0 は agent 呼び出しゼロで skip）。再検証不能時は PR head sha に
pin した CI check の決定論判定で代替し、成立しなければ HOLD を維持する。

shape ごとの経路（3 tier）:

| shape | Plan 経路 | Evaluate 経路 | merge tier |
|-------|-----------|---------------|------------|
| **micro** | plan 1 発・plan-reviewer 0 回（triviality gate で review loop skip） | skip（evaluator 0 回）。ただし danger-grep hit 時は security path で強制実行 | docs・test-only + danger clean + 収束なら AUTO 推奨ラベル（merge は人間） |
| **standard** | plan 1 発・plan-reviewer 0 回 | 1 パスのみ（差し戻しなし。未解消 critical は merge tier HOLD + human review で担保） | REVIEW |
| **complex** | dev-planner ⇄ plan-reviewer の review loop（上限 PLAN_MAX=8、topic-stuck 検出で early-cutoff あり） | 差し戻し loop（上限 EVAL_MAX=10） | REVIEW、danger・breaking で HOLD |

shape は Analyze phase で `classifyShape` が判定し、安全 floor を適用する（`estimated_change_file_count`
欠落・`acceptance_criteria` 欠落・out-of-enum `issue_type`・breaking 検出 → complex floor）。実装後は
realized diff のファイル数で `refloorShape` が再判定（EFFECTIVE_SHAPE、raise-only）。danger-grep hit が
あれば micro でも Evaluate を強制実行（security path）。

**micro lite route**: `TRIVIAL && !state.runEval && state.dangerHits.length === 0`（clean-micro かつ
contract 準拠かつ danger clean）を満たす run は、PR phase で plan 1 発 → implementer → targeted test →
PR → pr-reviewer 1-pass の縮約経路（lite route、判断系 agent 呼び出し ≤10）を通る。lite の pr-reviewer
1-pass が `review==null || blocking.length>0`（critical/major finding あり）を検出した場合のみ
`workflow('pr-iterate')` フル loop へ自動昇格し、以降は通常の review⇄fix 経路で処理する。danger-grep
hit で `runEval=true` になったケースは lite ゲート条件を満たさないため lite に入らず、micro であっても
現行の security path（Evaluate 強制実行）へ強制昇格する（軸A invariant 不変）。

- **`agent()` へ渡す agentType は plugin namespace 必須** — subagent の実体は plugin 配下
  (`plugins/dev-flow/agents/`) にあり、harness は `dev-flow:<name>` の namespaced id でしか解決しない
  (bare 名は `agent type '<name>' not found` で run 全体が起動直後に abort する)。workflow 本体・
  `subagent_invocations` の by_type キー・agent 名を静的検査する routing test は論理名 (bare) を保持し、
  namespace は `agent()` を呼ぶ直前の `nsAgentOpts()` (canonical `_lib/agent-namespace.mjs`。dev-flow.js /
  pr-iterate.js / dev-improve.js へ inline 生成) でのみ付与する。dev-flow-canary.js は inline bridge 非依存
  (self-contained) を保つため例外で、namespaced id を直接書く。新しい call site はこの経路に乗せる。
- **判断系 leaf は subagent** (`.claude/agents/{dev-planner,plan-reviewer,implementer,evaluator,pr-reviewer,dev-runner,dev-runner-haiku,dev-runner-haiku-ro}.md`)。
  workflow の `agent()` opts には effort が記載されているが、本 harness での適用可否は未検証（dev-flow-canary の opts 受理 probe — capability id `agent_opts_effort_accepted` — で再判定する。probe は受理されたことしか判定できない）。それまで effort は subagent frontmatter で固定する。
  model は frontmatter を既定としつつ `agent()` の `opts.model` で per-call override できる —
  品質ゲート系 4 agent（dev-planner / plan-reviewer / evaluator / pr-reviewer、frontmatter 既定 opus）は
  `_lib/quality-model.mjs` の `QUALITY_MODEL` 定数で一括指定する（tools/sync-inlines.mjs で
  dev-flow.js / pr-iterate.js へ inline 生成。戻すときは `_lib/quality-model.mjs` の 1 行を
  `'opus'` に変更し `tools/sync-inlines.mjs --write` を実行 — 先頭トークン=スクリプトパスの bare 形。
  shebang + 実行bit 付与済みで、sandbox excludedCommands は先頭トークンでマッチするため
  node/cd/bash 前置は付けない）。
  `_lib/plugin-version.mjs` の `PLUGIN_VERSION` も同じ inline 生成方式（dev-flow.js / pr-iterate.js）。
  model を恒久的に別系統へ固定したい leaf には専用 agent 定義
  （例: `dev-runner-haiku.md`、`model: haiku`）を用意し `agentType` を切り替える。
  品質ゲート系 4 agent は `effort: high`（max と精度同等で高速）、implementer / dev-runner は
  `effort: high`、dev-runner-haiku / dev-runner-haiku-ro は `effort: low`（mechanical exec-proxy は
  low が high に schema 成功率で劣後しない）。
- **1 issue = 1 PR**。並列実装は単一 worktree 内で file-disjoint な task を `pipeline()` で fan-out する。
- **merge は手動** (LGTM 後にユーザーが merge)。
- worktree の後片付けは `_shared/scripts/worktree-teardown.sh <worktree-path>` を使う
  (`git worktree remove` 直打ちは `.veridelta/runs/*.json` の red→green 検証証跡を失う)。
  archive の fail-open 仕様・sandbox 実行文脈の制約は同スクリプトと
  `_shared/scripts/veridelta-archive.sh` のヘッダコメントが正典。
- **bg-isolation guard と isolation probe**: bg 起動セッションが呼び出し元 cwd を worktree へ
  isolate しないまま dev-flow / pr-iterate を起動すると、harness の bg-isolation guard が
  subagent の Write/Edit を共有 checkout への書き込みとして拒否する。dev-flow は Setup phase
  （issue #641 以降、Setup の唯一の agent 呼び出し）、pr-iterate は review loop 進入前（fix stage
  不到達の保証）に probe を配置する。probe は worktree 直下 `.devflow-tmp/.isolation-probe-<token>`
  （token は run 毎に一意 — dev-flow は wrapper（dev-flow-prerun、top-level Bash）が渡す
  `args.setup.epoch`（`date +%s`、必須キーのため fallback 経路は無い）、pr-iterate は
  単体起動時 pr-meta probe の epoch（fallback: PR 番号）、nested 起動（dev-flow →
  `workflow('pr-iterate')`）時は dev-flow が `args.nested.epoch`（PR phase の commit+PR 応答 epoch）で
  供給し pr-meta probe 自体を起動しない。
  `Date.now()` / `Math.random()` は canonical の generator 制約上使わない）への Write で
  isolation 成立を検証する。probe agent は
  tools を `[Write]` のみに絞った専任 agent `dev-runner-haiku-wo`
  （model: haiku, effort: low, maxTurns: 5）— Write 以外の経路（Bash リダイレクト等）では
  ファイルを作れないため、「implementer と同じ Write tool 経路の検証」という probe の意味が
  harness レベルで保証される。`written:false` は fail-closed（確定回避手順つき throw）で、
  throw メッセージは決定論の error 文字列分類（`isolationErrorKind`: `overwrite_refused`
  / `isolation` / `unknown`）で「isolation 不成立」と「その他の書き込み失敗（前 run の残置物への
  上書き拒否等）」を区別して報告する — fail-closed（throw）自体は全分類で不変。回避手順は
  1. 書き込みに失敗した cwd とは別の worktree を `git worktree add`、2. `EnterWorktree({path})`、
  3. Workflow 再実行（dev-flow は `dev-flow-prerun --issue <N> --worktree <path>` の stdout JSON を
  `args.setup` に渡し直す）。probe 自体の失敗（null）は fail-open（警告 log のみ）で扱う。
  canonical は `_lib/isolation-probe.mjs` の `isolationCleanupPrompt` / `isolationProbePrompt`
  （token 引数必須。関数側にデフォルトを置かず呼び出し元が明示的に渡す） / `isolationFailureMessage` を
  dev-flow.js・pr-iterate.js 双方へ inline 生成して流用する（両 workflow で同一の文言・手順を
  使うためのもので、片側専用の canonical 関数は追加しない）。
  probe の直前の cleanup は dev-flow / pr-iterate で経路が分かれる。**dev-flow は wrapper の
  prerun が run 開始前に `.devflow-tmp` 全体を `git clean -fdx` 済み**（agent 呼び出しではなく
  決定論スクリプト内で完結する）——前 run の残置物（probe artifact / journal payload / ui-verify
  state 等）の持ち越し防止（run 間衛生）を prerun が担う。**pr-iterate は単体起動時のみ**
  canonical `_lib/isolation-probe.mjs` の exported 定数 `ISOLATION_PROBE_CLEANUP_GLOB`
  （`.devflow-tmp/.isolation-probe*`。probe の token 形ファイル名 `.isolation-probe-<token>` と
  legacy 無 token 形の両方にマッチする）を対象に isolation-cleanup subagent 呼び出しで cleanup を
  実行する — nested 起動（dev-flow → `workflow('pr-iterate')`）では probe 対象が実行中 dev-flow
  run の worktree 自身になり、`.devflow-tmp` 全体を消すと当該 run が既に書いた run 専用 scratch
  （journal payload 等の `.devflow-tmp` 配下生成物）を run 途中で失うため、pr-iterate 側の
  isolation-cleanup 呼び出しを skip する（dev-flow 側の prerun cleanup が同一 worktree の run 間衛生を
  既に担保済みのため、nested run でも二重に走らせる必要がない）。
  isolation-probe（Write 検証本体）は nested でも skip しない。pr-iterate 側 cleanup は fail-open
  （失敗しても一意パス化により直後の probe は通常どおり成立する）。
  probe prompt / throw メッセージは、実行制御の名称（sandbox・permission・excludedCommands・guard 等）を
  「だからこの経路を使え」という形の理由として述べない — exec-proxy 節の規範と同一で、canonical と
  2 つの inline 生成区間の双方を `_lib/isolation-control-reason.test.mjs` が pin する。
  失敗の診断としての `bg-isolation guard の可能性` は別（何が起きたかの説明であり経路指示ではない）。
  (a) `EnterWorktree({path})` は bg 起動セッションからも成立する — repo 内
  `.claude/worktrees/`（throw メッセージが提示する既定の先）・repo 外 worktree の双方で実測済み。
  したがって bg 経由でも上記の確定回避手順が正規経路として機能する。
  (b) `worktree.bgIsolation:"none"` 設定による guard 無効化は採らない —
  guard は共有 checkout への意図しない書き込みを防ぐ safety であり、設定で無効化すると
  保護ごと失われる（W7 分類: blast-radius。共有 checkout 汚染は blast-radius が大きく、
  guard 緩和ではなく fail-closed 検知 + 正規 isolation 経路で解決する。設定緩和による
  sunset はしない）。
- Claude 専用 (workflow 依存)。cross-vendor portability は dev-flow / pr-iterate のみ放棄する例外扱い。
- **gate_policy**: trust 昇順の 4 値 enum — `deterministic-only` / `llm-major-advisory`（既定）/ `llm-major-blocking` / `llm-autonomous`。
  **軸A invariant 不変** — deterministic oracle / seed / critical アイテムは全 policy で blocking のまま（security floor / 決定論ゲートは policy で緩めない）。
  **既定同一挙動** — 既定 `llm-major-advisory` は軸A invariant（critical / deterministic / seed = blocking）+ LLM major/minor = advisory の既定 lane 分類と全アイテムで一致し、非 default policy のみ gating が変わる（enum で境界を滑らせる設計）。
  out-of-enum 値は明示 error（legacy fallback / version 分岐なし）。canonical は `_lib/gate-policy.mjs`、dev-flow.js への inline は tools/sync-inlines.mjs で生成・`_lib/workflow-inlines.sync.test.mjs` が全文一致保証。
- **block_class**: implementer 返り値 `status:'BLOCKED'` の `blocking_reason` は閉じた 2 値 enum
  `approach_mismatch` / `guard_blocked` を持つ構造化 object（`{block_class, detail, guard_id}`）で、
  string（free text）は受理せず schema error になる。`guard_blocked` は guard/hook 由来の BLOCKED
  （inline-edit-guard deny / sandbox EPERM / safety classifier block / bg-isolation 等）を指し、
  Implement phase の replan ループ（blockSeen 登録・`approach_mismatch` findings 化・dev-planner
  再呼出し）から除外され、blockedConcerns 経由で evaluator focus へ直行する。out-of-enum の
  `block_class` は明示 error（legacy fallback / version 分岐なし）。canonical は
  `_lib/block-routing.mjs`、dev-flow.js への inline は tools/sync-inlines.mjs で生成する。
