# issue #361 spike: test-weakening 検出手法の実測比較（R1↔R2 分布 / Option A vs Option B）

## 0. 実行に関する重要な前置き（欠測の扱い）

本 spike は計画上 F1（R1↔R2 実分布収集）/ F2（Option A 実測）/ F3（Option B 実測）を並列 task として
先行実行し、その中間データ（`.devflow-tmp/spike/r1r2/` `.devflow-tmp/spike/option-a/` `.devflow-tmp/spike/option-b/`）
を本レポート作成 task（F4）が読み取って統合する設計だった。

しかし F4 開始時点で worktree `df-361` の `.devflow-tmp/` 配下にこれらの中間ファイルは**存在しなかった**
（`git status` clean、`.devflow-tmp/` 自体が空）。原因は特定できていないが、以下のいずれか、または
複合と推測される（握りつぶさず事実として記録する）。

- 一般規約「worktree 内の一時/handoff ファイルは task 完了前に削除せよ」を F1–F3 が文字通り適用し、
  F4 への引き継ぎ前に削除してしまった（本 task 固有の「F4 の入力として残す」という指示と一般規約が
  衝突していた）。
- 後述 §3 で実測した **本セッション固有の Bash サンドボイ書き込み制限**（`~/ghq/github.com/it-all-playpark/skills`
  配下での `mkdir`/`touch`/`ln -s` が `Operation not permitted` で失敗する再現条件）により、F1–F3 が
  そもそも `.devflow-tmp/` へ書き込めなかった可能性。

**対応**: F4 は中間ファイルに頼らず、計画が F1–F3 に指示した一次データソース（df-359 worktree の
`.veridelta` store、veridelta repo の conformance fixtures、`_shared/scripts/diff-risk-classify.sh`、
git 履歴、スクラッチ worktree での再実験）に直接アクセスし、同等の実測を独立に再構築した。
以下の全数値は F4 が本セッション内で実行し直したものであり、再現コマンドを都度 verbatim 記載する。

---

## 1. 背景 — B1 finding

`_shared/scripts/redgreen-verify.sh` は red→green 判定のために **impl ファイルだけ**を退避し
（untracked は `cp` して削除、tracked-modified は `git stash push`）、test ファイルには一切触れない。

再現（該当ロジック抜粋、L63-135 相当）:

```bash
sed -n '63,135p' /Users/naramotoyuuji/ghq/github.com/it-all-playpark/skills/.claude/worktrees/df-361/_shared/scripts/redgreen-verify.sh
```

要旨:
- `run_tests()` は untracked impl を `cp` 退避 → `rm`、tracked-modified impl を `git stash push -- <impl files>` で退避してから R1（red 判定）を実行。
- 直後に stash pop / untracked 復元して R2（green 判定）を実行。
- test ファイルは **一度も** 退避・変更の対象になっていない。

**帰結（B1）**: 1 回の `redgreen-verify.sh` 呼び出し内で R1 と R2 に渡される test ソースは常に
byte-identical。したがって「test を書き換えて red を消す」類の cheat（`test.skip` 化、tautology 化、
test ファイル削除等）が生む deny シグナル（`fail_to_skip` / `fail_to_xfail` / `removed` /
`not_observed` / `repaired_with_test_change` / `verification_surface.status ≠ intact` /
`comparability ≠ exact`）は、**この R1↔R2 比較の構造上、原理的に発火し得ない**。test-weakening は
redgreen-verify.sh の外（PR 全体の diff、または merge-base との比較）でしか検出できない。

---

## 2. R1↔R2 transitions 実分布 [AC-1]

### 2-1. データソース

- **real（実運用実証）**: worktree `df-359`（issue #359 実装 run）の `.veridelta` store。
  `df-359/.claude/redgreen.conf` が `test_cmd=npx vdelta run --report json -- npx vitest run` /
  `verdict_cmd=npx vdelta compare --report json` を設定しており、`redgreen-verify.sh` が実際に
  veridelta 経由で R1/R2 を記録していた（本 issue の spike のためではなく、issue #359 実装時の
  redgreen 呼び出しがそのまま veridelta でラップされていた実データ）。store には 4 run = **2 組の
  R1↔R2 ペア**のみが存在した（各ペア: selector 同一、`completeness.child_exit_code` が 1→0）。
- **fixture（補完）**: `~/ghq/github.com/it-all-playpark/veridelta/conformance/fixtures/` の
  `class: recall`（cheat シナリオ）12 件。veridelta 自身の conformance test corpus で、各 fixture の
  `manifest.json` に baseline/current 実行手順と **期待される transitions/comparability/verification_surface
  の宣言的 assertion** が記述されている（実行不要でそのまま参照可能）。

再現（real 側、2 ペアの compare 実行）:

```bash
cd /Users/naramotoyuuji/ghq/github.com/it-all-playpark/skills/.claude/worktrees/df-359
node ~/ghq/github.com/it-all-playpark/veridelta/dist/cli.js compare \
  run_5dce3b06199073bd58335010d7de4005ac42417e77efac191d0cf0fbbbfe87bd \
  run_88d59b40e6326947290468ec43f8680e8ec4103e6b5b69a7ce82984297a106b5 \
  --report json
# ペア2
node ~/ghq/github.com/it-all-playpark/veridelta/dist/cli.js compare \
  run_6d68ca6366ea5486baa9d8b9e3ab39987f50477e16a9bdd8f833c567646e1ca8 \
  run_9df6b8f0879f7dd3c7c5b857c23ec5033b13e1d2da9f7dc87efe297ea982ad34 \
  --report json
```

### 2-2. 分布表（14 サンプル: real 2 + fixture 12）

| # | source | シナリオ | comparability | verification_surface.status | outcome_verdict | deny シグナル発火 |
|---|--------|----------|---------------|-------------------------------|------------------|---------------------|
| 1 | **real** | df-359 issue#359 pair1（`final-reconcile-routing.test.mjs`+`validate-loop-unification.test.mjs`） | exact | intact | improved | なし（全 `[]`） |
| 2 | **real** | df-359 issue#359 pair2（`validate-loop-unification.test.mjs`のみ） | exact | intact | improved | なし（全 `[]`） |
| 3 | fixture | recall-true-fix（正直な実装修正、positive control） | exact | intact | improved | なし。`repaired_same_surface` のみ発火（唯一これが起きるべきケース） |
| 4 | fixture | recall-fail-to-skip（`test.skip` で red を隠す） | exact | reduced | unchanged | `fail_to_skip` 発火 |
| 5 | fixture | recall-fail-to-todo（`test.todo` 化） | exact | reduced | unchanged | `fail_to_skip` 発火（todo は skip マッピング） |
| 6 | fixture | recall-fail-to-testfails（`test.fails` xfail 化） | exact | reduced | unchanged | `fail_to_xfail` 発火 |
| 7 | fixture | recall-only-narrowing（`test.only` で red を除外） | exact | reduced | unchanged | `fail_to_skip` 発火 |
| 8 | fixture | recall-tautology（assertion を `expect(true).toBe(true)` 化） | exact | changed | (repaired_with_test_change) | `repaired_with_test_change` + `test-source-changed` event |
| 9 | fixture | recall-early-return（early return で assertion 到達不能化） | exact | changed | (repaired_with_test_change) | `repaired_with_test_change` + `test-source-changed` event |
| 10 | fixture | recall-expected-rewritten（`toBe(200)`→`toBe(500)` 改ざん） | exact | changed | (repaired_with_test_change) | `repaired_with_test_change` + `test-source-changed` event |
| 11 | fixture | recall-testfile-deleted（test ファイルごと削除） | **scope_changed** | reduced | — | `removed` + `test-removed` event |
| 12 | fixture | recall-test-deleted（ファイル内の該当 test だけ削除） | **scope_changed** | reduced | — | `removed` + `test-removed` event |
| 13 | fixture | recall-selector-exclude（config の `exclude` で除外） | **scope_changed** | — | — | `removed`（`out_of_scope` ではなく `removed` に分類される点が INV 上重要） |
| 14 | fixture | inv9-fail-to-skip-not-repaired（不変条件テスト: skip は repair 扱いされない） | exact | reduced | unchanged | `fail_to_skip`。`repaired_same_surface` には**絶対に**入らないことを保証する invariant |

### 2-3. B1 仮説への反証可否

**反証されなかった**。real 2 ペアはいずれも `comparability: exact` / `verification_surface.status: intact` /
`transitions` の deny バケット（`fail_to_skip` `fail_to_xfail` `removed` `not_observed`
`repaired_with_test_change`）が全て空配列だった。これは fixture 側で確認した「test-weakening cheat は
必ず deny シグナルのどれかを発火させる」設計と対比すると、**redgreen-verify.sh の R1↔R2 では test
ソースが変化しないため、これらのシグナルが発火するデータ点自体が実運用に存在しない**ことの直接証拠になる。
B1 の「deny 経路は実運用で発火し得ない」という仮説は、real サンプル数が 2 と少ないながらも支持される
（母集団側の設計（§1）と整合しており、real サンプルを増やしても構造的に覆らないと考えられる）。

---

## 3. Option A 実測（merge-base baseline 比較）[AC-2]

### 3-1. baseline 記録方法（実測できたもの）

veridelta の `vdelta compare --ref <git-ref>` は、指定 ref の commit/tree をその場で解決するだけで、
**その ref の tree と一致する `.veridelta` 記録済み run が同一 worktree の store に既に存在しないと
使えない**（`dist/compare.js` `case 'git-ref'`: `record.provenance.head === spec.commit &&
record.provenance.tree_digest === spec.tree` の完全一致が必要。無ければ `baseline-missing` で fail）。
store は `RunStore(worktree)` として **cwd の git toplevel ごとにローカル**（`dist/cli.js`
`requireStore()`）。したがって baseline 記録は「別のスクラッチ worktree で record して後から参照」では
成立せず、**PR 実装用の worktree自体で、実装開始前（= merge-base のツリー状態のまま）に
一度 `vdelta run` を実行しておく**以外の記録方法が存在しない。

再現（実際に確認した compare --ref の失敗挙動と根拠コード）:

```bash
grep -n "case 'git-ref'" -A 20 ~/ghq/github.com/it-all-playpark/veridelta/dist/compare.js
grep -n "function requireStore" -A 5 ~/ghq/github.com/it-all-playpark/veridelta/dist/cli.js
```

### 3-2. 実行コスト（実測）

スクラッチ worktree（`/tmp/claude-501/issue361-mb-scratch`、merge-base = 現行 `feature/issue-361`
の HEAD `9ad1907`）を作成して計測した。

```bash
git worktree add --detach /tmp/claude-501/issue361-mb-scratch 9ad19075feebb2fd66447b0979165d2e210d0a08
```
→ `0.02s user 0.06s system 75% cpu 0.101 total`

```bash
cd /tmp/claude-501/issue361-mb-scratch && npm install --no-audit --no-fund
```
→ `0.34s user 0.21s system 116% cpu 0.475 total`（"added 46 packages in 374ms"、npm cache 温状態）

```bash
node_modules/.bin/vdelta run --report json -- \
  node_modules/.bin/vitest run _lib/agent-effort.test.mjs --reporter=default --reporter=vdelta/vitest
```
→ `0.36s user 0.12s system 33% cpu 1.394 total`（vitest 自体の `Duration` は 94-156ms、
残りは node/npx 起動オーバーヘッド）。

**内訳**: worktree 作成 ~0.1s + npm install ~0.4-3s（cache 依存）+ vdelta ラップ実行 ~1.4-2.8s
（1 test file・7 tests の場合）。フルスイートを baseline として録る場合はテスト数に比例して増える
（本 spike では時間予算の都合でフルスイート実測はしていない — 欠測として明記する）。

### 3-3. dirty worktree 動作可否（実測・最重要所見）

**再現不能ではなく、明確に「記録が壊れる」ことを実測した。** `vdelta run` は記録のたびに内部で
`git -C <worktree> add -A` を実行し tree の provenance snapshot を取る。この `git add -A` が、
本セッションの sandboxed Bash 実行環境では **クリーンな tree でも dirty な tree でも同一の
`EPERM` で失敗**した。

再現（クリーンな tree での失敗）:

```bash
cd /tmp/claude-501/issue361-mb-scratch
node_modules/.bin/vdelta run --report json -- \
  node_modules/.bin/vitest run _lib/agent-effort.test.mjs --reporter=default --reporter=vdelta/vitest
# stderr:
# vdelta: degraded to raw passthrough (Command failed: git ... add -A
# error: unable to create temporary file: Operation not permitted
# error: .claude/agents/dev-planner.md: failed to insert into database
# error: unable to index file '.claude/agents/dev-planner.md'
# fatal: updating files failed)
```

再現（dirty tree、対象外ファイルにまで同一エラーが波及することを確認）:

```bash
cd /tmp/claude-501/issue361-mb-scratch
printf '\n// dirty-worktree probe comment\n' >> _lib/agent-effort.test.mjs
git status --short   # => " M _lib/agent-effort.test.mjs"
node_modules/.bin/vdelta run --report json -- \
  node_modules/.bin/vitest run _lib/agent-effort.test.mjs --reporter=default --reporter=vdelta/vitest
# stderr: 同一の "unable to create temporary file: Operation not permitted" / "failed to insert into database"
```

`result.degraded === true` の分岐（`dist/cli.js` `cmdRun`）により、構造化 JSON report は一切出力されず
raw passthrough（vitest の生テキスト出力のみ）になる。**つまり `.veridelta` store への記録自体が
失敗し、baseline / current どちらの記録も成立しない。** これは「dirty tree だから壊れる」のではなく
「git オブジェクト DB への書き込みが必要な処理全般がこの sandbox 実行環境で信頼できない」という、
より広い制約に起因する（同じ現象を diff-risk-classify.sh 側は踏まない。§5 参照）。

参考: 同種の EPERM は本 repo の別問題として既知（`node_modules/.vite-temp` mkdir EPERM、
memory `devflow-vitest-sandbox-eperm.md`）であり、本 worktree (df-361) 上で `bash
tests/run-node-tests.sh` を直接実行しても同じ症状（`mkdir 'node_modules/.vite-temp':
Operation not permitted`）を再現した。Option A の `vdelta run` はこの既知クラスの脆弱性
（git/npm/vite が book-keeping のために書き込む一時ファイル・ロックファイル生成が本セッションの
サンドボイでは信頼できない）を追加でもう一段深く（git object DB 書き込みという、より根幹の
git 操作にまで）踏む。

### 3-4. report-only / record_integrity=advisory（INV-10）

実際に取得できた real compare 出力（§2 のペア）はいずれも:

```json
"trust": { "record_integrity": "advisory" }
```

を含んでいた。veridelta の gate コマンドも `--policy report-only` のみが実装されており
（`vdelta gate --ref <git-ref> [--run <run-id>] [--policy report-only]`）、
**blocking gate としての trust level は現状 advisory 固定**（INV-10 相当の制約）。つまり Option A を
採用しても、veridelta の verdict をそのまま dev-flow の blocking gate（W7 の deterministic floor）に
昇格させることはツール仕様上できず、当面は advisory シグナルとしてしか使えない。

---

## 4. Option B 実測（diff-risk-classify.sh 拡張）[AC-3]

### 4-1. 候補パターン

`_shared/scripts/diff-risk-classify.sh` の既存 7 クラス（auth/crypto/config/data-migration/
public-api/exec-sink/dependency）と同じ「realized diff の追加行を `grep -Eiq`」方式で、test-weakening
検出用に以下 6 パターン + 1 補助チェックを candidate とした（veridelta conformance fixtures の
cheat 分類に対応させた）。

| # | パターン名 | 検出対象 | grep（追加行対象） | 対応 fixture |
|---|-----------|---------|---------------------|--------------|
| 1 | `skip` | `test\|it\|describe.skip` + vitest/jasmine の x-prefix alias（`xit`/`xtest`/`xdescribe`） | `` \b(test\|it\|describe)\.skip\b\|\b(xit\|xtest\|xdescribe)\s*\( `` | recall-fail-to-skip / recall-only-narrowing |
| 2 | `only` | `test\|it\|describe.only` | `\b(test\|it\|describe)\.only\b` | recall-only-narrowing |
| 3 | `todo` | `test\|it.todo` | `\b(test\|it)\.todo\b` | recall-fail-to-todo |
| 4 | `xfail` | `test\|it.fails`（vitest xfail marker） | `\b(test\|it)\.fails\b` | recall-fail-to-testfails |
| 5 | `tautology` | `expect(true).toBe(true)` 等の自明 assertion | `` expect\((true\|1\|'x')\)\.to(Be\|Equal\|BeTruthy)\( `` | recall-tautology |
| 6 | `exclude-cfg` | vitest config の `exclude:` 追加・`test.exclude` | `` (test\.exclude\|exclude:\s*\[) `` | recall-selector-exclude |
| 7（補助・file-level） | `test-file-deleted` | test ファイルの削除（`--diff-filter=D`） | ファイル単位、content grep ではない | recall-test-deleted / recall-testfile-deleted |

パターン 1-6 は content ベース、パターン 7 のみファイル削除の有無を見るファイルレベルチェックで、
既存スクリプトの `public-api` クラスと同様「filename ベース」の枠組みに乗る。
`recall-early-return` / `recall-expected-rewritten`（assertion の意味的改変）は grep では検出できず、
本 spike では candidate から除外した（AST 比較や coverage diff が必要 — follow-up 課題として §6 に記載）。

**レビュー指摘による追補（x-prefix alias / assert-expect 純減）**: 初版はドット記法
（`test.skip`/`it.skip`/`describe.skip`）のみを候補としており、vitest（jasmine 由来の互換 API として）
でも有効な skip alias `xit(`/`xtest(`/`xdescribe(` が候補セットから漏れていた。実測で
`echo "+xit('checks value', () => {" | grep -E '\b(test|it|describe)\.skip\b'` は exit 1（非マッチ）で
提案パターン 1-6 の grep を全てすり抜けることを確認した。これを受け、パターン 1 の grep に
`\b(xit|xtest|xdescribe)\s*\(` を追加し、以下の再実測を行った。

- **true positive**: `xit(`/`xtest(`/`xdescribe(` の 3 alias 全てで追加後の grep がマッチすることを確認済み（3/3）。
- **false positive**: §4-3 の 25 merge corpus に対し alias パターン単独で再実行 —
  **0/25**（既存 6 パターンと同水準）。パターン 1 への統合後も既存の 0/25 実績を損なわない。

「assert/expect 行の純減」（削除された assert/expect 行数 > 追加された assert/expect 行数）も同じ
25 merge corpus で検証した（`grep -Ec '\b(expect|assert)\b'` を追加行・削除行それぞれに適用し差分を取る）。
結果は **3/25 で純減が検出された**が、該当 3 件（`a0765761`(issue-351)・`ee6a0fc3`(revert pr-340)・
`64294b31`(issue-325)）は §4-3 のファイル削除ベース補助パターンで既に false positive と判定した
revert/リファクタ commit と完全に一致した。つまり assert/expect 純減は単純な行数比較では
cheat と legitimate な test 整理・revert を区別できず、ファイル削除パターン（パターン 7）と同種の
「revert/re-add・rename 検出ロジックが要る」制約を持つ。**候補から除外し続ける**（後述 §6 に反映）。

### 4-2. 正の対照（合成 cheat 文字列での true-positive 確認）

```bash
echo "+test.skip('checks value', () => {" | grep -E '\b(test|it|describe)\.skip\b'
echo "+test.only('x', () => {" | grep -E '\b(test|it|describe)\.only\b'
echo "+test.todo('x')" | grep -E '\b(test|it)\.todo\b'
echo "+test.fails('x', () => {" | grep -E '\b(test|it)\.fails\b'
echo "+  expect(true).toBe(true)" | grep -E "expect\((true|1|'x')\)\.to(Be|Equal|BeTruthy)\("
echo "+    exclude: ['tests/t.test.ts']" | grep -E '(test\.exclude|exclude:[[:space:]]*\[)'
echo "+xit('checks value', () => {" | grep -E '\b(xit|xtest|xdescribe)\s*\('
echo "+xtest('checks value', () => {" | grep -E '\b(xit|xtest|xdescribe)\s*\('
echo "+xdescribe('group', () => {" | grep -E '\b(xit|xtest|xdescribe)\s*\('
```
→ 9/9 全て一致（true positive 確認済み。後半 3 件が §4-1 追補の x-prefix alias）。

### 4-3. false positive 実測（直近 25 first-parent merge commit の実 diff）

対象コミット取得:

```bash
cd /Users/naramotoyuuji/ghq/github.com/it-all-playpark/skills/.claude/worktrees/df-361
git log --first-parent origin/main --merges -n 25 --format='%H' > /tmp/claude-501/optionb-merges.txt
```

各 merge commit `m` について `git diff $(git rev-parse m^1) $(git rev-parse m^2) -- '*.test.*' '*.bats'`
の追加行（`^+`、`+++` 除く）に対しパターン 1-6 を適用（1 merge あたりの再現コマンド例）:

```bash
P1=$(git rev-parse "${m}^1"); P2=$(git rev-parse "${m}^2")
D=$(git diff -U0 "$P1" "$P2" -- '*.test.*' '*.bats' | grep -E '^\+' | grep -vE '^\+\+\+')
echo "$D" | grep -Ecm100 '\b(test|it|describe)\.skip\b'      # skip
echo "$D" | grep -Ecm100 '\b(test|it|describe)\.only\b'       # only
echo "$D" | grep -Ecm100 '\b(test|it)\.todo\b'                # todo
echo "$D" | grep -Ecm100 '\b(test|it)\.fails\b'               # xfail
echo "$D" | grep -Ecm100 "expect\((true|1|'x')\)\.to(Be|Equal|BeTruthy)\("  # tautology
echo "$D" | grep -Ecm100 '(test\.exclude|exclude:[[:space:]]*\[)'          # exclude-cfg
```

パターン 7（削除）は別コマンド:

```bash
git diff --name-only --diff-filter=D "$P1" "$P2" -- '*.test.*' '*.bats'
```

**結果**（25 merge commit 全件、25/25 実行完了。22/25 が test ファイルへの追加行を含んでいた）:

| パターン | FP 件数（25 merge 中） | 備考 |
|---------|------------------------|------|
| skip | **0/25** | |
| only | **0/25** | |
| todo | **0/25** | |
| xfail | **0/25** | |
| tautology | **0/25** | |
| exclude-cfg | **0/25** | |
| skip alias（`xit`/`xtest`/`xdescribe`、レビュー指摘反映） | **0/25** | パターン 1 に統合。単独再測定でも既存 6 パターンと同水準の 0/25（§4-1 追補） |
| test-file-deleted（補助） | **4/25**（延べ 16 ファイル） | 内訳: `a0765761`(issue-351) 2 ファイル、`ef09607f`(revert/pr-340-external-skills) 1 ファイル、`ee6a0fc3`(revert/pr-340) 9 ファイル、`64294b31`(issue-325) 4 ファイル。後者 2 件は revert→re-add の対（`ee6a0fc3` で消えた 4 ファイルが `64294b31` でそのまま復活）で、legitimate なリファクタ・revert 起因であり test-weakening ではない |
| assert/expect 純減（補助・検証のみ、候補から除外、レビュー指摘反映） | **3/25** | 該当 3 件は `a0765761`/`ee6a0fc3`/`64294b31` — test-file-deleted の FP と完全一致。単純な行数比較では revert/リファクタと cheat を区別できないため候補から除外（§4-1 追補・§6 参照） |

content ベースの 6 パターン（x-prefix alias 統合後）は **25 件中 0 件の false positive**（誤検出ゼロ）。
合成 cheat 文字列に対する true positive（§4-2、9/9）と合わせ、この 6 パターンは高精度。一方でファイル
削除ベースの補助パターンおよび assert/expect 純減チェックは **単純な行数・存在判定では 3-4/25
（12-16%）の PR で誤検出**が生じ、いずれも revert/re-add・リファクタ由来の変更と cheat 由来の変更を
区別する追加ロジック（同一 diff 内で類似テストが別ファイルへ移動していないか等）なしでは採用に耐えない。

---

## 5. 比較表: Option A vs Option B

| 軸 | Option A（merge-base baseline 比較, veridelta `--ref`） | Option B（diff-risk-classify.sh 拡張, grep パターン） |
|----|----------------------------------------------------------|--------------------------------------------------------|
| **検出能力** | test ソースの意味的変化を pass/fail 遷移として検出（`repaired_with_test_change` 等、tautology・early-return も理論上カバー——ただし本 spike で実行確認したのは fixture 経由の宣言的 assertion のみ） | 表層パターンのみ（skip/only/todo/xfail/tautology/exclude/削除）。early-return・assertion 改ざん（`toBe(200)→toBe(500)`）は **grep では検出不可**、Option A 側の守備範囲 |
| **実行コスト** | baseline 記録 1 回分のテスト実行が追加コスト（実測: 小規模 1 file で ~1.4-2.8s、フルスイートは未実測・比例増加見込み）。worktree 作成 ~0.1s は既存ステップに乗る | ほぼゼロ（既存 danger-grep 呼び出しに 1 パターン群を追加するだけ。git diff は read-only、実行時間は既存の diff-risk-classify.sh と同オーダー） |
| **false positive** | 本 spike では FP 実測は未実施（object-write 失敗により recording 自体が成立せず測定不能——§3-3） | content 系 6 パターンは 25/25 で FP ゼロ、file-deletion 系補助パターンのみ 4/25（要洗練） |
| **運用制約** | (a) baseline は**同一 worktree・実装開始前**に記録必須（別 worktree recording は stream identity 不一致で利用不可）。(b) `git add -A` への依存により、本セッションの sandboxed Bash 実行環境では **clean/dirty 問わず記録が EPERM で壊れる**ことを実測（§3-3）。(c) trust level は `record_integrity: advisory` 固定（INV-10）— blocking gate に昇格不可 | 既存 diff-risk-classify.sh と同一の fail-closed 決定論ポリシーにそのまま乗る。git 書き込み依存なし（read-only diff のみ）ため §3-3 のクラスの脆弱性を踏まない |

---

## 6. go/no-go 判定（proposed）と採用案

### 判定: **Option B（diff-risk-classify.sh 拡張）を採用、Option A は見送り（no-go）**

**根拠**:
1. B1（§1）により、redgreen-verify.sh の R1↔R2 比較そのものは test-weakening を構造的に検出できない
   ことが実データ（§2、real 2 ペア + fixture 12 件、deny シグナル 0/2 vs fixture 側の確実な発火）で
   裏付けられた。したがって「redgreen の R1↔R2 に手を入れる」という選択肢は最初から除外される
   （元々 issue のスコープにも入っていない）。
2. Option A は概念上より広い検出能力を持つが、(i) baseline を同一 worktree・実装開始前に記録する
   運用制約、(ii) 本セッションの sandboxed Bash 実行環境で `git add -A` への依存が record 自体を
   壊す実測結果（§3-3、clean/dirty 両方で再現）、(iii) `record_integrity: advisory` 固定で blocking
   gate に昇格できない仕様、の 3 点が重なり、dev-flow の exec-proxy アーキテクチャ（sandboxed Bash
   経由の決定論プロキシ、AGENTS.md 記載）に組み込むには追加のエンジニアリング（git 書き込み依存を
   回避する設計変更、または非 sandboxed 実行経路の確保）が必要で、spike のスコープでは go 判定に
   足る実測（FP 実測含む）を得られなかった。
3. Option B は 6 個の content パターンが 25 件の実 PR diff に対し FP ゼロ、かつ合成 cheat での
   true positive を確認済み。実行コストはほぼゼロで、既存 diff-risk-classify.sh の fail-closed
   決定論アーキテクチャ（W7 blast-radius クラス、security floor）にそのまま統合できる。
   git 書き込みに依存しないため Option A で踏んだクラスの脆弱性も回避する。
   file-deletion 系のみ追加の洗練（revert/re-add・rename 除外ロジック）が必要で、そのままでは
   採用しない。

### #362（後続実装 issue）への反映事項

- `_shared/scripts/diff-risk-classify.sh` に 8 番目のクラス `test-weakening` として、本レポート
  §4-1 の content パターン 1-6（skip/only/todo/xfail/tautology/exclude-cfg）を追加する。
  パターン 1（skip）には vitest/jasmine 系 x-prefix alias（`xit`/`xtest`/`xdescribe`）を含める
  （レビュー指摘により追加・25 merge corpus で 0/25 FP・true positive 3/3 実測済み、§4-1 追補）。
  既存 7 クラスと同じ severity: critical / fail-closed ポリシーに乗せる。
- file-deletion 系（パターン 7）は**そのままでは追加しない**。revert commit 検出・同一 diff 内の
  rename/move 検出などの追加ロジックを設計してから再検討する（本 issue のスコープ外、follow-up）。
- assert/expect 行の「純減」（削除数 > 追加数）チェックも**候補から除外する**（レビュー指摘により
  検証・§4-1 追補）。25 merge corpus で実測した結果、FP 3/25 が発生し、その全件が file-deletion 系
  パターン 7 の FP（revert/リファクタ commit）と完全一致した。単純な行数比較では cheat と
  legitimate な test 整理を区別できないため、パターン 7 と同じ「revert/rename 検出ロジックが
  要る」follow-up 課題として扱う。
- `recall-early-return` / `recall-expected-rewritten`（assertion の意味的改変）は grep では検出不可能
  であることが確定した。将来的にカバーする場合は Option A 系（veridelta 等の実行時比較）以外の
  アプローチ（coverage diff、mutation testing 等）を別途検討する必要がある旨を issue 本文に明記する。
- Option A（veridelta `--ref` baseline 比較）は本 issue では見送るが、sunset/再評価の余地を残すため
  W7 の distrust 機構分類には含めない（そもそも未採用のため）。再検討する場合の前提条件として
  「dev-flow の exec-proxy が git object 書き込みを伴う決定論プロキシを安定実行できること」を
  issue #362 の Open Questions に記載する。
- 本 spike で判明した「sandboxed Bash 実行環境下での `mkdir`/`touch`/`ln -s`/`git add -A` 等の
  書き込み系操作の不安定性（clean tree でも再現）」は issue #361/#362 のスコープを超える、
  dev-flow exec-proxy 基盤全体に関わる既知事象（`devflow-vitest-sandbox-eperm.md` と同系統）である。
  本 issue では直接対処せず、事実の記録に留める。
