# dev-flow 改善施策リスト（2026-10）

4 観点（abort/HOLD 回収・出力の読みにくさ・コストと時間・精度）を fable-xhigh-researcher が並列に調べ、その結果を統合したもの。データの範囲は journal の 60〜90 日分、merged PR 15 件、transcript 5 run、コードは main `c838fee`。要所の file:line は統合時に現行コードで確かめた。

## 採否の基準

- **除外**: 精度・コスト・UX のどれかが悪化する案。理由は末尾に一行ずつ残した。
- **順位**: 三軸すべてが改善し、その根拠が実測であるものを上に置く。効果の根拠が「推定」だけのもの、精度が「＝（悪化なし・改善なし）」のものは下げる。
- 表記: ↑ 改善 / ＝ 変化なし / 推 推定のみ / 測 実測あり
- 不変条件（merge は人間 / 軸A / 1 issue=1 PR / Implement は dev-implementer 1 spawn / 後方互換 scaffolding なし / inline 区間は生成物）にはどの施策も触れない。inline 区間を変える施策は canonical 側を直したうえで `tools/sync-inlines.mjs --write` で再生成する。

## 現状の実数

| 指標 | 値 | 出典 |
|---|---|---|
| dev-flow run（60 日） | 158（REVIEW 72 / HOLD 50 / abort 18 / needs_clarification 16 / empty_diff 2） | journal |
| うち PR phase で abort | **17 / 18**（Implement〜Evaluate を終えた後に落ちる） | journal |
| pr-iterate run（60 日） | 216（lgtm 176 / fix_failed 20 / stuck 6 / ci_pending 5 / 他 9） | journal |
| 手動回収 | 36（PR phase abort 17 + HOLD・非 LGTM 後の単体 pr-iterate 16 + isolation-probe abort 3） | journal の join |
| 偽 HOLD・偽 red | HOLD 15/79（final test red 5・再検証不能 3・hash_mismatch 4・closes 2・他 1）。**すべて修正済み**だが、修正はどれも個別対処 | journal / git log |
| merge 後に修正が要った follow-up チェーン | 12（観測型 AC の偽 pass 7 件を含む: #471→#491→#495 の 3 連続 merge の末に trust-layer を撤去） | gh |
| AC 判定の根拠 | test 199 / **inspection 50（20%）**。inspection もその場で checked になる | journal / `dev-flow.js:6221,6247` |
| evaluator が pass した後に reviewer が blocking を出す | 19/65 run（29%） | journal |
| 所要時間の中央値（09-24 以降） | micro 1204s / standard 1604s / complex 1877s（complex では implement 753s が最大） | telemetry n=56 |
| $ の構成 | implementer 50〜85%、haiku proxy は 1 run あたり $1.2〜2.5 | transcript 5 run |
| skills repo の時間の最大要因 | テスト実行が 30〜45%（test#1 178s + redgreen 約 350s + test#final 176s） | transcript |
| PR 本文の「…」切り詰め | 59 行 / 15 PR（13 PR で発生） | gh |
| 終端サマリ | 平均 3,621 字。うち 65% は折りたたみ内。読み手を迷わせる要素は 179 件 / 15 PR | gh |

承認済みの判断（evaluator・fix の effort medium、implementer の opus、evaluator prompt の簡素化、bats の並列化、reviewer の lock 除外、ci-check の並列化、journal の 1 spawn 化）は**すべて repo に反映済み**で、未反映のものは無い。

## 施策（優先度順）

### Tier 1 — 三軸とも改善、根拠は実測、規模 S〜M

#### 1. テスト実行を決定論 exec-proxy `bin/run-tests` に置き換える（Validate / test#final / post-eval）
- **対象**: 全 run の test spawn（1 run に 1〜3 回）。偽 red・再検証不能による HOLD 8 件（#619 #720 #731 #732、memory に残る誤検出 #553 #555）。
- **根本原因**: `dev-flow.js:5052-5076` の `VALIDATE_TEST_PROMPT` が haiku に 20 行を超える規約を渡し、スクリプトの選択・起動失敗の分類・failed_files の抽出まで任せている。`bin/` には redgreen-verify / workspace-prebuild はあるが、テストを実行する proxy が無い。
- **変更**: 純 bash の `bin/run-tests <WT>`（workspace-prebuild → 実行ビットのある `tests/run-*.sh` を全本、bare 絶対パスで実行 → `{status, scripts:[{path,exit,launch_failed}], failed_files}` を 1 行で出す。failed_files は `not ok` / `FAIL ` 行の grep で取る）。prompt は redgreen と同じ verbatim 転写型にする。GREEN schema は変えない。skills repo 側では別途 `tests/run-all-bats.sh` と `run-node-tests.sh` を並列起動する単一の `tests/run-tests.sh` にまとめる（両方を `run-*.sh` glob に残すと二重に実行されるので、既存 2 本は `tests/suites/` へ移す）。
- **効果**: 精度↑（測: green 判定が exit code 由来になり、1 本の省略や独断の環境操作が構造的に起きなくなる）/ コスト↑（推: prompt −1.5KB × 2〜3 spawn、haiku の turn 減）/ UX↑（測: 偽 HOLD の再実測という手戻りが消える。skills では並列化で −70s × 1〜3 回/run）。
- **検証**: `run-tests.bats`（exit 0/1/126 の fixture）、`validate-test-prompt.test.mjs` を転写契約に書き換える、skills と shift-bud で 1 本ずつ実測、直列と並列を hyperfine で比べる。
- **規模**: M。network を使わない bare 名の exec-proxy で、決定論 oracle を強めるだけなので軸A の内側。

#### 2. redgreen-verify のペア重複を除き、background 化を防ぐ
- **対象**: Evaluate の `redgreen` spawn。skills の 2 run で 349s / 355s（run 全体の 21〜28%）。
- **根本原因**: `dev-flow.js:6204-6223` が AC ごとに rgTargets を積む。df-803 では 7 AC がすべて同じ (test, impl) ペアで、red/green を 7 回回していた。さらに 120s を超えると Bash が background 化し、haiku が待ったあとに同じコマンドを再実行する（df-803 と df-785 の両方で発生）。PR push には `timeout: 600000` と background 禁止の指示がある（`pr-artifacts.mjs:607-609`）が、redgreen には無い。
- **変更**: (a) `(test_files, impl_files)` をキーに dedupe し、結果を共有する AC すべてに配る（rgTargets の構築は純関数に切り出す）。(b) redgreen の prompt に `timeout: 600000` の明示と `run_in_background` の禁止を足す。
- **効果**: 精度＝〜↑（同じ tree・同じペアなので判定は同値。並走による混線が消える）/ コスト↑（測: polling turn 分 −$0.05〜0.1）/ UX↑（測: skills で −150〜300s/run）。
- **検証**: dedupe を vitest で pin、df-803 のペアで 1 回実行と 7 回実行の結果一致と所要時間を hyperfine で比べる。
- **規模**: S

#### 3. PR phase の失敗は throw せず、「成果物付きの failure 終端」で返す
- **対象**: PR phase abort 17 件 / 60 日。原因は 4 回入れ替わった（`git -C` → credential → StructuredOutput 未返却 → pre-push hook）が、回収手順は毎回同じだった（transcript から branch・commit・失敗段を復元 → push → PR → /pr-iterate）。いまも #819 / PR #820 が未解決。
- **根本原因**: `dev-flow.js:6568-6570` の `if (prFailure) throw`。top-level の catch（`:7373-7390`）が渡す abort payload は 6 キーだけで、phase_durations も eval_verdict も失われる。
- **変更**: `prPhaseFailure` が非 null のときは graceful 終端（`error_category:'pr_phase_failed'`、`failed_step`、`failure_reason`、`committed`、`head_sha`、branch、phase_durations、shape、eval_verdict）を返す。wrapper（`dev-flow/SKILL.md`）が top-level の bare `gh issue comment` で回収 3 コマンド（`git push -u origin HEAD` → `gh pr create --draft --body-file .devflow-tmp/pr-body.md` → `/pr-iterate <N>`）を投稿する。commit message と PR body はすでに `.devflow-tmp/` に保存されている（`:4561-4566`）。run 内での再 push はしない（#819 の AC と整合）。
- **効果**: 精度↑（測: health-report が step 付きの signature と phase の所要時間を得られる）/ コスト↑（推: 再 run を避けられれば 1 件で complex 約 4,800s・25 spawn）/ UX↑（測: 回収が issue 上のコピペ 3 行で済む）。
- **検証**: `pr-artifacts.test.mjs` と `devflow-abort-telemetry-routing.test.mjs` の期待を更新、`health-report.bats` に新しい category の fixture、shift-bud で 1 本。
- **規模**: M

#### 4. closes-check を merge-tier-facts に吸収する
- **対象**: 全 run の `closes-check` spawn（`dev-flow.js:6579`、haiku-ro、14〜25s）。過去の偽 HOLD である pr_closes_missing（#713 の二重 JSON）もここで起きた。
- **根本原因**: PR 本文全体を haiku に転写させて Closes 行を判定している（`pr-artifacts.mjs:520-534`）。判定結果を使うのは Merge tier だけで、merge-tier-facts はすでに `gh pr view` を bare 単文で実行している（`_lib/merge-tier-facts.mjs:50`）。
- **変更**: merge-tier-facts の spawn に `gh pr view N --json body --jq '.body | test("Closes #N(\\D|$)")'` を 1 本足し、真偽値だけを script に渡す。reinject / recheck（`:6587-6598`）も Merge tier へ移す。
- **効果**: 精度↑（本文の転写が無くなり、jq の真偽値で判定する）/ コスト↑（−1 spawn、$0.06〜0.08）/ UX↑（−14〜25s/run）。
- **検証**: `merge-tier-facts.bats` に closes のサブ結果を追加、routing test で label が消えることを pin。
- **規模**: S

### Tier 2 — 三軸とも改善するが規模 M、または効果の一部が推定

#### 5. `/pr-iterate` 単体起動に決定論 preflight（`bin/pr-iterate-prerun`）を入れる
- **対象**: 単体起動 144 run / 60 日。isolation-probe abort 3 件。
- **根本原因**: pr-iterate は wrapper を持たず Workflow を直接起動する。`pr-iterate.js:891-894` の pr-meta（haiku-ro）と `:989` の isolation-cleanup（haiku）を毎回 spawn し、written:false なら throw して、人間に `git worktree add` と EnterWorktree をやらせる。dev-flow 側は prerun で同じ問題をすでに解決している。
- **変更**: `pr-iterate/SKILL.md` + `bin/pr-iterate-prerun`（`gh pr view --json` → worktree の作成・再利用 → EnterWorktree → NESTED 引数で起動）。isolation-probe は残す（fail-closed は不変）。
- **効果**: 精度↑（head_sha と base_ref が haiku の転写ではなく gh の決定論値になる）/ コスト↑（−2 spawn/run、60 日で 288 spawn）/ UX↑（手作業の手順と abort 3 件が無くなる。推）。
- **検証**: `priterate-isolation-wiring.test.mjs` を NESTED 経路に揃える、prerun の bats、skills repo の open PR で 1 本（index.lock EPERM 対策として `-wt/` 退避を通す）。
- **規模**: M

#### 6. 終端サマリを決定論的に削る（formatter だけを直し、ゲートと tier は変えない）
- **対象**: 迷わせる要素のうち C〜G の 137 件（security 定型 7 行が 14 PR、二重掲載 2、「fix 前 tree 基準」と「final snapshot」の矛盾 3、REVIEW 内の「未解消」語 10、情報ゼロの定型行 29）。
- **根本原因**（`_lib/devflow-summary-format.mjs`）: SEC seed を全件表示（:881-931 / `merge-tier.mjs:21,79`）、resolved の二重選択（:243-246）、バナーの固定文（:466、対して `dev-flow.js:7203`）、'未解消' の語（:646,:703）、既定の理由文と行動指示の重複（:396 / :485-525 / :598-605）。
- **変更**: clean な SEC は 1 行に集約、上表から resolved を除外、reverified のときはバナーを切り替え、advisory は「未対応（任意）」、既定の理由節は出さず gate_policy は末尾の HTML コメントへ、行動指示は「あなたがやること」に一本化。
- **効果**: UX↑（測: 矛盾 0・重複 0）/ コスト↑（推: post-summary の転写が −600〜900 字/PR）/ 精度↑（推: 6KB 級のサマリで後半が落ちる #660 型の欠落が減る。人間が誤った結論を読む要因 E・F が消える）。
- **検証**: 直近 15 コメントを fixture にして `devflow-summary-format.test.mjs` で C〜G が 0 になることを pin。
- **規模**: M（formatter + sync-inlines + テスト）

#### 7. issue の「制約」節を決定論で抽出し、evaluator / reviewer / fix に配線する
- **対象**: 制約違反が LGTM まで通った件（#488。memory に実測あり）と、#793 型の範囲外の黙殺。頻度は低いが、merge の直前まで誰も気づかない。
- **根本原因**: `analyze-issue.sh:230-291` は AC 節しか抽出せず、`analyze-contract.mjs:61-78` の whitelist に制約の欄が無い。evaluator には `scope` と `issue_body`（各 ≤4000 字）が二重に渡っている（`dev-flow.js:6098`）のに、判定軸は AC だけ。
- **変更**: `取らないこと|非目標|制約|Non-goals|Out of scope` の節を抽出して `constraints[]` にする。evaluator の `requirements` は `{title, type, AC, constraints, ac_actors}` に絞る。EVAL schema に `constraint_results` を足し、violated なら critical として blocking にする。reviewer の AC ブロックと fix prompt の Boundary にも同梱する。
- **効果**: 精度↑（制約違反を捕まえる層が 0 層から 2 層になる）/ コスト↑（推: evaluator の入力が約 8000 字から数行になる。evaluator-prompt-trim の GO と同じ方向）/ UX↑（違反が制約 index 付きで出る）。
- **検証**: #488 の本文を bats の positive control にする。`requirements` の縮約は evaluator-prompt-trim の replay を 10 本回し、verdict が一致してから入れる。
- **規模**: M

#### 8. implementer schema に maxLength を付け、builder の clip を発火させない
- **対象**: PR 本文の「…」59 行 / 13 PR。A:430 の契約では「…」の付いた行は未達扱いになるので、偽の AC 未達につながる（#815 で実害）。
- **根本原因**: `dev-flow.js:3509-3522` の `design_decisions` / `pr_notes` に maxLength が無く、`pr-artifacts.mjs:103-111` の 120/240 字で黙って切られる。
- **変更**: `title` 60 / `rationale` 120 / `pr_notes.text` 240 / `summary` 120 を schema で強制する（pr-reviewer と同じ方式。#816 の「切るのは書き手」の延長）。clip は backstop として残す。
- **効果**: 精度↑（偽の差し戻しが消える）/ UX↑（測: 「…」0）/ コスト↑（推: 小さい。初回違反時の contract retry とは相殺。retry 率を journal で確認する）。
- **規模**: S

#### 9. Final reconcile の read-only proxy を test#final と並列に走らせる
- **対象**: fix が入った run（complex 43/60、standard 13/18）。`changed-files-final` → `fix-diff-numstat` → `ui-verify-config-final` が test#final の後ろに直列で並んでいる（`dev-flow.js:6765-6807`）。
- **変更**: `parallel()` で test#final と同時に起動する。final-ac-reconcile は test の結果に依存するので後段に残す。
- **効果**: 精度＝ / コスト＝ / UX↑（推: −20〜50s/fix run）。精度とコストが改善しないので Tier 2 の下位に置いた。
- **規模**: S

#### 10. tree OID の三重取得をやめる（diff-gate / diff-hash-eval#1 / diff-hash-pr）
- **根本原因**: secfloor-classify が同じ hash を内部で取っている（`secfloor-classify.sh:191-217`）。eval#1 は secDiffHash と同じ tree。pr の head_sha^{tree} は merge-tier-facts がすでに算出している。
- **変更**: Security floor を先に走らせて empty-diff を判定し、i=1 かつ UI に触れていなければ secDiffHash を再利用する。PR 後の比較は merge-tier-facts に head_sha を渡して行う。
- **効果**: 精度＝ / コスト↑（−3 spawn、$0.03〜0.2）/ UX↑（−25〜30s）。順序を入れ替えるので hash_mismatch の再現テストを必須にする。
- **規模**: S〜M

### Tier 3 — 入れる前に replay・計測・判断が要る

#### 11. evaluator に Validate の結果を渡し、全件スイートの再実行を禁じる
- 根拠: replay 20 本中 11 本で evaluator が `run-all-bats` を全件実行している。production でも df-785 と df-1496 で全件実行が見られた（`dev-flow.js:6097`、`evaluator.md:21,42`）。
- 効果: コスト↑（推 −$0.3〜0.8/eval）/ UX↑（推 −60〜120s/eval）/ 精度は replay で＝を確かめる必要がある。**evaluator-prompt-trim の replay を 10 本回し、verdict と major の一致、全件実行 0 を確かめてから入れる。** 規模 S。

#### 12. 観測型 AC（記録される / journal / 実測 / A/B …）は oracle を必須にする
- 根拠: 偽 pass 7 件と、それが生んだ follow-up チェーン（#471〜#495）、#423 の捏造。`dev-flow.js:6217-6222,6247` で inspection もその場で checked になる。
- 変更: `ac-actor.mjs` に `classifyAcOracle` を足す。observational で inspection だけのときは checked にせず、既存の `agentAcFeedback`（REIMPL_MAX 2 → ac_agent_unsatisfied HOLD）で差し戻す。
- 効果: 精度↑（大）/ UX↑（follow-up チェーンが減る）/ **コストは run 単位では↓、期待値では↑**（推: 発火率 20% 以下で reimpl 1 spawn。follow-up 1 本は 34 spawn）。正規表現の偽陽性で reimpl が空回りするとコストも UX も悪化するので、`ac-actor.test.mjs` の negative control に加え、**直近 60 日の AC 全件に分類器をかけ、発火率と偽陽性を実測してから**入れる。規模 S〜M。

#### 13. HOLD 理由・非 LGTM 終端・fail-open null を closed enum で journal に残し、health-report の lifecycle に載せる
- 根拠: #795（issue #789）で `merge_tier_reasons` / `fix_terminal_reason` などが消え、10-05 以降の HOLD 6 件・fix_failed 3 件の理由は PR コメントでしか分からない。health-report は `outcome=failure` しか見ていない（`health-report.sh:163-164`）。今回の調査も jq を 15 本書いて掘った。
- 変更: `hold_codes[]`（closed enum）、`fix_terminal_reason`、`probe_nulls[]` を足す。読み手は health-report の HOLD / 非 LGTM signature。
- 効果: 精度↑（偽 HOLD の再発が翌日に regressed + 候補 commit として出る）/ コスト＝（実行時 0）/ UX↑。**#795 でキーを削った直後なので、読み手を同じ PR で実装することを条件にする**（rules L48）。規模 S〜M。

#### 14. PR 本文の AC checkbox を廃止し、`ac-checkbox-sync` spawn を削除する
- 根拠: micro は evaluator を回さないのに `- [ ]` が並ぶ。`ac-checkbox-sync`（`dev-flow.js:6975`）は closes-recheck（:6592）の後に本文を書き換えるが、closes は再検証しない。
- 効果: 精度↑（Closes が消えうる窓が閉じる）/ コスト↑（fix run で −1 spawn）/ UX: AC の状態の正が 1 箇所になる一方、checkbox で確かめる習慣が失われる。**checkbox を使っているかどうかはユーザーの判断。** 規模 S。

#### 15. evaluator の未解消 major を reviewer の「既出 findings」に流し込む
- 根拠: evaluator が pass した後に reviewer が blocking を出すのが 29%。`pr-iterate.js:1260` は自分の findings しか持ち越さない。
- 効果: 精度↑ / コスト・UX は推定のみ（round が増える側に振れる可能性がある）。**priterate-merged の replay を 5 本回し、round 数が増えないことを確かめてから入れる。** 規模 S。

#### 16. evaluator 出力の各欄に schema 上限を付ける（description 300 / suggestion 200 / evidence 200）
- 効果: UX↑（200 字を超えるセル 33 個、折りたたみ内の「…」16 個が消える）/ コスト↑（推 −5〜10%）/ **精度は＝の推定どまり**（入力の簡素化は GO 済みだが、出力上限は未検証）。施策 11 の replay に相乗りして測る。規模 S。

## 推奨する着手順

1. **施策 2・4・8**（いずれも S。実測根拠があり、互いに独立）を 1 PR ずつ。
2. **施策 1**（偽 red の根絶と時間短縮。dev-flow 本体と skills repo の tests の 2 PR）。
3. **施策 3 と 5**（手動回収 36 件の大半を占める PR phase abort と isolation abort。wrapper 側の変更なので 2 本を続けて入れる）。
4. **施策 6・7**（出力と精度。7 は replay の後に）。
5. Tier 3 は replay・計測を終えてから個別に判断する。施策 11 と 16 は同じ replay で測れる。

## 除外した案

- run 内での push の再発行: #819 の AC「push を再発行しない」と衝突し、hook が 2 本並走してコストが悪化する。
- Validate に lint / tsc を足す: #819 の失敗は一過性で sandbox では再現しない。偽陰性で green-fix が空回りしてコストが悪化する。
- commit / push / PR 作成を 1 本の決定論スクリプトにする: rules L62「exec-proxy は認証付きの network I/O を持たない」と衝突する。#819 / #820 の判断待ち。
- PR phase の retryOnContractViolation: push が二重になる。原因側は #808 で直した。
- fix_failed への retry や maxTurns の増加: null_after_retry は 09-24 以降 0 件。コストだけが増える。
- HOLD 条件の緩和: 軸A と merge は人間という不変条件に抵触する。
- classifier block 専用の対策: 60 日で 0 件。施策 13 の probe_nulls で計測してから考える。
- reviewer と fix の統合 / evaluator と reviewer の統合: memory で NO-GO（コスト +13〜30%）。
- pr-reviewer の prompt 簡素化・effort medium: memory で NO-GO（severity が下がる）。
- pr_sections の上限を引き上げる: 判定の文脈が薄まる（#816 と逆方向）ので精度が悪化する。
- evaluator 入力から issue_body を単純に外す: replay なしでは精度リスクがある。施策 7 の構造化に置き換えた。
- 単体 pr-iterate の終了レポートを upsert する: UX だけでコストと精度は変わらない。
- 要対応表を haiku で要約する: spawn が増えてコストが悪化し、判定語が変わる精度リスクがある。
- 終端サマリを 2 コメントに分ける: コメント数が増えて UX が悪化し、spawn が 2 倍になる。
- needs_clarification の文生成を決定論にする: 15 PR に実例が無く、効果を測れない。
- HOLD の人手書換を自動化する: 機械判定の書き換えになり軸A に抵触する。
- inspection の AC をすべて差し戻す: 20% の run で reimpl が増え、コストが悪化する（施策 12 は observational に限定）。
- standard の EVAL_PASSES を 2 にする / fix 後に evaluator を再実行する: spawn が +1 になる。#720 / #791 で決定論的に代替済み。
- exec-proxy の `--out` ファイル出力を戻す: #544 の決定と逆行する。
- Jev で制約違反を判定する: sandbox では鍵が取れず、spawn 外のコストが増える。
- analyze で「実測」AC を needs_clarification に落とす: 往復が 1 回増えて UX が悪化する（施策 12 で代替）。
- pr-reviewer に issue 本文の全文を渡す: 文脈が増えてコストが悪化する（施策 7 の構造化で代替）。
- test#final を CI passed で代替する: CI ⊂ ローカルの repo で精度が下がり、rules L42 にも反する。
- final-ac-reconcile を test#final と並列にする: test red の run で evaluator 分のコストが無駄になる。
- green-fix の前に failed_files だけを再実行する: 1 回で直る run では +10〜60s。
- Validate test#1 と secfloor を並列にする: テストの一時ファイルが realized files を汚す精度リスクがある。
- PR を Evaluate の前に作って CI を先行させる: 全 phase の前提が変わる L 規模で、精度リスクがある。
- post-summary と journal の spawn を統合する: classifier block の再発面が広がる。
- pr# proxy に head tree や closes の取得を足す: いちばん脆い spawn に手順を足すことになる（施策 4・10 は merge-tier-facts 側に寄せた）。
- pr-reviewer に全件テストの禁止を足す: replay で全件実行は 0 件だったので効果が無い。
- sections-trim の差し戻しを sonnet にする: 発生頻度を実測しておらず、「書き手に差し戻す」と決めた直後でもある。

## 計測上の注意

- #795（issue #789、aa6faae、10-05）で `merge_tier_reasons` / `fix_terminal_reason` / `summary_posted` / `subagent_invocations` などが telemetry から外れた。このため本書の HOLD 理由の内訳と spawn 数は 10-04 までのデータが母数で、それ以降の分は transcript からしか数えられない。
- 10-04 23:31 の 25 entry は pending flush（#784 の修正後）で、timestamp は実行時刻ではない。手動回収の集計からは同時刻の 14 件を除いた。
- phase 境界は隣接する agent の epoch で決まる。telemetry の `pr` 列（116〜144s）の大半は実際には redgreen の時間（施策 2 の根拠）。
