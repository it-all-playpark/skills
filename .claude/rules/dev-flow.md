---
description: dev-flow / pr-iterate / dev-improve の内部仕様（phase 経路・shape 判定・distrust 正当化クラス W7・指示規範性 (prescription) の正当化クラス・inline 生成区間・exec-proxy 失敗ポリシー・telemetry キー）
paths:
  - ".claude/workflows/**"
  - ".claude/agents/**"
  - "_lib/**"
  - "tools/**"
  - "dev-flow-doctor/**"
  - "dev-flow-improve/**"
  - "dev-flow/**"
---

# dev-flow / dev-improve 内部仕様

このファイルは dev-flow 本体（workflow / agent 定義 / `_lib` canonical / generator）を触るときだけ
読み込まれる。全プロジェクト共通の規約は `AGENTS.md` を参照。

dev-flow は **Claude 専用**（workflow 依存）であり、cross-vendor portability を放棄する唯一の例外扱い
のため、本ファイルは `AGENTS.md`（agents.md 標準の cross-vendor 文書）から分離して配置している。

## dev-flow (dynamic workflow)

`/dev-flow <issue>` は skill wrapper (`dev-flow/SKILL.md`) が isolation preflight
（base 解決 → `<repo>/.claude/worktrees/df-<N>` への `git worktree add` による worktree 作成・再利用 →
`EnterWorktree({path})`）を行ってから dynamic workflow `Workflow({ name: 'dev-flow-run' })`
(`.claude/workflows/dev-flow.js`) を起動する。orchestration (phase 遷移 / plan-review・evaluate・
pr-iterate の各ループ / 並列実装の fan-out) は workflow script が JS で保持し、中間 state は script
変数に持つ (外部 state JSON は持たない)。workflow の `meta.name` は `dev-flow-run` だが、telemetry
handoff の `skill` キーは `'dev-flow'` のまま据え置く（集計連続性の不変条件、静的テストで pin 済み）。

```
/dev-flow <issue>   → [wrapper preflight] → Setup → Analyze(shape 判定) → Plan
                      → Implement(serial/parallel) → Validate(test green)
                      → Evaluate → PR → workflow('pr-iterate')
                      → Final reconcile(fixes_applied>0 のみ) → Merge tier
/pr-iterate <pr>    → review ⇄ fix loop (LGTM まで, 上限10)。単体起動可
```

Merge tier を pr-iterate の後に置くのは、fix 適用後の最終 tree に対して danger-grep 再実行・danger 再 reconcile を行い、merge 判定を最新の PR 内容に基づかせるため。pr-iterate が fix を適用した run では Final reconcile phase が worktree を PR 最終 HEAD へ同期し test suite を一発再実行する（red / 再検証不能は merge tier HOLD。fixes_applied=0 は agent 呼び出しゼロで skip）。

shape ごとの経路（3 tier）:

| shape | Plan 経路 | Evaluate 経路 | merge tier |
|-------|-----------|---------------|------------|
| **micro** | plan 1 発・plan-reviewer 0 回（triviality gate で review loop skip） | skip（evaluator 0 回）。ただし danger-grep hit 時は security path で強制実行 | docs・test-only + danger clean + 収束なら AUTO 推奨ラベル（merge は人間） |
| **standard** | plan 1 発・plan-reviewer 0 回 | 1 パスのみ（差し戻しなし。未解消 critical は merge tier HOLD + human review で担保） | REVIEW |
| **complex** | dev-planner ⇄ plan-reviewer の review loop（上限 PLAN_MAX=8、topic-stuck 検出で early-cutoff あり） | 差し戻し loop（上限 EVAL_MAX=10） | REVIEW、danger・breaking で HOLD |

shape は Analyze phase で `classifyShape` が判定し、安全 floor を適用する（`estimated_change_file_count` 欠落・`acceptance_criteria` 欠落・out-of-enum `issue_type`・breaking 検出 → complex floor）。実装後は realized diff のファイル数で `refloorShape` が再判定（EFFECTIVE_SHAPE、raise-only）。danger-grep hit があれば micro でも Evaluate を強制実行（security path）。

**micro lite route**: `TRIVIAL && !state.runEval && state.dangerHits.length === 0`（clean-micro かつ contract 準拠かつ danger clean）を満たす run は、PR phase で plan 1 発 → implementer → targeted test → PR → pr-reviewer 1-pass の縮約経路（lite route、判断系 agent 呼び出し ≤10）を通る。lite の pr-reviewer 1-pass が `review==null || blocking.length>0`（critical/major finding あり）を検出した場合のみ `workflow('pr-iterate')` フル loop へ自動昇格し、以降は通常の review⇄fix 経路で処理する。danger-grep hit で `runEval=true` になったケースは lite ゲート条件を満たさないため lite に入らず、micro であっても現行の security path（Evaluate 強制実行）へ強制昇格する（軸A invariant 不変）。

- **判断系 leaf は subagent** (`.claude/agents/{dev-planner,plan-reviewer,implementer,evaluator,pr-reviewer,dev-runner,dev-runner-haiku,dev-runner-haiku-ro}.md`)。
  workflow の `agent()` には effort 引数が無いため、effort は subagent frontmatter で固定する。
  model は frontmatter を既定としつつ `agent()` の `opts.model` で per-call override できる —
  品質ゲート系 4 agent（dev-planner / plan-reviewer / evaluator / pr-reviewer、frontmatter 既定 opus）は
  `_lib/quality-model.mjs` の `QUALITY_MODEL` 定数で一括指定する（tools/sync-inlines.mjs で
  dev-flow.js / pr-iterate.js へ inline 生成。現在 `fable` 試験運用中。戻すときは
  `_lib/quality-model.mjs` の 1 行を `'opus'` に変更し `tools/sync-inlines.mjs --write` を実行 —
  先頭トークン=スクリプトパスの bare 形。shebang + 実行bit 付与済みで、sandbox excludedCommands は
  先頭トークンでマッチするため node/cd/bash 前置は付けない）。
  model を恒久的に別系統へ固定したい leaf には専用 agent 定義
  （例: `dev-runner-haiku.md`、`model: haiku`）を用意し `agentType` を切り替える。
  品質ゲート系 4 agent は `effort: high`
  （A/B 実測で max と精度同等・約21%高速）、implementer / dev-runner は `effort: high`、
  dev-runner-haiku / dev-runner-haiku-ro は `effort: low`（issue #323 の A/B 実測 —
  claudedocs/2026-07-12-issue-323-exec-proxy-effort-ab.md。mechanical exec-proxy は
  low が high に schema 成功率で劣後しないことを実測）。
- **1 issue = 1 PR**。並列実装は単一 worktree 内で file-disjoint な task を `parallel()` で fan-out する
  (旧 child-split / DAG / integration branch / batch loop は廃止)。
- **merge は手動** (LGTM 後にユーザーが merge)。
- worktree の後片付けは `_shared/scripts/worktree-teardown.sh <worktree-path>` を使う
  (`git worktree remove` 直打ちは `.veridelta/runs/*.json` の red→green 検証証跡を失う)。
  archive の fail-open 仕様・sandbox 実行文脈の制約は同スクリプトと
  `_shared/scripts/veridelta-archive.sh` のヘッダコメントが正典。
- **bg-isolation guard と isolation probe**: bg 起動セッションが呼び出し元 cwd を worktree へ
  isolate しないまま dev-flow / pr-iterate を起動すると、harness の bg-isolation guard が
  subagent の Write/Edit を共有 checkout への書き込みとして拒否する。dev-flow は Setup phase
  直後（deps install より前の早期検知）、pr-iterate は review loop 進入前（fix stage 不到達の
  保証）に probe を配置する。probe は worktree 直下 `.devflow-tmp/.isolation-probe-<token>`
  （token は run 毎に一意 — dev-flow は Setup 冒頭 `clockProbe('start')` の epoch（fallback:
  issue 番号）、pr-iterate は pr-meta probe に追加した `date +%s` の epoch（fallback: PR 番号）。
  `Date.now()` / `Math.random()` は canonical の generator 制約上使わない）への Write で
  isolation 成立を検証する。**一意パス化により probe の成立は直前 cleanup の成功に依存しない**
  （cleanup が blocked/skip でも前 run の残置物と同名衝突しないため）。probe agent は
  tools を `[Write]` のみに絞った専任 agent `dev-runner-haiku-wo`
  （model: haiku, effort: low, maxTurns: 5）— Write 以外の経路（Bash リダイレクト等）では
  ファイルを作れないため、「implementer と同じ Write tool 経路の検証」という probe の意味が
  harness レベルで保証される。`written:false` は fail-closed（確定回避手順つき throw）で、
  throw メッセージは決定論の error 文字列分類（`isolationErrorKind`: `overwrite_refused`
  / `isolation` / `unknown`）で「isolation 不成立」と「その他の書き込み失敗（前 run の残置物への
  上書き拒否等）」を区別して報告する — fail-closed（throw）自体は全分類で不変。回避手順は
  1. 書き込みに失敗した cwd とは別の worktree を `git worktree add`、2. `EnterWorktree({path})`、
  3. Workflow 再実行。probe 自体の失敗（null）は fail-open（警告 log のみ）で扱う（issue #449）。
  canonical は `_lib/isolation-probe.mjs` の `isolationCleanupPrompt` / `isolationProbePrompt`
  （token 引数必須。関数側にデフォルトを置かず呼び出し元が明示的に渡す） / `isolationFailureMessage` を
  dev-flow.js・pr-iterate.js 双方へ inline 生成して流用する（両 workflow で同一の文言・手順を
  使うためのもので、片側専用の canonical 関数は追加しない）。
  probe の直前には cleanup を引き続き置く: worktree 内 gitignored の作業用パスを
  `git clean -fdx -- <target>` で除去する。**probe が cleanup 非依存になったことで cleanup の役割は
  「probe を通すため」ではなく「前 run の trust 証跡等の持ち越し防止（衛生）」に変わった**——
  token fallback が退化（例: dev-flow で clock#start が fail-open null かつ同一 worktree 再利用）
  して前 run と同名パスに衝突した場合の補償としてのみ probe 成立に効く。
  **除去範囲 target は呼び出し元が明示的に渡す**（関数側にデフォルトを置かない）:
  dev-flow Setup は run 開始時点なので `.devflow-tmp` 全体を対象にし、前 run の trust 証跡
  （`trust-test-latest.json` / `trust-risk-*.json`。残ると当該 run の証跡書き込み失敗時に
  evalseal-seal.mjs が古い green/red を silent に拾う）も同時に消す。pr-iterate は
  `.devflow-tmp/.isolation-probe` のみを対象にする — nested 起動（dev-flow → `workflow('pr-iterate')`）
  では probe 対象が実行中 dev-flow run の worktree 自身になり、`.devflow-tmp` 全体を消すと
  当該 run が既に書いた trust 証跡を run 途中で失うため。cleanup は fail-open
  （失敗しても一意パス化により直後の probe は通常どおり成立する。token fallback 退化時のみ復旧手順は
  worktree 作り直しで同一）。
  probe prompt / throw メッセージは、実行制御の名称（sandbox・permission・excludedCommands・guard 等）を
  「だからこの経路を使え」という形の理由として述べない — exec-proxy 節の規範と同一で、canonical と
  2 つの inline 生成区間の双方を `_lib/isolation-control-reason.test.mjs` が pin する（issue #493）。
  失敗の診断としての `bg-isolation guard の可能性` は別（何が起きたかの説明であり経路指示ではない）。
  (a) `EnterWorktree({path})` は bg 起動セッションからも成立する — repo 内
  `.claude/worktrees/`（throw メッセージが提示する既定の先）・repo 外 worktree の双方で実測済み
  （issue #449）。したがって bg 経由でも上記の確定回避手順が正規経路として機能する。
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
- **telemetry**: dev-flow 完走時に workflow が telemetry handoff JSON（merge_tier / gate_policy / danger_hits / shape /
  shape_refloored / plan_iter / eval_iter / eval_staleness / eval_verdict / iterate_status / ui_verify / ui_verify_mode /
  final_reconcile / final_test_green / final_ui_verify / final_ac_reconcile / testsurf_hits / redgreen_deny /
  vdelta_fail_open / vdelta_verdicts / duration_seconds / phase_durations / trust_surfaceproof_shadow /
  merge_tier_reasons / route / subagent_invocations）を
  `~/.claude/journal/pending/` へ書き出し、
  dotfiles の Stop hook `claude-code/hooks/stop-devflow-telemetry.sh` が `journal.sh log dev-flow success --merge-tier ...`
  へ毎回自動 flush する（issue #203）。flush 失敗は `~/.claude/logs/stop-devflow-telemetry.log` に記録され pending file が
  残るため記録漏れに気づける。journal.sh の telemetry フラグは未指定なら telemetry キー無し。calibration の原資料。
  `ui_verify` は `skipped`/`passed`/`findings`/`failed_open`/`setup_failed` の 5 値（`setup_failed` は dev-flow-doctor の検出対象）。
  `eval_staleness` は `none`/`hash_mismatch`/`iterate_incomplete`/`iterate_fixed` の 4 値（Evaluate 時点と PR tree の乖離原因を区別する。issue #288）。
  cross-repo issue（修正対象が本 repo 外にある issue）で empty-diff gate が graceful 終了する run は
  `journal.sh` の `error_category` に `cross_repo`（`outcome:'partial'`）を記録し、dev-flow の返り値は
  `status:'cross_repo_artifact'`（`issue`/`worktree`/`branch`/`artifacts`/`note` を含む）を返す。
  `empty_diff` failure として誤記録せず dev-flow-doctor の異常検知（iterate 不調率等）の統計を汚さない
  （issue #432）。当該機構は W7 分類上 blast-radius（人間ラベル opt-in + 決定論的 dirty 検証が揃った
  場合のみ graceful 終了する仕組みで、gate の fail-closed 既定は不変）。
  guard/hook 由来 BLOCKED（block_class:'guard_blocked'。inline-edit-guard deny / sandbox EPERM /
  safety classifier block / bg-isolation 等）が Implement phase で 1 件以上発生した run は、
  成功 handoff（`outcome:'success'` のまま）に `error_category:'guard_blocked'` と telemetry キー
  `guard_id`（発生した guard_id を unique・sort した上で comma 結合した文字列。各要素は
  pattern `^[a-z][a-z0-9-]{0,39}$`）が付く。journal.sh 側の専用フラグ配線・dotfiles Stop hook
  への転送配線は `trust_receipts` 等と同じ precedent に倣い別 issue で扱う — 本 issue（#448）は
  handoff JSON への到達までを保証する（issue #448）。
  `final_reconcile` は `skipped`/`reverified`/`unavailable` の 3 値（fixes_applied=0 は `skipped`、worktree 同期・test 再実行に成功したら `reverified`、同期失敗・schema 不一致等は `unavailable`）。
  `final_ac_reconcile` は `skipped`/`reverified`/`unavailable` の 3 値（fix 適用 run で final test が green/no_tests かつ AC が 1 件以上のときのみ targeted evaluator を one-shot 起動して Analyze 時点の既存 AC を最終 PR tree に対し再検証する。index 完全性・evidence 非空の決定論検証に合格すれば `reverified`、agent null・schema/index/evidence 検証不合格は `unavailable` → merge tier HOLD。未実行は `skipped`）。
  `final_test_green` は final test 実行時のみ出力（Final reconcile が `reverified` の場合のみ）。
  `final_ui_verify` は final UI 再検証実行時のみ出力（`ui_verify` と同語彙: `skipped`/`passed`/`findings`/`failed_open`/`setup_failed`）。
  `testsurf_hits` は test-weakening pattern 名の配列（常時出力、hit 無しは空配列）。
  `redgreen_deny` は `{ac, reasons}` の配列（deny 発生時のみ出力）。
  `vdelta_fail_open` は fail_open 発生件数（>0 時のみ出力）。
  `vdelta_verdicts` は per-AC digest 配列（`{ac, status, comparability, verification_surface, repaired_with_test_change}` のみ。raw verdict・anchors・テスト名は redaction 原則で保存しない — issue #433。単一キーへの上書き出力・dual-key 併記はしない）。
  `duration_seconds` は run 全体の wall-clock 秒（clock#start 〜 clock#end）。
  `phase_durations` は analyze / plan / implement / validate / evaluate / pr / iterate / final の 8 phase の秒数 object。
  各 phase は開始〜終了の全体時間（plan-review loop / evaluate 差し戻し loop 等の内部反復を含む）。evaluate 区間は
  Security floor を含む。micro path（Evaluate skip）では evaluate キー自体が欠落し pr は直近 mark（validate_end）
  起点で計算される。時刻は clock exec-proxy（dev-runner-haiku-ro が `date +%s` を実行）を start/end の 2 回のみ
  起動し、残り 9 mark は phase 境界に隣接する既存 exec-proxy / agent 応答の optional epoch フィールドから
  給電する（fail-open 不変）。
  **専用 probe 2 回分 + 給電元応答の完了タイミング依存の skew（contract 経路の analyze_end は shape 判定・
  surfaceproof の時間が plan 区間へ付け替わる等）を含むため、絶対値ではなく相対比較・分布用途で解釈すること。
  Final reconcile skip 時（fixes_applied=0）は final キー自体が欠落する**。probe 失敗は fail-open（当該 mark null →
  対応する duration キーが欠落。全滅時は両キーとも handoff JSON に現れない）。
  `merge_tier_reasons` は merge tier 判定理由の文字列配列。`route` は PR phase の経路識別子
  （`lite`|`full` の 2 値 enum）。
  `subagent_invocations` は `{total, by_type}` の object（常時出力）。total は run 全体の agent() 起動数で、
  workflow 内の counting wrapper（trackedAgent — 全 call site を wrapper 経由に置換し、bare `agent(` 残存ゼロは
  `_lib/subagent-invocations-routing.test.mjs` が CI 保証）が計上する。nested `workflow('pr-iterate')` の起動分は
  pr-iterate の返り値 `subagent_invocations` を dev-flow 側 counts へ合算する（lite route 非昇格時は pr-iterate
  呼び出し自体が無いため合算 0。単体起動の pr-iterate は自身の handoff に同キーを記録）。
  nested 起動時は同じ counts が pr-iterate 側 journal entry にも記録されるため、journal を skill 横断で
  単純合計すると二重計上になる（集計時は dev-flow entry のみを使う）。by_type は agentType 別の
  起動数（動的キー — enum 強制なし。dev-flow.js の実測 agentType は dev-planner / plan-reviewer / implementer /
  evaluator / pr-reviewer / dev-runner / dev-runner-haiku / dev-runner-haiku-ro / dev-runner-haiku-wo /
  ui-verifier の 10 種、agentType 欠落は 'unknown'）。canonical は `_lib/subagent-invocations.mjs`、dev-flow.js / pr-iterate.js への inline は
  tools/sync-inlines.mjs で生成する。実 token 消費は workflow runtime（agent() 返り値は schema 準拠 JSON のみで
  usage metadata なし）から取得不可のため、起動数 × agentType がトークン効率の proxy metric（issue #445）。
  journal.sh の `--subagent-invocations` フラグ（object 検証違反は当該キーのみ drop する fail-open）に到達済み。
  dotfiles Stop hook 側の jq projection（送り側配線）は route 等 8 キー（issue #430 → it-all-playpark/dotfiles#143）
  と同じ precedent で別 issue に繰り延べる。gate・merge tier・ledger・shape 判定には一切影響しない telemetry
  専用キー（軸A invariant 非抵触）。
  testsurf_hits / redgreen_deny / vdelta_fail_open / vdelta_verdicts / duration_seconds / phase_durations /
  merge_tier_reasons / route の 8 キーは journal.sh の専用フラグ（kebab-case、検証違反は当該キーのみ drop
  する fail-open）に到達済み（issue #430）。dotfiles Stop hook 側の jq projection（送り側配線）は
  it-all-playpark/dotfiles#143 で扱う。
  `trust_receipts` は EvalSeal/EffectDelta shadow 時のみ出力される receipt envelope 配列（stage/invalidated/receipt_id/verdict/record_integrity
  等の digest・ID・closed enum のみ — redaction 原則で raw 本文・anchors 値は保存しない）。stage は EvalSeal の
  `evaluate`/`final` に加え、EffectDelta（issue #412, epic #390 Phase 4）の `pr`（PR phase の read-only pr-observe
  観測）/`summary-comment`（post-summary の comment-ensure 投稿）を含む。EffectDelta entry には任意で
  `domain_reason_code`（DUPLICATE_EFFECT/WRONG_TARGET/RESPONSE_LOST 等、observation 由来の分類）が付き、
  Phase 5 calibration での原因別集計に使う。journal whitelist 登録・
  dotfiles Stop hook への転送配線は別 issue で扱う — 本 issue は handoff JSON への
  到達と統合テストでの検証まで。
  earned-autonomy 集計・calibration は **W6b へ繰り延べ**（W6 は enum 骨格と telemetry 蓄積開始のみ）。
  `trust_surfaceproof_shadow`（issue #410, epic #390 Phase 2）は `{mode, verdict, reason_code, receipt_id}`
  — Analyze phase で SurfaceProof adapter を shadow 実行した結果。REPO が `it-all-playpark/skills` と厳密一致
  し kill switch（環境変数 `TRUST_KILL_SWITCH`）が無効な場合のみ shadow 実行され、それ以外の repo では
  追加 agent 呼出し 0 件のまま出力自体が省略される（AC-11: shadow/off で既存 merge tier・agent 呼出回数・
  return status は不変）。req/shape/needs_clarification 判定へは一切反映しない telemetry 専用キー。journal
  whitelist 登録・dotfiles Stop hook への転送配線は別 issue に
  繰り延べる（本 PR は handoff JSON への到達まで）。

### distrust 機構の正当化クラス (W7)

dev-flow の各「distrust 機構」（LLM/自動化の判定を信用しきらず決定論・人間で gate する仕組み）は、
以下 **3 つの正当化クラスのいずれか**に必ず分類する。**正当化クラスと sunset path の無い distrust
機構は定義上「将来の技術的負債」**（モデルが賢くなっても撤去判断ができず過小活用が累積する）。
新しい distrust を足すときは必ずクラスを宣言し、capability-bound なら sunset path
（パラメータ値での表現 + 再評価トリガ）を併記すること。詳細は
`claudedocs/2026-06-09-dev-flow-adaptive-ledger-redesign.md` §2（2 軸）/ §4.5 / §6。

| クラス | 正当化根拠 | 能力依存 | 代表機構 |
|--------|-----------|---------|---------|
| **incentive-structural**（永続・撤去禁止） | 敵対ループの勝利宣言を当事者に self-judge させない incentive 設計 + cold-context moving-target の抑制 | **非依存**（賢いモデルほどシャープな non-convergent nitpick を出すため逆に悪化） | frozen target（planSeen/evalSeen/blockSeen 累積）・既出 findings/feedback 累積・topic-stuck 検出 + relax + early-cutoff・critical-always-blocks + severity floor + append 単調性・hard cap（PLAN/EVAL/GREEN/BLOCK_MAX, last-resort safety net）・dev-improve IMPROVE_MAX + backpressure（ループが自分の提案量を自己増幅させない）・guard_blocked の replan 除外（guard/hook 由来 BLOCKED を「別アプローチ探索」ループに入れず blockedConcerns→evaluator focus へ直行 — guard 迂回手順の探索 incentive を絶つ。issue #448）・blocking_reason 決定論スクラバー（迂回コマンド列の replan/evaluator prompt への verbatim 伝播遮断。issue #448）・review-finding 決定論スクラバー（pr-iterate の blocking finding description/suggestion の fix prompt への verbatim 伝播遮断 — メタ指示が実行指示へ変換される経路を断つ。issue #503）・analyze provenance 突合（取得 issue 番号/title の決定論突合で REQ 捏造を反証可能化 — 取得成功の self-judge をさせない fail-closed。issue #451）|
| **blast-radius**（永続） | 不可逆性 / accountability / liability / blast-radius。正確性ではなく当事者性で正当化するため frontier が人間を超えても残る | **非依存** | human merge（accountability/不可逆/values/novelty）・danger-grep on realized diff → security path 強制・seeded SEC + merge tiering HOLD（danger/breaking/不可逆）・pr-iterate critical/major-always-blocks（merge 直前の最終ゲート: この先は human merge のみで、ここで relax すると既知の critical/major が出荷される。修正コストは PR スコープに bounded）・Final reconcile（pr-iterate fix 適用後の最終 tree に対する決定論 test 再実行 + 既存 AC の one-shot 再検証（fail は critical AC-FINAL append・既存 checked は不変の append 単調） → red/unavailable で HOLD。merge 直前の最終ゲート）・dev-improve 自動 revert 禁止・sunset 昇格の issue→人間 merge 経由・仮説突合の決定論 oracle（hypothesis-check.sh — LLM に効果の self-judge をさせない）・TESTSURF seeding（test-weakening 決定論検出 + evaluator clearance、merge tier HOLD）・lite route の pr-reviewer 1-pass → critical/major findings 検出で `workflow('pr-iterate')` フル fix loop へ自動昇格（critical/major-always-blocks 不変。縮約経路でも merge 直前のゲートを維持）|
| **capability-bound**（**sunset 対象**） | 現行 LLM judge の信頼性不足（ECE≈39% / FPR≈35%）。モデルが賢くなるほど縮む | **依存** | `gate_policy = llm-major-advisory`（LLM major を blocking にしない distrust）・ui-verify advisory 固定（UI 判定を blocking にしない distrust）・trust-layer 3 層（SurfaceProof / EvalSeal / EffectDelta。現在 off 固定）|

**capability-bound の sunset path（必須）**: パラメータ値で表現し再評価トリガを持たせる。
`gate_policy` の sunset path —
- 表現: `gate_policy` enum 値（`llm-major-advisory` → `llm-major-blocking`）。
- 再評価トリガ: **major モデルリリース毎** + W6b の calibration monitor が当該カテゴリの
  judge を well-calibrated と実証した時点。実証されたら `gate_policy` を LLM 側（blocking）へ進める。
pr-iterate major 閾値の sunset path —
- pr-iterate の critical/major-always-blocks は主分類 blast-radius（永続）だが、**major 閾値**（pr-reviewer の major 判定を blocking に含める線引き）は LLM judge の信頼性に**能力依存**する capability-bound 側面を持つ。critical-always-blocks 部分は永続で sunset しない。
- 表現: 将来 pr-iterate の major blocking 判定を `gate_policy` 連動（`llm-major-advisory` 系の値で major を advisory 化）にする形で表現する — 現在は policy 非連動の固定値（critical/major 常時 blocking）。
- 再評価トリガ: W6b の calibration monitor が pr-reviewer の major judge を well-calibrated と実証した時点で `gate_policy` 連動へ移行する。実証まではゲート後退（relax）させない。
ui-verify advisory 固定の sunset path —
- 表現: ui-verify findings は UI-* ledger item（inspection / major = 既定 gate_policy で advisory lane）として固定。blocking にしない。
- 再評価トリガ: telemetry `ui_verify` / `ui_verify_mode` を W6b の calibration monitor で pr-reviewer / human verdict と突合し、UI judge の precision が実証された時点で gate_policy 連動の blocking へ昇格する。実証まで advisory 固定。
redgreen vdelta deny の sunset path —
- 主分類は incentive-structural（red→green 昇格の勝利宣言を test 変更込みで self-judge させないラベル精度保護）だが、**blocking ゲート化しない点**（deny-only 存置）は capability-bound。
- 表現: 昇格条件の deny `&&` 節（deny-only）。
- 再評価トリガ: veridelta が record_integrity を advisory から昇格（INV-10 解消）し W6b calibration が vdelta verdict の precision を実証した時点で blocking gate 化を再評価する。
trust-layer（SurfaceProof / EvalSeal / EffectDelta）off 固定の sunset path —
- 表現: `_lib/trust-wiring.mjs` の `TRUST_LAYER_CONFIG` 各 enum 値（'off' → 'shadow' → 'advisory' → 'blocking'）。現在は 3 層とも **'off'**。同一 harness evaluator の receipt は verifier 種別により常に `record_integrity='advisory'`（`resolveTrustLevel` の same-harness 経路 — これは incentive-structural 側で sunset しない）。
- **sunset path は昇格の一方向ではない**。capability-bound の distrust は「実証されなければ撤去する」側のトリガも必須で、これが無いと機構は無期限に居座り §W7 冒頭の「将来の技術的負債」そのものになる。以下 2 方向を必ず併記する。
- 復帰（off → shadow）トリガ: 3 条件すべて。(1) call site が監査証跡の破壊的上書き・自己封緘を行わない形へ再設計されている、(2) trust 由来の safety classifier ブロックが run abort / journal-log 連鎖ブロックへ波及しないことが実測で確認できている、(3) off 期間の完走率を分母として shadow 復帰後の完走率が有意に劣後しない。1 つでも欠けたら off のまま。
- 昇格（shadow → advisory/blocking）トリガ: 復帰後に receipt 取得成功率・inconclusive 率が SLO（`dev-flow-doctor/scripts/trust-receipts-report.sh --slo`）を満たし、かつ **3 層の守備範囲が実失敗モードと突合できている**こと。SurfaceProof が検証するのは issue unit の「提示の完全性」であって「指示への遵守」ではない等、検出対象と実際に起きた失敗のズレを突合しないまま昇格させない。blocking 昇格時に `classifyMergeTier` の `trustGate`（実装済み・非 blocking では null）を活性化する。pinned verifier（agent write 圏外）実装までは 'trusted-environment' を主張しない。
- 撤去トリガ: off 期間の実測で「trust layer 無しでも完走率・検出漏れが悪化しない」ことが確認できた時点で、`_lib/trust-*` / `_shared/scripts/{evalseal-*,effectdelta-github.sh}` / `dev-issue-analyze/scripts/surfaceproof-snapshot.sh` と各 call site を削除する別 issue を起票する。off のまま放置しない。
- 逆に incentive-structural / blast-radius はモデル更新で撤去してはならない（§6 軸A 保持）。

### 指示の規範性 (prescription) の正当化クラス

dev-flow の agent 指示・guardrail（`.claude/agents/*.md` の指示ブロック等、agent に「こう振る舞え」と
規範を課す記述）は、以下 **3 つの正当化クラスのいずれか**に必ず分類する。**正当化クラスの無い指示は
W7 の distrust 機構と同様「将来の技術的負債」**（モデルが賢くなっても削減判断ができず prompt 肥大が
累積する）。W7 が「LLM の出力を信用しない仕組み」の分類であるのに対し、本節は「LLM への指示の
規範性」の分類である。

| クラス | 正当化根拠 | 能力依存 | 判定基準 |
|--------|-----------|---------|---------|
| **contract**（永続） | 指示がインターフェース契約そのもの（出力 JSON schema・StructuredOutput 呼び出し義務・Boundary（触ってはいけないファイル・commit 禁止）・入出力キーの意味定義）。呼び出し側 workflow の parse / gate がその記述に依存するため、モデルがどれだけ賢くても明示が必要 | **非依存** | 指示を削除すると workflow 側の schema 検証・phase 遷移が壊れる、または契約が暗黙化して呼び出し側と drift する |
| **incentive-structural**（永続） | 賢いモデルでも incentive 構造・context 構造上、放置すると守られない方向に傾く指示。例: self-judge 禁止（勝利宣言を当事者にさせない）、feedback 全件対応義務（critical を握りつぶす incentive の抑制）、self-contained 記述強制（cold-context の implementer に周辺 context が無いという構造要因）、topic 反復時のアプローチ変更強制 | **非依存**（賢いモデルほど巧妙に逸脱し得る） | 逸脱がモデルの能力不足ではなく optimization pressure または context 分断に由来する |
| **capability-bound**（**sunset 対象**） | 現行モデルの能力不足を補う手取り足取り指示。例: 詳細な手順分解（step-by-step 列挙）、禁止表現の具体列挙、書き直し例・few-shot 例示、判定基準の過剰な具体化 | **依存** | frontier モデルなら指示なしでも同じ品質の出力が期待でき、指示の役割が「現行モデルの取りこぼし防止」のみである |

**capability-bound の sunset path（必須）**: capability-bound に分類した指示には sunset path を必ず
併記する。既存 gate_policy sunset path と同基準で、以下 2 項目を書く。
- 表現: どの指示ブロック（ファイル・セクション）を削減・パラメータ化するか。
- 再評価トリガ: **major モデルリリース毎**（`QUALITY_MODEL` の世代交代時）に当該指示を外した
  dry-run / 実測で品質劣化が無いことを確認してから削減する。

新しく指示・guardrail を足すときは必ずクラスを宣言し、capability-bound なら sunset path
（表現 + 再評価トリガ）を併記すること。

QUALITY_MODEL 向け 4 agent（dev-planner / plan-reviewer / evaluator / pr-reviewer）の現状分類は
`claudedocs/2026-07-27-issue-424-prescription-inventory.md` を参照。実際の指示削減は別 issue で扱う。

### inline 生成区間（_lib → workflows の sync generator）

`.claude/workflows/*.js` 内の `// ==== BEGIN inline: <path> ... ====` 〜 `// ==== END inline: <path> ====`
区間は**生成物であり直接編集禁止**。編集は `_lib` の canonical 側で行い `tools/sync-inlines.mjs --write`
（先頭トークン=スクリプトパスの bare 形。shebang + 実行bit 付与済み — sandbox excludedCommands は
先頭トークンでマッチするため node/cd/bash 前置は付けない）で再生成する（`--check` が CI で全文一致を
検証 — `_lib/workflow-inlines.sync.test.mjs`）。blame は `_lib` 側を見る。

**新規 inline 区間の追加**にも正規経路がある: `tools/sync-inlines.mjs --add <_lib/xxx.mjs> --into
<workflow.js> --after '<挿入位置直前の一意な行（完全一致）>'`（同じく bare 形。node/cd/bash 前置は
付けない）。marker ペアの挿入と canonical 本文の充填・全検証（forbidden tokens / duplicate / decl
collision / 生成後 syntax）を 1 コマンドで validate-then-write するため、途中失敗時も対象ファイルは
不変のままになる。marker 行を Edit/Write で直接書くことは pretool-inline-edit-guard が deny する。
**git plumbing（hash-object/update-index/checkout-index 等）による迂回は禁止** — 迂回すると guard
の存在理由（生成物の手編集が次回 `--write` で黙って消失する事故防止）が破られる。

**canonical の構造制約**: ESM import / require / Date.now / Math.random を含めない（generator がコメント除去後のコードを走査して error）。
**ファイル全体が inline 可能**であること（export は行頭接頭辞除去のみで verbatim 注入。export default / export { } は不可）。

**上記以外に canonical のコーディングスタイル制約はない**: 区間全文一致方式のため、template literal の書き方・const の配置等は自由。

**この generator は harness-capability-bound な橋**（W7 表の capability-bound クラスとは別の軸: LLM judge 能力依存ではなく harness 機能依存）。workflow loader が ESM import 不可という harness 制約への対応として存在する。
- 表現: `tools/sync-inlines.mjs` + マーカー区間そのもの
- 再評価トリガ: Claude Code（harness）更新毎に loader の ESM import 可否を再検証し、解禁されたらマーカー区間を `import` 文に置換して generator・統合 sync test ごと撤去する。再検証は `/dev-flow-canary`（read-only capability canary）→ dev-flow-doctor `run-diagnostics.sh --canary` で行う。

**exec-proxy も harness-capability-bound な橋**（同じ harness 機能依存軸）。workflow runtime に fs / exec が無いという harness 制約への対応として、決定論スクリプトの実行を dev-runner(-haiku/-haiku-ro/-haiku-wo) subagent に委譲し stdout を verbatim で返させるパターン（diff-hash / danger-grep / realized-diff / journal / test 実行など 10 箇所超）。least privilege のため capability 別に 4 agent へ分離する（issue #323, #521）: read-only 決定論 proxy（diff-hash / changed-files(realized-diff) / CI checks read / ui-verify config read / base-ref probe）は `dev-runner-haiku-ro`（tools: `[Bash, Read]` のみ）、書き込み・Skill 呼び出しを伴う決定論 proxy（worktree 作成 / deps / test 実行 / redgreen / reconcile-sync / danger-grep(-final)（`--out` で risk 証跡ファイルを書く） / trust-seal-eval（`--tree-source working` は worktree 全体の tree OID 算出のため git object を書く。実 index・working tree は変更しない） / ui-verify server・teardown / journal 書き込み / PR コメント投稿（post-review / post-summary））は `dev-runner-haiku`（tools: `[Bash, Read, Write, Skill]`。Write は投稿本文の verbatim 一時ファイル保存に必要）、Write のみで完結する isolation probe 専任 proxy は `dev-runner-haiku-wo`（tools: `[Write]` のみ。Bash 等の代替手段を harness レベルで遮断し probe の意味を保証する）、判断寄り（fix/analyze/commit+PR）は `dev-runner`（sonnet）が担う。全 exec-proxy agent の frontmatter には有限の `maxTurns` を設定する（dev-runner-haiku-ro: 10 / dev-runner-haiku: 25 / dev-runner-haiku-wo: 5 / dev-runner: 50）。maxTurns の agent frontmatter サポートは Claude Code CHANGELOG 上で確認できる最小バージョンとして `2.1.78`（"Added `effort`, `maxTurns`, and `disallowedTools` frontmatter support for plugin-shipped agents" — https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md）を根拠とする。ただし CHANGELOG の文言は "plugin-shipped agents" 限定であり、本 repo の `.claude/agents/*.md`（project-level custom subagent、非 plugin 配布）に対しても同一に runtime honor されるかは一次情報で確認できていない（要 sunset path 的な再検証: 次回 major リリース時に docs/CHANGELOG で project-level agent への適用有無を再確認する）。
- 表現: dev-runner(-haiku/-haiku-ro/-haiku-wo) verbatim 転写プロンプト群
- 再評価トリガ: harness が workflow への直接 exec（または fs/exec API）を解禁した時点で、当該プロンプト群を直接実行に置換して exec-proxy ごと撤去する。再検証は `/dev-flow-canary`（read-only capability canary）→ dev-flow-doctor `run-diagnostics.sh --canary` で行う。

> exec-proxy スクリプトは認証付き network I/O（gh・git push）を内部に持ってはならない。GitHub I/O は
> subagent の Bash で「先頭トークンが gh または git の bare 単文」（--repo/-C で cwd 非依存化、
> cd &&・bash・env 前置禁止）として実行し、出力を $TMPDIR の file に落とすか、呼び出し側 agent が
> stdout/stderr を argv でスクリプトへ verbatim 転写して、スクリプトは file または argv 入力の
> 純変換とする。prompt に sandbox / excludedCommands / 特定パス起動の理由を書いてはならない —
> exec-proxy prompt は決定論スクリプトへの verbatim 転写契約であり、起動形の正しさは
> excludedCommands という設定側の不変条件である。設定の正当化は本ファイルと AGENTS.md に一箇所だけ
> 置き、per-prompt で再説明しない（prompt 内の再説明は転写契約に判断余地を持ち込み、下流の prompt へ
> 引用・増幅される）。**例外はない**。wall-clock polling を要するサイトも例外ではなく、fetch と sleep を
> 呼び出し側（prompt の attempt ループ）へ置き、スクリプトは snapshot 1 枚に対する純変換に保つ
> （`check-ci.sh` が precedent。issue #488）。
>
> `check-ci.sh` は issue #499 で入力方式を file 中継から argv データ渡しへ切り替えた: 呼び出し側 agent が
> `gh pr checks --repo <owner/repo> --json name,state,bucket` を bare 単文で実行し、その stdout/stderr を
> `check-ci.sh --checks-data '<stdout>' --fetch-error-data '<stderr>'` へ argv で verbatim 転写する
> （`gh` 単文 → `check-ci.sh` 単文の 2 つの bare 単文のみで、リダイレクト・パイプ・複合コマンドを挟まない
> — isolation guard はこれらを拒否するため、isolate 済みセッションには file 中継の手段がない）。この方式は
> 呼び出し側 agent が転写を verbatim に行う（要約・加工しない）ことを信頼する前提に立つ（スクリプト側に
> 転写の正しさを検証する手段はない）。`--json` を `name,state,bucket` の最小 fields に保つのは、転写する
> payload を最小化して転写破損リスクを下げるため。クオート破綻や部分転写が起きた場合、`--checks-data` は
> 有効な JSON array としてパースできなくなるため `check-ci.sh` は non-array 経路の `status:'error'`
> （fail-safe）に落ちる — 一部 check が欠落したまま有効な配列としてパースされる wrong-green にはならない。
>
> 旧版はここに「wall-clock polling のみ sandbox 内で完結する curl+REST を使ってよい」という例外を
> 置いていたが、これは成立しない — sandbox 内で完結させるには env token に頼るしかなく、private repo
> では無認証となり GitHub が存在秘匿のため 404 を返して CI 全 green でも `ci_error` に落ちる（issue #488
> の実害）。逆に例外を「script 内 `gh`」で埋めると、`~/.config/gh` が denyRead であるためスクリプトの
> 起動形（`excludedCommands` 登録パス）に正しさが依存し、起動形を変えた瞬間に静かに回帰する。
> どちらも塞がっているので、polling は呼び出し側に置くこと。
>
> 呼び出し側ループは subagent の `maxTurns` を消費する（fetch / 純変換 / sleep がそれぞれ 1 turn）。
> attempt 数を調整するときは `(attempt 数 × 2) - 1` が当該 agent の `maxTurns` を超えないこと
> （現行 `ci-check`: 3 attempts × 45s = 90s ceiling / 最悪 8 turns、`dev-runner-haiku-ro` の maxTurns 10）。

exec-proxy の失敗ポリシーは、決定論ゲートの性質ごとに明示する:

| proxy | 失敗検出 | ポリシー | 理由 |
|-------|----------|----------|------|
| danger-grep / `diff-risk-classify.sh` | `ok:false` / schema 不一致 / 空出力 / command failure | fail-closed（全 SEC seed を unchecked） | W7 軸A invariant の security floor。clean と失敗を同一視しない |
| realized-diff | `null` / schema 不一致 | fail-safe（complex floor） | diff 不明時は shape を安全側へ raise する |
| redgreen | `null` / schema 不一致 | fail-safe（inspection 据え置き） | テスト状態不明時は検査済みにしない |
| diff-hash | `null` / schema 不一致 | fail-open（stale 検出 skip、警告のみ） | stale 検出の補助信号。失敗しても既存の deterministic gate を緩めない |
| diff-hash-reuse（Security floor↔Merge tier の worktree tree OID 一致判定による danger-grep-final / changed-files 再利用。issue #377） | secDiffHash null（Security floor の danger-grep fail-closed（risk.ok!==true）/ realized-diff 無効 / diff-hash-secfloor 取得失敗）/ mergeDiffHash null（diff-hash-merge 取得失敗）/ hash 不一致（tree 変化） | fail-safe（再利用せず danger-grep-final / changed-files を現行どおり再実行） | 同一入力（byte 一致 worktree tree）の再計算省略のみで distrust の追加/緩和ではない。再利用は risk.ok===true の Security floor 結果に限定し、失敗・不一致・初回は再実行するため danger-grep の fail-closed security floor（W7 軸A invariant）を一切変えない |
| ui-verify（`ui-verify-server.sh` / ui-verifier） | `ok:false` / `null` / schema 不一致 | fail-open（skip + telemetry `failed_open`。install 失敗のみ `setup_failed` で区別） | advisory な UI 検証の補助信号。失敗しても既存の deterministic gate を緩めない。teardown は workflow 側 try/finally + 冪等 stop で保証 |
| ci-checks（`gh pr checks`） | `null` / `ok:false` / schema 不一致 / 該当 check 不在（env_key ごとの check-name regex 不一致） / pending | fail-open（対象 ENV item（turbopack-sandbox / bats-sandbox）据え置き、警告 log のみ） | advisory な環境ノート auto-close の補助信号。判定は envChecksGreen（決定論）のみで LLM に委ねず、失敗しても deterministic gate・merge tier 判定を変えない（軸A 不変） |
| ci-check（pr-iterate CI gate / dev-flow `ci-check-lite`。`gh pr checks` → `check-ci.sh` の argv 転写 2 単文） | `null` / schema 不一致 / agent throw（StructuredOutput 未返却・proxy 実行失敗） | fail-open（throw/null は呼び出し側で吸収。pr-iterate では `status:'error'` を合成して既存の terminal `ci_error` へ流し人間へエスカレーション — run は abort しない。dev-flow `ci-check-lite` では full `pr-iterate` への委譲へ fallback） | CI 状態不明を green と同一視しない（軸A 不変）まま、exec-proxy の実行失敗が run 全体を落とす経路（issue #499、PR #498 で 9 回中 5 回 abort 実測）を除去する |
| validate-test（test#i / test#retry-i） | agent throw（EPERM 等の proxy 実行失敗・StructuredOutput 未返却） | fail-safe（当該 iteration を合成 red として green-fix ループ継続。GREEN_MAX 到達で Evaluate へ委譲） | test proxy の実行失敗を run 即死にしない（issue #359）。red を green と同一視しない（軸A 決定論ゲート）。null→need() の中断経路は不変 |
| final-reconcile（reconcile-sync / test#final） | `null` / `ok:false` / schema 不一致 / 非 fast-forward / test#final throw | fail-safe（`final_reconcile=unavailable` → merge tier HOLD） | fix 適用後の最終 tree の test 状態不明を green と同一視しない（軸A 決定論ゲート）。throw も unavailable へ吸収（issue #359）。同様に changed-files-final / ui-verify-config-final は fail-open（UI 再判定・宣言外再監査 skip + 警告 log のみ。test gate は緩めない） |
| final-ac-reconcile（targeted evaluator による既存 AC の最終 tree 再検証） | `null` / schema 不一致 / ac_index 欠落・重複・範囲外 / evidence 空 | fail-safe（`final_ac_reconcile=unavailable` → merge tier HOLD） | fix 適用後の最終 tree での AC 充足不明を satisfied と同一視しない（軸A 決定論検証。fail は既存 AC を uncheck せず critical AC-FINAL-n append — append 単調性・critical-always-blocks 維持） |
| structural-classify（difft による構造変化/フォーマットのみ分類） | `null` / `ok:false` / `available:false`（difft 未インストール） / schema 不一致 | fail-open（format_only 除外なし・全ファイル精査の現行動作。警告 log のみ） | advisory な diff 前処理の補助信号。失敗しても refloorShape の raise-only・danger-grep・宣言外検出の deterministic gate を一切緩めない |
| vdelta-verdict（redgreen R1↔R2 の deny-only ラベル精度保護） | `verdict null / 不正 JSON / transitions 欠落` | fail-open（deny せず現行の deterministic 昇格判定のまま。fail_open 発生は telemetry `vdelta_fail_open` で可視化） | advisory な昇格ラベル精度の補助信号（INV-10: record_integrity=advisory 恒久）。失敗しても red&&green の決定論ゲート自体は緩めない。comparability≠exact は abstain（並列 stream 混入の誤 deny 防止） |
| testsurf（`diff-risk-classify.sh` test-weakening クラス → TESTSURF seed） | danger-grep と同一（`ok:false` / schema 不一致 / 空出力） | 既存 TESTSURF item 据え置き・新規 seed なし（同一スクリプトの SEC fail-closed が全 SEC unchecked → HOLD を担保するため安全側は成立） | 検出は決定論 grep、解除は evaluator clearance（evidence 必須）のみ。hit は `source:'seed'` 常時 blocking で merge tier HOLD（軸A: 決定論 hit を policy で緩めない） |
| post-comment（pr-iterate post-review#i / post-summary、dev-flow post-summary — PR コメント投稿） | `posted:false` / `null` / schema 不一致 | fail-open（投稿失敗は警告 log のみ。merge tier 判定・ledger・gate に影響しない） | advisory な結果報告投稿。本文は workflow 側で確定済み文字列の verbatim 転写 + `gh` 実行のみで agent 側の要約・判断を含まない（dev-runner-haiku, issue #372） |
| journal-handoff（journal-save（stage1: payload を worktree 内 gitignored `.devflow-tmp/` へ **Write tool のみ**で verbatim 永続化。保存先は workflow が絶対パスで固定し `savePath` で渡す — repo 配下への Bash 書き込みが deny される環境（skills repo の自己改変ガードは worktree 配下も含む）では `mktemp` が EPERM になり agent が別ディレクトリへ退避して保存先検証に落ちるため、shell に依存させない。agent 申告の path は使わず固定 `savePath` を stage2 へ渡す。worktree を持たない dev-improve のみ `saveDir` + `fileName` モードで、`${TMPDIR:-/tmp}` 配下の固定サブディレクトリを shell 展開で解決する）→ journal-log（stage2: 検証済みファイルパスのみを finalize command へ渡し pending/ へ格納）の 2 段。canonical は `_lib/journal-handoff.mjs`） | `saved:false` / `validateJournalSavedPath` 不合格 / `logged:false` / `null` / schema 不一致 / agent throw | fail-open（telemetry が pending/ に届かなくても run は継続。gate・merge tier・ledger には一切影響しない）。ただし結果は返り値 `journal_log_status` の 3 値 closed enum（`logged` / `save_failed` / `log_failed`）に必ず現れる | telemetry は gate ではないので記録失敗で run を落とさない。一方で silent な欠落は dev-flow-doctor / dev-improve の分母を不定量に減らし、doctor 自身が使う journal が書かれないため検知もできない（issue #494）。fail-open を維持したまま欠落を呼び出し元から観測可能にする。stage2 の finalize command（`&&` 連結の単行コマンド）が isolate 済み環境で実行不能な場合も、throw は呼び出し側の try/catch が吸収し run は継続する。返り値 `journal_log_status` には常に 3 値 enum のいずれかが現れ、この経路では `log_failed` が必ず観測される（テストで pin、issue #499） |
| clock（`date +%s` 現在時刻 probe × 2/run（start/end）。残り 9 mark は隣接 proxy の optional epoch 給電で、給電元失敗時も同ポリシー（当該 mark 欠落）） | `null` / `ok:false` / schema 不一致 / agent throw（EPERM 等の proxy 実行失敗・StructuredOutput 未返却） | fail-open（当該 mark 欠落 → 対応する duration キー欠落、警告 log のみ。throw は try/catch で吸収） | advisory な duration telemetry の補助信号。失敗しても deterministic gate・merge tier 判定を一切変えない（軸A 不変） |
| trust-seal（evalseal-seal.mjs による EvalSeal shadow receipt の seal / check。trust-seal-eval / trust-check-final / trust-seal-final） | null / ok:false / schema 不一致 / mode:off / agent throw | fail-open（receipt 無し・旧 receipt invalidated 扱いで続行、警告 log のみ。merge tier・security floor・gate 判定へ影響しない — shadow は isGatingMode=false で classifyMergeTier の trustGate が常に null） | advisory な trust-layer shadow dogfood の補助信号（epic #390 Phase 3）。receipt 生成失敗を fail と同一視せず、受領物なしは effectiveTrustVerdict が 'inconclusive' に倒す（成功扱いしない）。blocking 昇格は Phase 5 の calibration 実証後（軸A 不変） |
| analyze-parse（analyze-issue.sh --contract --issue-json <file> 決定論 parse → REQ 転写。issue JSON は subagent の bare `gh issue view --json ...` 出力を $TMPDIR file 経由で渡すファイル入力化を採る） | throw / null / ok:false / schema 不一致 / eligible:false / whitelist 検証（buildReqFromContract）不合格 | fail-open（現行 sonnet analyze へ fallback — 挙動不変。DEPTH=standard のみ試行） | 高速化の補助経路であり品質ゲートではない。fallback 先が現行経路そのものなので失敗しても後退なし。light path は構造化 breaking 判定を行わない（keyword hit は eligibility で sonnet へ回し、残余は事後の danger-grep / merge tier が補償） |
| analyze-provenance（`gh issue view --json number,title` による sonnet analyze 結果の決定論突合。Analyze phase、sonnet 経路のみ — contract 決定論 parse 採用時は不実行） | `null` / `ok:false` / schema 不一致 / agent throw / issue 番号・title 突合不一致 | fail-closed（needs_clarification で終端 — 捏造 REQ を Implement へ流さない） | analyze agent に「取得成功」を self-report させない（incentive-structural、issue #451）。probe が gh に到達できない状況は analyze 側も取得できていない状況そのものであり、捏造 REQ で進行する方が中断より高コスト。light path（analyze-issue.sh --contract）の fail-open fallback は不変 |
| pr-meta（`gh pr view --json mergeable,mergeStateStatus` による base branch conflict 検出、dev-flow Merge tier phase） | `ok:false` / `null` / schema 不一致 / `mergeable=UNKNOWN` 継続 | fail-open（mergeableState='unknown' → conflict gate 不適用、警告 log のみ。definitive な CONFLICTING / mergeStateStatus=DIRTY のみ HOLD） | merge は全 tier 人間であり GitHub 自体が conflict merge を platform で hard-block するため、conflict signal を取りこぼしても実害ある merge は起こり得ない。`mergeable=UNKNOWN` は GitHub の mergeability background 計算中の transient 状態であり fail-safe(HOLD) にすると healthy PR を spurious HOLD する。既存 deterministic gate・security floor を一切緩めず、definitive conflict 検出時にのみ HOLD reason を追加する（軸A 不変） |
| trust-surfaceproof-shadow（`surfaceproof-snapshot.sh --issue-json/--comments-json <file>` による SurfaceProof shadow probe、dev-flow Analyze phase。issue/comments は subagent の bare `gh` 単文出力を $TMPDIR file 経由で渡すファイル入力化。kill-switch probe も同一ポリシー） | `ok:false` / `null` / schema 不一致 / agent throw / receipt 欠落 | fail-open（`trust_surfaceproof_shadow` は `verdict:'inconclusive', reason_code:'PROBE_FAILED'` を記録、警告 log のみ。kill-switch probe 失敗は fail-safe で kill switch 有効相当＝shadow 実行自体を skip） | advisory な shadow dogfooding の観測信号（W7 capability-bound。AC-11/AC-15 非緩和）。req/shape/needs_clarification 判定・merge tier・既存 deterministic gate には一切反映しない — 失敗しても後退する既存ゲートが無い |
| trust-effectdelta（effectdelta-github.sh pr-observe（read-only、ローカル `git -C <worktree> rev-parse` は不変） / comment-prepare・comment-observe — PR readback 観測・summary comment の write-once 投稿の準備とファイル入力による readback 分類。実 `gh api` / `gh pr comment` は post-summary subagent の bare 単文 choreography へ移管。pr-ensure subcommand は削除（write-once の gh choreography は純変換に分解不能、caller 不在のため）） | ok:false / null / schema 不一致 / posted:false / agent throw | fail-open（receipt 無しで続行・comment は subagent の bare `gh pr comment` 直接実行へ fallback、警告 log のみ。merge tier・security floor・gate 判定へ影響しない） | advisory な trust-layer shadow dogfood の補助信号（epic #390 Phase 4）。journal handoff は stable effect ID + atomic write で同秒/並列/再実行に耐性（AC-10）— gate ではなく handoff 耐久性の決定論改善 |
| issue-labels（`gh issue view --json labels` による empty-diff gate の cross-repo lazy ラベル probe。dhGate.empty===true 時のみ実行） | null / `ok:false` / schema 不一致 / throw | fail-safe（非 cross-repo 扱いで既存 empty-diff fail-closed 経路（差し戻し1回→再度空なら throw）を維持） | ラベル不明を人間の opt-in 成立と同一視しない（issue #432）。成果物は worktree/外部 repo に残存するため破壊的ではなく、throw メッセージにラベル付与のヒントを追記して人間の再実行を促す |
| commit-ensure（subagent の bare git 単文シーケンス（`git status --porcelain` 空判定 → `git add -A` → `git commit` → `git push`（失敗時 `git push -u origin HEAD`）→ 再 `git status --porcelain` → `git rev-list "@{u}"..HEAD --count`）による決定論検証 — fix 適用直後の未コミット変更検証 + commit/push 回収。pr-iterate AC-3） | null / schema 不一致 / agent throw / dirty なのに committed・pushed が true でない | fail-safe（terminal='fix_failed' で人間へエスカレーション） | fix agent の self-report（applied:true）を commit 済みと同一視しない（incentive-structural: 完了宣言を当事者に self-judge させず決定論 git 検証で突合）。未コミット/未 push のまま次 iteration へ進むと再 review が stale な PR diff を見る（issue #437） |
| worktree-dirty（subagent の bare `git status --porcelain` 単文 — pr-iterate 非 lgtm 終端時の作業ツリー dirty 検出。pr-iterate AC-2） | null / schema 不一致 / agent throw | fail-open（worktree_dirty='unknown' + 警告 log のみ。status・gate 判定へ影響しない） | advisory な終端観測 telemetry（'dirty'/'clean'/'unknown' の 3 値）。probe 失敗で run を落とすと異常終端の素通し（issue #437 が直す問題）を再生産する |
| isolation-cleanup（subagent の bare `git -C <worktree> clean -fdx -- <target>` 単文 — probe 直前の残置物除去。target は dev-flow Setup が `.devflow-tmp` 全体、pr-iterate が `.devflow-tmp/.isolation-probe` 単体） | `cleaned:false` / null / schema 不一致 / agent throw | fail-open（警告 log のみ。gate・merge tier・security floor へ影響しない） | probe 対象パスが run 毎に一意なため、除去に失敗しても probe は前 run の残置物と衝突せず成立する（cleanup 成功への依存を切った — issue #521）。cleanup 自体を fail-closed にすると、除去対象が無い正常系（新規 worktree）と区別できない失敗で run を落とす（issue #493） |
| cross-repo-artifacts（`_shared/scripts/cross-repo-artifacts.sh` による worktree 外 working tree の dirty 検証。cross-repo ラベル検出時のみ実行） | null / `ok:false` / schema 不一致 / found=0 | fail-safe（handoff 不成立で既存 empty-diff fail-closed 経路へフォールスルー。ラベルのみで gate を skip しない） | 決定論的証拠（dirty working tree）なしに gate を skip すると軸A invariant（決定論ゲートを LLM/ラベルで緩めない）に反する（issue #432） |

## dev-improve (self-improvement loop)

dev-flow を telemetry 駆動で継続的に自己改善するループ。orchestration は
`.claude/workflows/dev-improve.js`（dynamic workflow）、起動は `/dev-flow-improve`
skill（週次 launchd: `dev-flow-improve/scripts/install-schedule.sh --install`）。
設計: `claudedocs/2026-07-13-dev-improve-loop-design.md`。

```
/dev-flow-improve → Workflow('dev-improve')
                      Reconcile(仮説突合) → Mine(4ソース並列) → Rank(dedup+cut) → File(issue化)
                    → 起票 issue ごとに Skill('dev-flow') を直列実行 → 人間 merge
```

- **改善ソース 4 系統**: doctor-anomaly（telemetry 分布・anomaly）/ failure-rca（失敗 run 個別掘り）/
  sunset（W7 capability-bound の再評価トリガ検知）/ pr-signal（findings 再発・merge_tier と人間判断の乖離）。
  miner は `.claude/agents/improve-miner.md`（read-only 判断系 leaf）。
- **仮説駆動の効果検証**: 起票 issue の body に hypothesis ブロック
  （metric/current/target/min_runs/status — canonical `_lib/improve-hypothesis.mjs`）を埋め込み、
  次サイクルの Reconcile が `dev-flow-improve/scripts/hypothesis-check.sh`（決定論 oracle）で
  実測突合する。metric は 3 値 closed enum（iterate_unhealthy_rate / micro_share / cap_pinned_count、
  out-of-enum は error）。not_confirmed は revert 候補として候補プールに入る（自動 revert なし）。
- **throughput cap**: `IMPROVE_MAX=2`/サイクル + open self-improve issue >= 2 で backpressure skip
  （canonical `_lib/improve-rank.mjs`）。open 数取得失敗は fail-closed（skip）。他の失敗は fail-open。
- **state は GitHub issue のみ**: label `self-improve`（起票）/ `self-improve-backlog`（落選 backlog、
  単一 issue）。外部 state JSON なし。
- **telemetry**: 完走時に `journal.sh log dev-improve success --telemetry-json '{...}'` を直接呼ぶ
  （candidates_found / issues_filed / hypotheses_* / backlog_added / backpressure_skipped）。
  dev-flow-doctor がループ自体の不調も診断できる。
- **自己改変 floor**: 候補の target_paths が dev-flow 本体（`.claude/workflows/` / `_lib/` /
  `.claude/agents/` / `tools/`）に触れる場合、issue AC に `/dev-flow-canary` 実行を自動追記。
  コード変更は既存 merge tier ロジックで REVIEW 以上になるが、`.claude/agents/*.md` のみの
  変更は docs 扱いで micro AUTO 推奨になり得る（design §4-3 の REVIEW floor は未実装 —
  follow-up。human merge が最終 gate である invariant は不変）。
