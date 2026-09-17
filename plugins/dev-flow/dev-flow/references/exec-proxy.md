# exec-proxy 詳細

exec-proxy script の起動形詳細、check-ci の argv 転写、maxTurns 計算式、失敗ポリシー表全文。
不変条件は `.claude/rules/dev-flow.md` を参照。本文中の `_lib/` / `agents/` は
`plugins/dev-flow/` を root とする plugin 相対パス。`tools/sync-inlines.mjs` のみ repo root。

## exec-proxy script の起動形（plugin bin/ の bare 名）

workflow / subagent prompt から dev-flow 専用 script を呼ぶときは plugin root `bin/` の bare 名
（`secfloor-classify` / `check-ci` / `journal` 等、拡張子なし）を**先頭トークン**にする。skills 配下の
絶対パスも `bash ` 前置も書かない（plugin install 環境では skills が plugin root 配下に入り絶対パスが
破綻する。`bin/` は plugin enable 中 Bash tool の PATH に載り、dotfiles 側 `sandbox.excludedCommands` は
先頭トークン＝bare 名で登録される。片側だけ変えると dev-flow が止まる）。`bin/<name>` は本体へ
`exec bash` する 3 行 wrapper（.py 本体は `exec python3`）で、本体と隣接 `*.bats` は移動しない。
登録名の集合は `tests/bin-wrappers.bats` と `_lib/bin-bare-name-routing.test.mjs` が pin する
（core `journal` 1 本 + dev-flow 22 本 + playpark-skills 24 本。playpark-skills は
`<skill>-<action>` 命名で `tests/bin-wrappers.bats` が pin）。
`journal_sh` payload の `'journal'`（bare 名）は Stop hook が `command -v` で PATH 上の playpark-core
`bin/journal` に解決する。解決順は payload path → payload bare 名 → `command -v journal` → 隣接
`plugins/playpark-core/skill-retrospective/scripts/journal.sh`（repo checkout / link mode 用）。
いずれも無ければ `no-journal-sh` を log に残し pending を戻す（fail-open）。

plugin version を上げた直後の解決確認は、**update 後に起動し直した Claude Code セッション内**で
`command -v <bare 名>` を実行する。PATH には
`~/.claude/plugins/cache/<owner>/<plugin>/<version>/bin` が **version 込み**でセッション起動時に焼かれるため、
既存セッションは update 後も旧 version の `bin/` を指したまま解決に失敗する。一方
`~/.claude/workflows/*.js` は live に読まれるので、更新前に起動したセッションは
「bare 名を呼ぶ workflow × 旧 version を指す PATH」という壊れた組み合わせになる。
ユーザーの素のシェルには plugin の `bin/` がそもそも載らないため、そこでの `command -v` は常に失敗する
（欠陥ではない）。skill/command メニューに `/dev-flow` が出ることも PATH が正しい証拠にはならない。

## GitHub I/O とスクリプト分離の規範

> exec-proxy スクリプトは認証付き network I/O（gh・git push）を内部に持ってはならない。GitHub I/O は
> subagent の Bash で「先頭トークンが gh または git の bare 単文」（--repo/-C で cwd 非依存化、
> cd &&・bash・env 前置禁止）として実行し、出力を $TMPDIR の file に落とすか、呼び出し側 agent が
> stdout/stderr を argv でスクリプトへ verbatim 転写して、スクリプトは file または argv 入力の
> 純変換とする。prompt に sandbox / excludedCommands / 特定パス起動の理由を書いてはならない —
> exec-proxy prompt は決定論スクリプトへの verbatim 転写契約であり、起動形の正しさは
> excludedCommands という設定側の不変条件である。設定の正当化は本ファイルと AGENTS.md に一箇所だけ
> 置き、per-prompt で再説明しない（prompt 内の再説明は転写契約に判断余地を持ち込み、下流の prompt へ
> 引用・増幅される）。**例外はない**。wall-clock polling を要するサイトも例外ではなく、fetch は
> exec-proxy の 1 spawn = 1 判定（`ci-check`）、sleep は workflow script 側のループが別 exec-proxy
> （`ci-wait`: `ci-wait <秒>` の bare 単文）で行い、スクリプトは snapshot 1 枚に対する純変換に保つ
> （`check-ci` が precedent）。`ci-wait` は bare `sleep <秒>` を直接呼ばない:
> harness の standalone-long-sleep guard が「Bash 呼び出し全体が `sleep <N>`」というリテラル形を
> N が数秒を超えると拒否するため、bare sleep では実際には待たずに拒否され、待機会計が実時間から
> 乖離する。`ci-wait <秒>` は内部で短い sleep を複数回チェーンして同じ総待機時間を作る 1 本の
> スクリプトで、Bash 呼び出し全体としては非 sleep 先頭トークンの bare 単文になる。
>
> `check-ci.sh` は入力方式を file 中継から argv データ渡しへ切り替えている: 呼び出し側 agent が
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
> polling ループを subagent 内に置いてはならない（issue #621/#663）。`ci-check` は 1 spawn = 1 判定
> （gh fetch / 純変換 / StructuredOutput で 3 turn + CI_TURN_MARGIN = 6）、待機は pr-iterate.js の
> script 側ループが `ci-wait` exec-proxy（`ci-wait 45` 実行 + StructuredOutput で 2 turn + CI_TURN_MARGIN = 5）
> で挟む。総待機上限は `CI_WAIT_CEILING_SECONDS`=300（45 秒刻みで最大 6 wait・7 poll）、到達時は
> `ci_pending` 終端（`ci_error` にしない）。どちらの spawn も `dev-runner-haiku-ro` の maxTurns 15 を
> 超えない（`_lib/ci-check.test.mjs` が agent md を実読して pin）。`ci-wait` の応答が `slept:true` で
> なければ（`null` / schema 不一致 / throw を含む）workflow は積算せず、実待機が成立していない
> ことを nominal 加算で隠さずに `ci_pending` で即終端する。

exec-proxy と inline generator は harness-capability-bound な橋（W7 表の capability-bound クラスとは
別の軸: LLM judge 能力依存ではなく harness 機能依存）。workflow runtime に fs / exec が無いという
harness 制約への対応として、決定論スクリプトの実行を dev-runner(-haiku/-haiku-ro/-haiku-wo) subagent に
委譲し stdout を verbatim で返させるパターン（diff-hash / danger-grep / realized-diff / journal / test
実行など 10 箇所超）。least privilege のため capability 別に 4 agent へ分離する: read-only 決定論 proxy
（diff-hash / changed-files(realized-diff) / CI checks read / ui-verify config read /
danger-grep（`--out` 証跡書き込みは
撤去済みで read-only。Security floor の danger-grep は secfloor-classify.sh への統合呼び出し。label・
agentType は不変）/ merge-tier-facts（Merge tier の read-only 事実 6 種 — diff-hash / danger-grep /
changed-files / gh pr view / PR head tree OID / gh pr checks — を 1 spawn で採る統合呼び出し。gh の
2 コマンドは subagent が bare 単文で実行し stdout を argv で script へ転写する））は
`dev-runner-haiku-ro`（tools: `[Bash, Read]` のみ）、書き込み・Skill 呼び出しを
伴う決定論 proxy（test 実行 / redgreen / reconcile-sync / ui-verify server・
teardown / journal 書き込み / PR コメント投稿（post-review / post-summary））は `dev-runner-haiku`
（tools: `[Bash, Read, Write, Skill]`。Write は投稿本文の verbatim 一時ファイル保存に必要）、Write の
みで完結する isolation probe 専任 proxy は `dev-runner-haiku-wo`（tools: `[Write]` のみ。Bash 等の
代替手段を harness レベルで遮断し probe の意味を保証する）、判断寄り（fix/analyze/commit+PR）は
`dev-runner`（sonnet）が担う。全 exec-proxy agent の frontmatter には有限の `maxTurns` を設定する
（dev-runner-haiku-ro: 15 / dev-runner-haiku: 25 / dev-runner-haiku-wo: 5 / dev-runner: 50）。
- 表現: dev-runner(-haiku/-haiku-ro/-haiku-wo) verbatim 転写プロンプト群
- 再評価トリガ: harness が workflow への直接 exec（または fs/exec API）を解禁した時点で、当該プロンプト群を直接実行に置換して exec-proxy ごと撤去する。再検証は `/dev-flow-canary`（read-only capability canary）→ dev-flow-doctor `run-diagnostics --canary` で行う。

## exec-proxy の失敗ポリシー表

決定論ゲートの性質ごとに、失敗検出とポリシーを明示する:

| proxy | 失敗検出 | ポリシー | 理由 |
|-------|----------|----------|------|
| danger-grep（secfloor-unified。統合 exec-proxy `_shared/scripts/secfloor-classify.sh` — label 'danger-grep' 据え置き） | `ok:false` / schema 不一致 / 空出力 / command failure / 統合呼び出し自体の throw・null | fail-closed（全 SEC seed を unchecked）。risk=fail-closed・files=fail-safe(complex floor)・struct=fail-open・diffhash=fail-open の per-field 独立ポリシーを `_lib/secfloor-unified.mjs` の `parseSecfloorFields` が担う。統合呼び出し自体の throw/null/schema 不一致は全フィールドのデフォルト（risk fail-closed が支配）へ倒す。応答 schema（`SECFLOOR`）は `risk`（`ok:boolean` / `hits:array`）のみ required — proxy が payload を `struct` 等へネストして top-level `risk` を欠く形状不一致を StructuredOutput 契約違反として検知し、read-only probe のため `retryOnContractViolation` で同一 prompt を 1 回だけリトライする。retry 後も契約を満たさなければ現行どおり risk fail-closed へ倒し、診断 log を出す。log は fail-closed の 2 原因を `isWellFormedRiskField`（canonical `_lib/secfloor-unified.mjs`。`parseRiskField` の採用条件そのものを共有する述語）で出し分ける — 形状不一致（top-level `risk` 欠落）は応答の top-level キー一覧、proxy が契約通りの形で `ok:false` を報告した場合（`secfloor-classify.sh` 自体の失敗）は `risk.error` を出す。後者で「契約外形状」と出すと正常なキー一覧が並ぶ矛盾した診断になり、真の原因である `risk.error` が落ちる。`files` / `struct` / `diffhash` は required にしない（per-field fail-safe / fail-open 維持） | W7 軸A invariant の security floor。clean と失敗を同一視しない。1 フィールドの欠落が他フィールドの判定へ波及しない（per-field 独立検証） |
| realized-diff（secfloor-unified の files フィールド。Security floor では danger-grep と同一の統合呼び出し経由） | `null` / schema 不一致 | fail-safe（complex floor） | diff 不明時は shape を安全側へ raise する |
| redgreen（`_shared/scripts/redgreen-verify.sh`。受理 glob: `*.test.mjs` / `*.bats` / `*.test.ts` / `*.test.tsx`。`.test.mjs` と vitest 系は `redgreen.conf` の `test_cmd` 設定時に test_cmd 単一起動、未設定時は `node --test` / `npx vitest run` 直接。playwright `*.spec.ts` は層2 で exit 2 拒否。test_cmd 経路が走らなかった invocation は `testcmd_ran:false` + `headdiff`（test_files の HEAD 差分件数）を出力） | `null` / schema 不一致 | fail-safe（inspection 据え置き） | テスト状態不明時は検査済みにしない |
| diff-hash | `null` / schema 不一致 / agent throw（StructuredOutput 未返却・proxy 実行失敗） | fail-open（stale 検出 skip、警告のみ）。Security floor の diff-hash-secfloor は secfloor-unified の diffhash フィールド経由（danger-grep と同一の統合呼び出し。他フィールドと独立に fail-open）。diff-hash-eval / diff-hash-pr / diff-hash-merge の throw は `failOpenAgent` で吸収し null 経路へ合流（run は abort しない）。StructuredOutput 契約違反は read-only probe のため `retryOnContractViolation` で同一 prompt を 1 回だけリトライする | stale 検出の補助信号。失敗しても既存の deterministic gate を緩めない。proxy の実行失敗が run 全体を落とし journal handoff・終端サマリ・Merge tier 判定まで欠落させる経路を除去する |
| merge-tier-facts（Merge tier 統合 exec-proxy。`_shared/scripts/merge-tier-facts.sh` が diffhash / risk / changed / pr / head_tree / checks の 6 サブ結果を `{ok, value, error?}` で返し、`parseMergeTierFacts` がサブ結果ごとに独立検証する） | spawn 全体の `null` / throw / 契約外形状（required は fail-closed の `risk` のみ — 形状不一致は契約違反として `retryOnContractViolation` で 1 回リトライ）/ サブ結果ごとの `ok:false` | per-field: risk は fail-closed（`{ok:false,hits:[]}` 合成 → dangerFailClosed で HOLD 強制）、diffhash / pr / head_tree / checks は fail-open、changed は fail-safe（null → docs/test-only 不成立で AUTO 昇格しない）。spawn 全体の throw は try/catch で吸収し run を abort しない | Security floor の統合呼び出しと同型。1 サブ結果の失敗が他へ波及しないことを script（bats）と parser（unit）の両方で pin する。abort は終端サマリと journal entry を失うため、risk 不明は HOLD で人間へ返す（軸A 不変） |
| diff-hash-reuse（Security floor↔Merge tier の worktree tree OID 一致判定による Merge tier の danger-grep / changed-files 再判定 skip） | secDiffHash null（Security floor の danger-grep fail-closed（risk.ok!==true）/ realized-diff 無効 / diff-hash-secfloor 取得失敗）/ mergeDiffHash null（merge-tier-facts の diffhash サブ結果取得失敗）/ hash 不一致（tree 変化） | fail-safe（再利用せず merge-tier-facts の risk / changed サブ結果で再判定） | 同一入力（byte 一致 worktree tree）の再計算省略のみで distrust の追加/緩和ではない。再利用は risk.ok===true の Security floor 結果に限定し、失敗・不一致・初回は再実行するため danger-grep の fail-closed security floor（W7 軸A invariant）を一切変えない |
| ui-verify（`ui-verify-server.sh` / ui-verifier） | `ok:false` / `null` / schema 不一致 | fail-open（skip + telemetry `failed_open`。install 失敗のみ `setup_failed` で区別） | advisory な UI 検証の補助信号。失敗しても既存の deterministic gate を緩めない。teardown は workflow 側 try/finally + 冪等 stop で保証 |
| ci-checks（`gh pr checks`。merge-tier-facts の checks サブ結果） | checks サブ結果 `ok:false` / schema 不一致 / 該当 check 不在（env_key ごとの check-name regex 不一致） / pending | fail-open（対象 ENV item（turbopack-sandbox / bats-sandbox）据え置き、警告 log のみ） | advisory な環境ノート auto-close の補助信号。判定は envChecksGreen（決定論）のみで LLM に委ねず、失敗しても deterministic gate・merge tier 判定を変えない（軸A 不変） |
| ci-check（pr-iterate CI gate / dev-flow `ci-check-lite`。`gh pr checks` → `check-ci.sh` の argv 転写 2 単文） | `null` / schema 不一致 / agent throw（StructuredOutput 未返却・proxy 実行失敗） | fail-open（throw/null は呼び出し側で吸収。pr-iterate では `status:'error'` を合成して既存の terminal `ci_error` へ流し人間へエスカレーション — run は abort しない。dev-flow `ci-check-lite` では full `pr-iterate` への委譲へ fallback） | CI 状態不明を green と同一視しない（軸A 不変）まま、exec-proxy の実行失敗が run 全体を落とす経路を除去する |
| ci-wait（pr-iterate CI gate の script 側 poll ループが挟む `ci-wait <秒>` の bare 単文。内部で短い sleep をチェーンして総待機時間を作る） | `slept!==true`（`null` / schema 不一致 / agent throw を含む） | fail-closed（このゲートに限る）: 積算せず即座に `ci_pending` で終端する。spawn 回数は CI_MAX_POLLS で有界 | 待機の成否が不明・失敗のとき nominal 秒数を加算すると、実待機ゼロのまま次の ci-check を即座に再 spawn してしまい、CI が実際には完了していないのに poll を消費し尽くして誤った ci_wait_seconds を報告する。待機できなかった時点で pending の可能性が残っており、CI failed/green と誤認しない ci_pending 終端が唯一安全な結末 |
| validate-test（test#i / test#retry-i） | agent throw（EPERM 等の proxy 実行失敗・StructuredOutput 未返却） / 応答 `tests:'error'`（テストが 1 件も実行されなかった起動失敗 — proxy 自身の申告） | throw は fail-safe（当該 iteration を合成 red `tests:'failed'` として green-fix ループ継続。GREEN_MAX 到達で Evaluate へ委譲）。`tests:'error'` は green-fix を起動せず即 break（`no_tests` と同じ扱い。`val` は `green:false, tests:'error'` のまま Evaluate へ進み、Final reconcile の error → unavailable → ci-final 委譲に委ねる。本経路・retry 経路とも同一） | test proxy の実行失敗を run 即死にしない。red を green と同一視しない（軸A 決定論ゲート）。null→need() の中断経路は不変。起動失敗（依存未解決・TLS 失敗等の環境要因）はコード修正で解消しないため implementer を回しても Validate 時間を浪費するだけで、CI 委譲（ci-final）が正規の救済経路。`tests:'failed'`（実行された上での red）は従来どおり green-fix の対象 |
| final-reconcile（reconcile-sync / test#final） | `null` / `ok:false` / schema 不一致 / 非 fast-forward / test#final throw / test#final `tests:'error'`（起動失敗で 1 件も実行されず） | fail-safe（`final_reconcile=unavailable` → merge tier HOLD。unavailable 時は ci-final 行の CI 委譲を試みる） | fix 適用後の最終 tree の test 状態不明を green と同一視しない（軸A 決定論ゲート）。throw も unavailable へ吸収。同様に changed-files-final / ui-verify-config-final は fail-open（UI 再判定・宣言外再監査 skip + 警告 log のみ。test gate は緩めない）。`tests:'error'` を `reverified`+red に潰すと CI 全 green でも救済経路（ci-final）に乗らず偽 HOLD になるため unavailable へ載せる。本物の red（`tests:'failed'`）は従来どおり reverified + HOLD で CI 委譲の対象にしない |
| ci-final（`gh pr view --json headRefOid,statusCheckRollup` による Final reconcile unavailable 時の CI 委譲。reconcile-sync 成功時の head sha を期待値として finalCiVerdict が決定論判定） | `null` / `ok:false` / schema 不一致 / agent throw / headRefOid ≠ 期待 sha / pending / failure / check 0 件 / 期待 sha 無し（sync 失敗時は probe 自体を起動しない） | fail-closed（`final_reconcile=unavailable` 維持 → merge tier HOLD。sha 一致かつ全 success のときのみ `ci_verified` へ昇格） | 最終 tree の test 状態不明を green と同一視しない（軸A 決定論ゲート）まま、CI が同一 sha で同じ suite を回した証拠を人間に手で再実行させない。判定は純関数のみで LLM に委ねない。ENV auto-close の ci-checks（fail-open・tier 不変）とは別経路で、こちらは tier を変えるため sha pin を必須にする |
| final-ac-reconcile（targeted evaluator による既存 AC の最終 tree 再検証） | `null` / schema 不一致 / ac_index 欠落・重複・範囲外 / evidence 空 | fail-safe（`final_ac_reconcile=unavailable` → merge tier HOLD） | fix 適用後の最終 tree での AC 充足不明を satisfied と同一視しない（軸A 決定論検証。fail は既存 AC を uncheck せず critical AC-FINAL-n append — append 単調性・critical-always-blocks 維持） |
| structural-classify（difft による構造変化/フォーマットのみ分類。Security floor では secfloor-unified の struct フィールド経由 — danger-grep と同一の統合呼び出し） | `null` / `ok:false` / `available:false`（difft 未インストール） / schema 不一致 | fail-open（format_only 除外なし・全ファイル精査の現行動作。警告 log のみ） | advisory な diff 前処理の補助信号。失敗しても refloorShape の raise-only・danger-grep・宣言外検出の deterministic gate を一切緩めない |
| vdelta-verdict（redgreen R1↔R2 の deny-only ラベル精度保護） | `verdict null / 不正 JSON / transitions 欠落` | fail-open（deny せず現行の deterministic 昇格判定のまま。fail_open 発生は telemetry `vdelta_fail_open`、test_cmd 経路未起動は `vdelta_not_started` + `redgreen_headdiff` で可視化） | advisory な昇格ラベル精度の補助信号（INV-10: record_integrity=advisory 恒久）。失敗しても red&&green の決定論ゲート自体は緩めない。comparability≠exact は abstain（並列 stream 混入の誤 deny 防止） |
| testsurf（`diff-risk-classify.sh` test-weakening クラス → TESTSURF seed） | danger-grep と同一（`ok:false` / schema 不一致 / 空出力） | 既存 TESTSURF item 据え置き・新規 seed なし（同一スクリプトの SEC fail-closed が全 SEC unchecked → HOLD を担保するため安全側は成立） | 検出は決定論 grep、解除は evaluator clearance（evidence 必須）のみ。hit は `source:'seed'` 常時 blocking で merge tier HOLD（軸A: 決定論 hit を policy で緩めない） |
| pr-create（dev-flow PR phase `pr#<issue>` — `_lib/pr-artifacts.mjs` の `buildCommitMessage` / `buildPrBody` で state（req / plan / ledger / risk hits）から決定論生成した本文を dev-runner-haiku が `.devflow-tmp/commit-msg.txt` / `pr-body.md` へ verbatim 保存し、bare 単文 `git -C <WT> add -A` / `git -C <WT> commit -F` / `git -C <WT> push -u origin HEAD` / `gh pr create --draft --base <base> --head <branch> --body-file` を順に実行。PR body は結論1行 / 変更 / 受入条件 / 設計判断（≤120 字×5）/ 検証 / Closes の上限付き 6 セクション構成（`PR_BODY_MAX_CHARS`）） | `null` / schema 不一致 / agent throw | abort（`need()` 包み — PR 作成失敗のまま継続しない） | commit message / PR body の材料（issue title・type・AC・plan.summary・architecture_decisions・task 一覧）は PR phase 時点で全て state にあり、LLM に diff を読み直させて本文を再生成させる理由がない。agent 側の要約・判断を含めない転写契約は post-comment / commit-ensure と同型（git-commit / git-pr skill は単体起動用に残し dev-flow からは呼ばない） |
| closes-check / closes-recheck（PR body の Closes 行決定論検証。`gh pr view --json body` の応答を `closesVerdict` が判定） | `ok:false` / `null` / schema 不一致 / agent throw | fail-open（`unverified`。警告のみ、再投入は行わない） | probe 自体の失敗を「Closes 欠落」と混同しない。gh の一時的失敗で毎回再投入を走らせない |
| closes-reinject（Closes 欠落検出時、PR 作成時と同一の決定論本文 `prBody` を `.devflow-tmp/pr-body-reinject.md` へ Write し `gh pr edit --body-file` で再投入） | `edited!==true` / `null` / schema 不一致 / agent throw / 再投入後の closes-recheck でも依然欠落 | fail-closed（`missing` → `classifyMergeTier` の HOLD 理由 `pr_closes_missing`） | Closes 欠落は merge 後に issue が自動 close されない実害であり、`hasClosesLine` で決定論確定できるため fail-open にしない |
| ac-checkbox-sync（pr-iterate が fix を適用し lgtm 終端し Final AC reconcile が reverified のときのみ、最終 AC 結果で `buildPrBody` を再生成し `.devflow-tmp/pr-body-final.md` へ Write → `gh pr edit --body-file`） | `edited!==true` / `null` / schema 不一致 / agent throw | fail-open（`pr_body_synced:false` + 警告 log のみ。merge tier に影響しない） | AC checkbox は表示専用。同期失敗で merge を止める理由がない |
| post-comment（pr-iterate post-review#i / post-summary、dev-flow post-summary — PR コメント投稿） | `posted:false` / `null` / schema 不一致 | fail-open（投稿失敗は警告 log のみ。merge tier 判定・ledger・gate に影響しない） | advisory な結果報告投稿。本文は workflow 側で確定済み文字列の verbatim 転写 + `gh` 実行のみで agent 側の要約・判断を含まない（dev-runner-haiku） |
| journal-handoff（journal-save（stage1: payload を worktree 内 gitignored `.devflow-tmp/` へ **Write tool のみ**で verbatim 永続化。保存先は workflow が絶対パスで固定し `savePath` で渡す — repo 配下への Bash 書き込みが deny される環境（skills repo の自己改変ガードは worktree 配下も含む）では `mktemp` が EPERM になり agent が別ディレクトリへ退避して保存先検証に落ちるため、shell に依存させない。agent 申告の path は使わず固定 `savePath` を stage2 へ渡す。worktree を持たない dev-improve のみ `saveDir` + `fileName` モードで、`${TMPDIR:-/tmp}` 配下の固定サブディレクトリを shell 展開で解決する）→ journal-log（stage2: 検証済みファイルパスのみを渡し、**Write tool のみ**で pending/ へ格納。書き込み先は `~/.claude/journal/pending/<prefix>-<id>-effect-<16hex>.json` で、effect ID は payload から JS 側で決まる。stage1 と同じく shell を一切使わない — 単行の複合コマンド（redirect・変数代入・コマンド置換・パイプ）は EnterWorktree 済みセッションで `too complex to verify that it stays inside the worktree` として拒否され、dev-flow / pr-iterate は常にその分離セッションから走るため、shell に依存すると telemetry が全損する。代償として `jq -e` の事前検証と mktemp→mv の atomic 公開は無く、壊れた JSON・部分書き込みは Stop hook の malformed/ 隔離 + replay runbook で回収する）の 2 段。canonical は `_lib/journal-handoff.mjs`） | `saved:false` / `validateJournalSavedPath` 不合格 / `logged:false` / `null` / schema 不一致 / agent throw | fail-open（telemetry が pending/ に届かなくても run は継続。gate・merge tier・ledger には一切影響しない）。ただし結果は返り値 `journal_log_status` の 3 値 closed enum（`logged` / `save_failed` / `log_failed`）に必ず現れる | telemetry は gate ではないので記録失敗で run を落とさない。一方で silent な欠落は dev-flow-doctor / dev-improve の分母を不定量に減らし、doctor 自身が使う journal が書かれないため検知もできない。fail-open を維持したまま欠落を呼び出し元から観測可能にする。stage2 が何らかの理由で失敗した場合も throw は呼び出し側の try/catch が吸収し run は継続する。返り値 `journal_log_status` には常に 3 値 enum のいずれかが現れ、この経路では `log_failed` が必ず観測される（テストで pin） |
| clock 給電（専用 probe 0 回。start は wrapper（dev-flow-prerun、top-level Bash）が渡す `args.setup.epoch`（`date +%s`。必須キーのため fallback 経路は無い）、end は post-summary 応答の optional epoch、残り 9 mark は従来どおり隣接 proxy/agent 応答の optional epoch から給電） | `null` / `ok:false` / schema 不一致 / agent throw（EPERM 等の proxy 実行失敗・StructuredOutput 未返却） | fail-open（当該 mark 欠落 → 対応する duration キー欠落、警告 log のみ。throw は try/catch で吸収） | advisory な duration telemetry の補助信号。失敗しても deterministic gate・merge tier 判定を一切変えない（軸A 不変） |
| analyze-parse（analyze-issue.sh --contract --issue-json <file> 決定論 parse → REQ 転写。issue JSON は subagent の bare `gh issue view --json ...` 出力を $TMPDIR file 経由で渡すファイル入力化を採る） | throw / null / ok:false / schema 不一致 / eligible:false / whitelist 検証（buildReqFromContract）不合格 / `comment_count > 0`（comments がある issue は body/comment 突合のため sonnet へ） | fail-open（現行 sonnet analyze へ fallback — 挙動不変。DEPTH=standard のみ試行） | 高速化の補助経路であり品質ゲートではない。fallback 先が現行経路そのものなので失敗しても後退なし。light path は構造化 breaking 判定を行わない（keyword hit は eligibility で sonnet へ回し、残余は事後の danger-grep / merge tier が補償）。`scope` は 4000 字 cap。cap 超過は `scope_truncated:true` + 末尾 `[TRUNCATED: ...]` マーカーで非 silent にし、sonnet 経路の needs_clarification では missing_context 先頭に切断ヒントを決定論で入れる（silent 切断は末尾に書かれた回答を読み落として needs_clarification を無限に返し、回答追記が事態を悪化させる） |
| analyze-provenance（`gh issue view --json number,title,comments` による sonnet analyze 結果の決定論突合。Analyze phase、sonnet 経路のみ — contract 決定論 parse 採用時は不実行） | `null` / `ok:false` / schema 不一致 / agent throw / issue 番号・title 突合不一致 / probe が comment_count を報告している場合の REQ.comment_count 不一致 | fail-closed（needs_clarification で終端 — 捏造 REQ を Implement へ流さない） | analyze agent に「取得成功」を self-report させない（incentive-structural）。probe が gh に到達できない状況は analyze 側も取得できていない状況そのものであり、捏造 REQ で進行する方が中断より高コスト。comment_count 突合は sonnet analyze が comments を読み落としたまま進む再発を検知するための追加チェックで、probe が comment_count を報告しない場合は判定不能として skip する（既存呼び出し側との後方互換）。light path（analyze-issue.sh --contract）の fail-open fallback は不変 |
| analyze-comment-conflict（sonnet analyze の REQ.comment_conflicts 非空 — body と comment の矛盾を人間へ返す） | comment_conflicts 非空 | fail-closed（needs_clarification で終端） | 決定論スクリプトは意味的矛盾を判定できず、LLM に片方を黙って採らせると訂正が実装に反映されない。明示訂正（comment_overrides）は採用するが log と REQ に痕跡を残す |
| pr-meta（`gh pr view --json mergeable,mergeStateStatus,headRefOid` による base branch conflict 検出、dev-flow Merge tier phase。merge-tier-facts の pr サブ結果） | pr サブ結果 `ok:false` / schema 不一致 / `mergeable=UNKNOWN` 継続 | fail-open（mergeableState='unknown' → conflict gate 不適用、警告 log のみ。definitive な CONFLICTING / mergeStateStatus=DIRTY のみ HOLD） | merge は全 tier 人間であり GitHub 自体が conflict merge を platform で hard-block するため、conflict signal を取りこぼしても実害ある merge は起こり得ない。`mergeable=UNKNOWN` は GitHub の mergeability background 計算中の transient 状態であり fail-safe(HOLD) にすると healthy PR を spurious HOLD する。既存 deterministic gate・security floor を一切緩めず、definitive conflict 検出時にのみ HOLD reason を追加する（軸A 不変） |
| tree-diff-numstat（`git -C <WT> diff --numstat <evalDiffHash> <prDiffHash>` — hash_mismatch 検出直後、PR phase） | `null` / `ok:false` / schema 不一致 / agent throw | fail-open（staleDiffFiles=null → HOLD 理由に両 hash 全文と `git diff --stat` 手動確認手順） | 差分一覧は HOLD 理由の可読性のための補助情報で gate ではない。取得失敗で HOLD を緩めも強めもしない |
| head-tree-oid（`git -C <WT> rev-parse <headRefOid>^{tree}` — merge-tier-facts の head_tree サブ結果。script が pr.headRefOid から無条件に採り、JS は hash_mismatch かつ headRefOid 取得済みかつ mergeDiffHash 非 null のときのみ参照する、Merge tier phase） | head_tree サブ結果 `ok:false` / schema 不一致 / headRefOid 欠落 / mergeDiffHash null | fail-open（hash_mismatch 維持 → HOLD。3 条件成立時のみ hash_reconverged へ置換） | HOLD を外す方向にだけ決定論証拠（PR head tree = merge 対象 tree = 評価済み tree）を要求する。証拠が取れなければ既存どおり HOLD（軸A 不変） |
| pr-meta（pr-iterate Iterate phase の url/head_ref/cwd/epoch 取得 probe。label 'pr-meta'。nested 起動（dev-flow → `workflow('pr-iterate')`）では起動されず dev-flow が `args.nested` で同値を供給、単体起動時のみ実行） | null / schema 不一致 / throw | fail-open（cwd 欠落は isoWt='.' fallback + telemetry `save_failed`、epoch 欠落は isoToken が PR 番号へ fallback） | advisory な meta 取得。probe 失敗で run を落とさない |
| issue-labels（`gh issue view --json labels` による empty-diff gate の cross-repo lazy ラベル probe。dhGate.empty===true 時のみ実行） | null / `ok:false` / schema 不一致 / throw | fail-safe（非 cross-repo 扱いで既存 empty-diff fail-closed 経路（差し戻し1回→再度空なら throw）を維持） | ラベル不明を人間の opt-in 成立と同一視しない。成果物は worktree/外部 repo に残存するため破壊的ではなく、throw メッセージにラベル付与のヒントを追記して人間の再実行を促す |
| commit-ensure（subagent の bare git 単文シーケンス（`git status --porcelain` 空判定 → `git add -A` → `git commit` → `git push`（失敗時 `git push -u origin HEAD`）→ 再 `git status --porcelain` → `git rev-list "@{u}"..HEAD --count`）による決定論検証 — fix 適用直後の未コミット変更検証 + commit/push 回収。pr-iterate AC-3） | null / schema 不一致 / agent throw / dirty なのに committed・pushed が true でない | fail-safe（terminal='fix_failed' で人間へエスカレーション） | fix agent の self-report（applied:true）を commit 済みと同一視しない（incentive-structural: 完了宣言を当事者に self-judge させず決定論 git 検証で突合）。未コミット/未 push のまま次 iteration へ進むと再 review が stale な PR diff を見る |
| worktree-dirty（subagent の bare `git status --porcelain` 単文 — pr-iterate 非 lgtm 終端時の作業ツリー dirty 検出。pr-iterate AC-2） | null / schema 不一致 / agent throw | fail-open（worktree_dirty='unknown' + 警告 log のみ。status・gate 判定へ影響しない） | advisory な終端観測 telemetry（'dirty'/'clean'/'unknown' の 3 値）。probe 失敗で run を落とすと異常終端の素通しを再生産する |
| isolation-cleanup（subagent の bare `git -C <worktree> clean -fdx -- <target>` 単文 — probe 直前の残置物除去。dev-flow は prerun（top-level Bash）が run 開始前に `.devflow-tmp` 全体を `git clean -fdx` 済みのため、subagent 呼び出し自体が無い。pr-iterate は単体起動時のみ canonical `_lib/isolation-probe.mjs` の exported 定数 `ISOLATION_PROBE_CLEANUP_GLOB`（`.devflow-tmp/.isolation-probe*` — probe の token 形・legacy 無 token 形の両方にマッチ）単体を対象に subagent 呼び出しで cleanup を実行する。nested 起動（dev-flow → `workflow('pr-iterate')`）では pr-iterate 側の呼び出し自体を skip する — dev-flow 側の prerun cleanup が同一 worktree の run 間衛生を既に担保済みのため） | `cleaned:false` / null / schema 不一致 / agent throw | fail-open（警告 log のみ。gate・merge tier・security floor へ影響しない） | probe 対象パスが run 毎に一意なため、除去に失敗しても probe は前 run の残置物と衝突せず成立する（cleanup 成功への依存を切った）。cleanup 自体を fail-closed にすると、除去対象が無い正常系（新規 worktree）と区別できない失敗で run を落とす |
| cross-repo-artifacts（`_shared/scripts/cross-repo-artifacts.sh` による worktree 外 working tree の dirty 検証。cross-repo ラベル検出時のみ実行） | null / `ok:false` / schema 不一致 / found=0 | fail-safe（handoff 不成立で既存 empty-diff fail-closed 経路へフォールスルー。ラベルのみで gate を skip しない） | 決定論的証拠（dirty working tree）なしに gate を skip すると軸A invariant（決定論ゲートを LLM/ラベルで緩めない）に反する |
