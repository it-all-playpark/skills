# dev-flow telemetry キー詳細

telemetry ハンドオフの各キーの語彙定義と Stop hook の二経路転送。不変条件は
`.claude/rules/dev-flow.md` を参照。本文中の `.claude/workflows/` / `_lib/` は
`plugins/dev-flow/` を root とする plugin 相対パス。

- **telemetry**: dev-flow 完走時に workflow が telemetry handoff JSON（merge_tier / gate_policy / danger_hits / shape /
  shape_refloored / plan_iter / eval_iter / eval_staleness / eval_verdict / iterate_status / ui_verify / ui_verify_mode /
  final_reconcile / final_test_green / final_ui_verify / final_ac_reconcile / testsurf_hits / redgreen_deny /
  vdelta_fail_open / vdelta_verdicts / vdelta_not_started / redgreen_headdiff / duration_seconds / phase_durations /
  merge_tier_reasons / route / subagent_invocations / resolved_evidence /
  shape_reason / estimated_file_count / realized_file_count / realized_file_count_raw / ac_count /
  analyze_path / analyze_ineligible_reason）を
  `~/.claude/journal/pending/` へ書き出し、
  dev-flow plugin の Stop hook `plugins/dev-flow/hooks/stop-devflow-telemetry.sh`
  （`hooks/hooks.json` から plugin root 変数経由で発火）が
  `journal.sh log dev-flow success --merge-tier ...` へ毎回自動 flush する。flush 失敗は
  `~/.claude/logs/stop-devflow-telemetry.log` に記録され pending file が残るため記録漏れに
  気づける。journal.sh の telemetry フラグは未指定なら telemetry キー無し。calibration の原資料。
  `ui_verify` は `skipped`/`passed`/`findings`/`failed_open`/`setup_failed` の 5 値（`setup_failed` は dev-flow-doctor の検出対象）。
  `eval_staleness` は `none`/`hash_mismatch`/`hash_reconverged`/`iterate_incomplete`/`iterate_fixed` の 5 値（Evaluate 時点と PR tree の乖離原因を区別する。`hash_reconverged` は PR 直前に一時乖離したが PR head tree と merge 対象 tree が評価済み tree と一致することを決定論確認済みで HOLD しない）。
  cross-repo issue（修正対象が本 repo 外にある issue）で empty-diff gate が graceful 終了する run は
  `journal.sh` の `error_category` に `cross_repo`（`outcome:'partial'`）を記録し、dev-flow の返り値は
  `status:'cross_repo_artifact'`（`issue`/`worktree`/`branch`/`artifacts`/`note` を含む）を返す。
  `empty_diff` failure として誤記録せず dev-flow-doctor の異常検知（iterate 不調率等）の統計を汚さない。
  当該機構は W7 分類上 blast-radius（人間ラベル opt-in + 決定論的 dirty 検証が揃った
  場合のみ graceful 終了する仕組みで、gate の fail-closed 既定は不変）。
  guard/hook 由来 BLOCKED（block_class:'guard_blocked'。inline-edit-guard deny / sandbox EPERM /
  safety classifier block / bg-isolation 等）が Implement phase で 1 件以上発生した run は、
  成功 handoff（`outcome:'success'` のまま）に `error_category:'guard_blocked'` と telemetry キー
  `guard_id`（発生した guard_id を unique・sort した上で comma 結合した文字列。各要素は
  pattern `^[a-z][a-z0-9-]{0,39}$`）が付く。guard_id は `PER_KEY_TELEMETRY_KEYS` に含まれ、
  Stop hook の per-key flag `--guard-id` で journal に到達する（passthrough 経路ではない。
  後述「二経路転送」の不変条件を参照）。
  run が journal handoff 到達前に throw で abort した場合、dev-flow.js / pr-iterate.js の
  top-level try/catch が `outcome:'failure'` + `error_category:'abort'` +
  `error_msg:'abort@<phase>/<label>: <message>'`（500 字まで）+ `error_phase`（journal の
  `.error.phase`。run-diagnostics の failure_distribution に乗る）+ telemetry `abort_phase` /
  `abort_label`（passthrough 経路）と、その時点で確定していた telemetry（shape / plan_iter /
  eval_iter / gate_policy / subagent_invocations 等）を記録し、元の例外を rethrow する
  （fail-open: handoff 失敗は run 終了を妨げない。終端サマリ・Merge tier は実行しない —
  判定前提が揃わないため）。abort entry の組み立て口は `_lib/journal-handoff.mjs` の
  `buildAbortHandoffPayload` のみ（legacy fallback / version 分岐なし）。dev-flow の WT 未確定
  abort（Setup の args.setup 検証（prerun-setup）段）は payload を `~/.claude/journal/abort-payload/` へ
  退避する（validateJournalSavedPath は `~/.claude/journal/` prefix のみ tilde 受理）。
  empty_diff 経路は writeFailureTelemetry が先に記録済みなので abort entry を二重記録しない。
  nested pr-iterate が abort した run は pr-iterate と dev-flow の abort entry が 1 件ずつ残る
  （成功 run の 2 entry と同じ二重計上規則 — 集計は dev-flow entry のみ使う）。pr-iterate にも
  同種の穴があった（handoff は終端 1 箇所のみで isolation probe の fail-closed throw 等で全損）
  ため同機構で塞いだ。
  `final_reconcile` は `skipped`/`reverified`/`unavailable`/`ci_verified` の 4 値（fixes_applied=0 は `skipped`、worktree 同期・test 再実行に成功したら `reverified`、同期失敗・schema 不一致・test#final `tests:'error'`（テストが 1 件も実行されなかった起動失敗 — 本物の red `tests:'failed'` とは区別し `finalTestGreen` は null 据え置き）は `unavailable`、`unavailable` のうちローカル再検証は不能だが PR head sha に pin した CI check 全 success を決定論確認できた場合のみ `ci_verified`）。
  `final_ac_reconcile` は `skipped`/`reverified`/`unavailable` の 3 値（fix 適用 run で final test が green/no_tests かつ AC が 1 件以上のときのみ targeted evaluator を one-shot 起動して Analyze 時点の既存 AC を最終 PR tree に対し再検証する。index 完全性・evidence 非空の決定論検証に合格すれば `reverified`、agent null・schema/index/evidence 検証不合格は `unavailable` → merge tier HOLD。未実行は `skipped`）。
  `pr_closes_status` は `verified`/`reinjected`/`missing`/`unverified` の 4 値（passthrough 経路。常時出力。PR 作成直後の `gh pr view --json body` による Closes 行決定論検証結果。`missing` は再投入も失敗し `classifyMergeTier` の HOLD 理由 `pr_closes_missing` に載る）。
  `pr_body_synced`（passthrough 経路。boolean。pr-iterate が fix を適用し lgtm 終端し Final AC reconcile が `reverified` のときのみ AC checkbox 同期を実施し出力。未実施はキー自体を省く）。
  `final_test_green` は final test 実行時のみ出力（Final reconcile が `reverified` の場合のみ。`ci_verified` はローカル test を再実行していないため出力されない）。
  `final_ui_verify` は final UI 再検証実行時のみ出力（`ui_verify` と同語彙: `skipped`/`passed`/`findings`/`failed_open`/`setup_failed`）。
  `testsurf_hits` は test-weakening pattern 名の配列（常時出力、hit 無しは空配列）。
  `redgreen_deny` は `{ac, reasons}` の配列（deny 発生時のみ出力）。
  `vdelta_fail_open` は test_cmd（vdelta run）経路が起動した redgreen invocation のうち verdict が欠落/不正だった件数（>0 時のみ出力）。`vdelta_not_started` は test_cmd 経路が起動しなかった redgreen invocation 数（>0 時のみ出力。bats 等 `redgreen.conf` の test_cmd に乗らない runner のみの AC で発生する。RunStore に run pair が無く verdict 不在が期待値なので `vdelta_fail_open` には数えない）。`redgreen_headdiff` は未起動 invocation の per-AC digest 配列（`{ac, status, new, modified, unchanged, total, red, green}` のみ。status は `clean`/`test_modified`/`fail_open` の閉じた enum。test_files のうち HEAD に存在し worktree と差分があるものが 1 件以上で `test_modified`、HEAD に無い新規 test は `new` に数え clean 扱い。redgreen-verify.sh が git 差分から決定論で算出し、runner の種類・拡張子に依存しない。`red`/`green` は同一 invocation の impl_files red→green 実証結果（rg.red/rg.green）をそのまま複合させたもの — status（test_files の HEAD 差分）だけでは red=false（昇格せず）の AC も status=test_modified の他 AC と区別できないため、「test 改変を伴う red→green」を telemetry 単体（`status === 'test_modified' && red === true && green === true`）で識別できるようにする。記録専用 — deterministic 昇格・redgreen deny・merge tier の入力にはしない）。
  `vdelta_verdicts` は per-AC digest 配列（`{ac, status, comparability, verification_surface, repaired_with_test_change}` のみ。raw verdict・anchors・テスト名は redaction 原則で保存しない。単一キーへの上書き出力・dual-key 併記はしない）。
  `duration_seconds` は run 全体の wall-clock 秒（clock#start 〜 clock#end）。
  `phase_durations` は analyze / plan / implement / validate / evaluate / pr / iterate / final の 8 phase の秒数 object。
  各 phase は開始〜終了の全体時間（plan-review loop / evaluate 差し戻し loop 等の内部反復を含む）。evaluate 区間は
  Security floor を含む。micro path（Evaluate skip）では evaluate キー自体が欠落し pr は直近 mark（validate_end）
  起点で計算される。時刻は専用 clock probe を起動せず、start は wrapper（dev-flow-prerun、top-level
  Bash）が渡す `args.setup.epoch`（`date +%s`。必須キーのため fallback 経路は無い）、end は Merge tier 末尾の
  post-summary 応答の optional epoch から給電し、残り 9 mark は phase 境界に隣接する既存 exec-proxy / agent
  応答の optional epoch フィールドから給電する（fail-open 不変）。
  **給電元応答の完了タイミング依存の skew（contract 経路の analyze_end は shape 判定の
  時間が plan 区間へ付け替わる等）を含むため、絶対値ではなく相対比較・分布用途で解釈すること。
  Final reconcile skip 時（fixes_applied=0）は final キー自体が欠落する**。probe 失敗は fail-open（当該 mark null →
  対応する duration キーが欠落。全滅時は両キーとも handoff JSON に現れない）。
  `merge_tier_reasons` は merge tier 判定理由の文字列配列。`route` は PR phase の経路識別子
  （`lite`|`full` の 2 値 enum）。
  `fix_terminal_reason`（pr-iterate entry のみ。`null_after_retry` / `applied_false` /
  `commit_unensured` の 3 値 closed enum。`iterate_status:'fix_failed'` の run では必ず存在し、
  それ以外の終端ではキー自体が欠落する。fix agent の null（1 回 retry 後も null）/
  applied:false（agent の明示判断）/ commit 保証失敗を区別する）。
  `terminal_path`（pr-iterate entry のみ。`ci`|`review` の 2 値。各 iteration 冒頭で `review` に戻し
  CI-failed 分岐に入った時点で `ci` へ上書きするため、**最終 iteration が CI-failed 分岐に入ったか**を表す。
  CI-failed のまま MAX に達した run は `max_reached` でも `ci` になる。`ci_error` / `ci_pending` は
  CI-failed 分岐より前で break するため CI 起因でも `review`）。
  `quality_model_config`（dev-flow / pr-iterate 両 entry、成功・失敗とも記録。`_lib/quality-model.mjs`
  の `QUALITY_MODEL` **設定値**。agent() は agentType しか観測できず frontmatter 由来の実モデルは
  workflow から取得できないため、キー名で設定値であることを明示する）。
  `quality_model_fallback_label`（dev-flow / pr-iterate 両 entry、成功・失敗・abort とも。`opts.model`
  付き call が null を返して model 指定を外した再試行へ切り替えた**最初の call の label**（例
  `plan#standard` / `eval#1` / `review#1`）。未発生時はキー自体を省く — null 値は passthrough で落ちる
  ため「無し」はキー欠落で表す。`quality_model_config` と組み合わせて、run の品質ゲート agent が
  純 `quality_model_config` / 途中から frontmatter 既定へ混在（どの label から）/ 純 frontmatter 既定
  （`quality_model_config` が既定と同値）のどれかを導出する。nested pr-iterate は sticky を
  `args.nested.quality_fallback` で継承するだけで自 run では発火しないためキーを持たない — 混在の
  導出は親 dev-flow entry で行う（`subagent_invocations` と同じく集計は dev-flow entry のみを使う）。
  `plugin_version`（同上両 entry。`_lib/plugin-version.mjs` の `PLUGIN_VERSION` 定数。workflow では
  plugin root 変数が展開されず fs も使えないため定数で持ち、`_lib/plugin-version.sync.test.mjs`
  が `plugins/dev-flow/.claude-plugin/plugin.json` の version と一致することを pin する。plugin.json
  を上げるときは canonical も上げて `tools/sync-inlines.mjs --write` を実行する）。
  `iterate_history`（pr-iterate entry のみ。round ごとの `{iteration, decision, summary, blocking, minor,
  scope, delta_lines}` 配列。CI-failed round の blocking は synthetic な `ci::<check>` topic の finding。
  `scope` は `'full' | 'delta'` — review#i（i ≥ 2）が fix delta（前 round の review 時点の head sha ..
  現在 HEAD、`_lib/review-delta.mjs`）に絞れたか。sha が取得できない round は `'full'` にフォールバック
  する。`delta_lines` は delta の変更行数（`git diff --shortstat` の insertions + deletions。full は
  null）。非 trust キーで enum 検証は無し。dev-flow-doctor の `distributions.review_delta` が round ≥ 2
  の blocking 件数 / delta round 数を集計する）。
  run 返り値（telemetry ではない）には加えて `merge_tier_hold_reasons`（`[{reason, kind}]`。
  `kind` は `deterministic_recheck`（決定論再チェックで解消しうる HOLD。Final reconcile
  unavailable の CI 不成立理由のうち pending / fetch-failed / invalid）と `human_judgment`
  （人間判断が必須な HOLD。sha-mismatch / failure / no-checks / no-expected-sha および
  既存の他 HOLD 理由は全て human_judgment）の 2 値 closed enum）と `merge_tier_hold_kind`
  （集約値。human_judgment が 1 件でもあれば `human_judgment`、全件 deterministic_recheck なら
  `deterministic_recheck`、tier が HOLD でなければ `null`）が乗る。呼び出し元はこの 2 フィールドで
  「解消を待てば済む HOLD」と「人間確認が要る HOLD」を区別する。
  `subagent_invocations` は `{total, by_type}` の object（常時出力）。total は run 全体の agent() 起動数で、
  workflow 内の counting wrapper（trackedAgent — 全 call site を wrapper 経由に置換し、bare `agent(` 残存ゼロは
  `_lib/subagent-invocations-routing.test.mjs` が CI 保証）が計上する。nested `workflow('pr-iterate')` の起動分は
  pr-iterate の返り値 `subagent_invocations` を dev-flow 側 counts へ合算する（lite route 非昇格時は pr-iterate
  呼び出し自体が無いため合算 0。単体起動の pr-iterate は自身の handoff に同キーを記録）。
  nested 起動時は同じ counts が pr-iterate 側 journal entry にも記録されるため、journal を skill 横断で
  単純合計すると二重計上になる（集計時は dev-flow entry のみを使う）。by_type は agentType 別の
  起動数（動的キー — enum 強制なし。dev-flow.js の実測 agentType は dev-implement-fable /
  evaluator / pr-reviewer / dev-runner / dev-runner-haiku / dev-runner-haiku-ro / dev-runner-haiku-wo /
  ui-verifier の 10 種、agentType 欠落は 'unknown'）。canonical は `_lib/subagent-invocations.mjs`、dev-flow.js / pr-iterate.js への inline は
  tools/sync-inlines.mjs で生成する。実 token 消費は workflow runtime（agent() 返り値は schema 準拠 JSON のみで
  usage metadata なし）から取得不可のため、起動数 × agentType がトークン効率の proxy metric。
  journal.sh の `--subagent-invocations` フラグ（object 検証違反は当該キーのみ drop する fail-open）に到達済み。
  **shape 判定 / analyze 経路の根拠（成功 handoff のみ・passthrough 経路・gate / merge tier / ledger の
  入力にはしない。dev-flow-doctor の「shape 較正」が読む）**:
  `shape_reason` は `classifyShape` が返す `reason` 文字列（`estimated N file(s), M AC, type=… → floor=…` の
  閾値判定 / `LLM raised A→B` / それ以外は safe floor の種別 — doctor はこの prefix で 3 分類する）。
  `estimated_file_count` は analyze の `estimated_change_file_count`（欠落時 `null`。Stop hook の passthrough は
  null 値を落とすため journal ではキー欠落として現れる — doctor は欠落と null を同一に扱う）。
  `ac_count` は `acceptance_criteria.length`。
  `realized_file_count` は Security floor で `refloorShape` に渡した数 — **ephemeral / 宣言外パス / format-only
  を除外した後**の realized diff（取得不能 NaN は `null`）。`realized_file_count_raw` は ephemeral 除外のみの
  realized diff 総数。両方載せるのは、宣言外・format-only の除外で refloor 入力が閾値内に収まり raise が
  不発になった run（raw は閾値超・count は閾値内）を doctor が「取りこぼし」として数えるため —
  count だけでは閾値超かつ `shape_refloored=false` は構造上 0 件になり見えない。
  refloor は Security floor 時点の working tree を見るので、pr-iterate fix / base merge / 手動 commit で
  後から膨らんだ PR の changedFiles とは一致しない（journal から PR の最終規模は復元できない）。
  `analyze_path` は `contract`（`analyze-issue.sh --contract` の決定論 parse 採用）/ `sonnet` の 2 値。
  `analyze_ineligible_reason` は light path 不採用のときのみ出力（採用時はキー欠落）。`analyze-issue.sh` が
  返した `ineligible_reason` を verbatim で載せ、probe が例外 / 失敗 / eligible だが whitelist 不合格 /
  DEPTH が standard 以外で未試行、の workflow 側理由はそれぞれ `contract probe exception` /
  `contract probe failed` / `whitelist rejected` / `contract not attempted (depth=<DEPTH>)` の固定文字列。

## Stop hook の二経路転送

`plugins/dev-flow/hooks/stop-devflow-telemetry.sh` は telemetry を二経路で転送する。enum/型検証が
必要なキー（hook 内 `PER_KEY_TELEMETRY_KEYS` に列挙。trust 系・route・review_decision 等）は
per-key flag で fail-closed（契約違反は drop + `trust-key-dropped` / `telemetry-key-dropped`
ログ）、それ以外は `.telemetry` から同配列のキーを除いた残りを `--telemetry-json` で丸ごと
journal.sh へ渡す。**新規 telemetry キーは workflow の handoff に載せるだけで journal に到達し、
hook の変更は不要**。per-key flag を新設するときは `PER_KEY_TELEMETRY_KEYS` にも必ず足す
（journal.sh のマージ順は flag ごとに前後が混在し — `merge_tier`〜`ci_poll_attempts` の 12 flag は
`--telemetry-json` より前、`trust_*` 以降は後 — 前にマージされる側では drop 済みの契約違反値を
passthrough が上書き復活させ fail-closed が迂回される。除外が唯一の一貫した防御。test.sh は
jq projection ブロック内の `.telemetry.<key>` / `has("<key>")` 参照と配列の一致を静的に pin する
— hook 全文を grep するとコメント文字列だけで pass するため対象を projection に限定している）。gate・merge tier・ledger・shape 判定には
一切影響しない telemetry 専用キー（軸A invariant 非抵触）。
testsurf_hits / redgreen_deny / vdelta_fail_open / vdelta_verdicts / duration_seconds / phase_durations /
merge_tier_reasons / route の 8 キーは journal.sh の専用フラグ（kebab-case、検証違反は当該キーのみ drop
する fail-open）に到達済み。
`vdelta_not_started` / `redgreen_headdiff` は passthrough 経路（専用フラグ無し。doctor 側が enum 外
status を fail_open に畳むため送り側検証を持たない）。
`resolved_evidence` は終端サマリーが件数のみ表示する解消済み証跡の全文
`{cap_chars, truncated, ledger_resolved[], env_notes[], ac_satisfied[], security_cleared[]}`（4 配列
すべて空ならキー欠落）。text/evidence は 1 フィールド 1000 字 cap、総量が 16000 字以下になるまで
cap を半減する決定論 cap — journal-save stage1 は payload を prompt 経由で LLM が転記する経路であり、
肥大した payload は転記破損で run の telemetry 全体を失うため。canonical `_lib/resolved-evidence.mjs`
（summary-format と同一の選別述語）、passthrough 経路で journal 到達（hook 変更不要）。表示・記録専用で
merge tier / ledger / gate_policy の判定入力にはならない。
`eval_confidence` / `review_confidence` は `[0,1]` または `null`（evaluator / pr-reviewer の verdict
自己申告 confidence）。agent が実行されたが confidence を返さない run は `null` を記録し、
agent 自体が実行されない run（micro の Evaluate skip 等）はキー自体が handoff から欠落する
（`null` とキー欠落を区別し、doctor 側の記録率分母は `has()` で判定する）。full route の
dev-flow entry は `review_confidence` キーを持たない（review は nested `workflow('pr-iterate')`
側で行われるため）— 実値は同 run の pr-iterate entry 側に記録される（`subagent_invocations` の
二重計上防止と同じ理由）。`review_decision`（`approve`/`request-changes`/`comment`）は
confidence と verdict の突合用に併記する。いずれも記録専用で、merge tier / ledger /
security floor / gate_policy のいずれの判定入力にもならない（軸A 非抵触。calibration 原資料）。
