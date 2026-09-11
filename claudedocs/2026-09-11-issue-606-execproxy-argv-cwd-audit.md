# issue #606 AC-5: exec-proxy 呼び出し全件の cwd 依存監査

## 1. 目的

issue #606 AC-5: 「cwd 依存の回避が argv 側（worktree 絶対パスの引数渡し）で成立していることを、
既存 exec-proxy の呼び出し全件について確認した記録が issue または PR にある」を満たすための記録。

- 確認日: 2026-09-11
- 確認対象 commit: `715ca1d`（`git -C <worktree> rev-parse --short HEAD` の出力。本 issue の
  F1/F2 変更はこの commit の上に worktree 内で加えられた未commit状態）
- 対象ファイル: `plugins/dev-flow/.claude/workflows/dev-flow.js`（37 箇所）、
  `plugins/dev-flow/.claude/workflows/pr-iterate.js`（11 箇所）。合計 48 箇所

## 2. 契約の要約

F1（`plugins/dev-flow/agents/dev-runner.md` 他 2 agent 定義）で追加された契約文（正当化クラス: contract）:

> exec-proxy の argv 転写契約（正当化クラス: contract）: 呼び出し側 prompt が渡したコマンド行（argv）を
> **一字一句そのまま実行**する。which による絶対パス解決・絶対パスへの書き換え・変数代入の前置
> （`VAR=x cmd`）・`cd X &&` の付加・`bash` 前置を行わない。exec-proxy は決定論スクリプトへの verbatim
> 転写契約であり、argv の書き換えは転写の破壊にあたる（stdout の verbatim 返却と同じ原則を入力側にも
> 適用する）。cwd 依存の回避は呼び出し側が argv に worktree 絶対パスを引数として含めること（例:
> `worktree-diff-hash <worktree> <base>`）で成立しているため、agent 側で cwd を作らない。呼び出し側
> prompt が cd を指示している場合はその指示に従う（禁止するのは agent 自身の判断による前置）

F2（`dev-flow.js` の `dhPrompt`）で ci-check と同水準に揃えた契約文:

> argv は一字一句そのまま実行する — which による絶対パス解決・絶対パスへの書き換え・cd 前置・
> `bash` 前置・環境変数代入前置・&& 連結は禁止（exec-proxy は決定論スクリプトへの verbatim 転写契約
> であり、argv の書き換えは転写の破壊にあたる。第 1 引数で worktree 絶対パスを渡しているため cd は
> 不要）

本監査は、この契約の下で各呼び出し（label 単位）が実際に **どちらの経路で** cwd 非依存 / 依存を
成立させているかを全件について確認したものである。

## 3. 分類基準

- **A: argv で cwd 非依存** — コマンド自身が worktree 絶対パス引数、`git -C <path>`、`--repo`（値が
  常に確定している場合）、または Read/Write の絶対パス指定で完結する。呼び出し側が `cd ${WT} で作業。`
  を前置していても、コマンド自体が argv で完結していれば A に分類する（cd は冗長だが無害）。
- **B: 呼び出し側の cd 指示 / 暗黙の起動時 cwd に依存** — コマンドが path 引数・`--repo` を持たない
  `git` / `gh` 操作や `Skill:` 呼び出しで、cwd がその git repo として妥当であることに依存する。
  `cd ${WT} で作業。` の明示指示がある場合と、明示指示が無く exec-proxy 呼び出し元の起動時 cwd に
  暗黙に依存する場合の両方をこの区分に含める（後者は表の根拠列に「cd 明示なし」と付記する）。
  新契約は「呼び出し側 prompt が cd を指示している場合はその指示に従う」ため、現状の動作は維持される。
- **C: 該当なし** — Bash を使わない（Write/Read のみで path は絶対値）、または worktree が未確立の
  bootstrap 段階（`pwd` で cwd を取得する側であり、cwd の正しさを前提にする側ではない）。

## 4. 全件表

### dev-flow.js（37 行）

| file:line | label | agentType | 実行コマンド（先頭トークン+主要引数） | 分類 | 根拠 |
|---|---|---|---|---|---|
| dev-flow.js:718 | journal-save | dev-runner-haiku | Write tool → 絶対パス `savePath` | A | `buildJournalSaveInstr` は事前検証済み絶対パスへ Write。Bash 不使用 |
| dev-flow.js:731 | journal-log | dev-runner-haiku | Write tool → `~/.claude/journal/pending/<file>` | A | `buildJournalLogInstr` も絶対パス固定。Bash 不使用 |
| dev-flow.js:4772 | setup-base | dev-runner-haiku-ro | `git ls-remote ...`（複合ワンライナー、path引数なし） | C | worktree 作成前の bootstrap probe。guard-safe 化のため意図的に path 引数を持たない設計（コメント参照） |
| dev-flow.js:4799 | worktree | dev-runner-haiku | `git worktree add -b <branch> <repo>/.claude/worktrees/df-<issue> origin/<base>` | C | worktree をこの呼び出し自身が作る（「リポジトリルートで」実行する設計。WT はまだ存在しない） |
| dev-flow.js:4815 | isolation-cleanup | dev-runner-haiku | `git -C ${worktree} clean -fdx -- .devflow-tmp` | A | `-C ${worktree}` 明示 |
| dev-flow.js:4826 | isolation-probe | dev-runner-haiku-wo | Write tool → `${worktree}/.devflow-tmp/.isolation-probe-<token>` | A | 絶対パス。Write のみ |
| dev-flow.js:4834 | worktree-deps | dev-runner-haiku | `cd ${worktree} で作業` + `ensure-worktree-deps --path ${worktree} --lockfile-only --skip-custom` | A | `--path ${worktree}` で argv 完結（cd は冗長） |
| dev-flow.js:4926 | contract-probe#\<issue\> | dev-runner-haiku-ro | `gh issue view <issue>${REPO?' --repo '+REPO:''} ... > <mktemp>` then `analyze-issue <issue> --issue-json <mktemp> --contract` | B | cd 明示なし。`gh issue view` は REPO が null のとき --repo 無しで cwd の repo に依存（`analyze-issue` 自体は絶対パス引数で A 相当だが、先行する gh 取得ステップが全体の cwd 依存を決める） |
| dev-flow.js:4945 | analyze#\<issue\> | dev-runner | `cd ${WT} で作業。Skill: dev-issue-analyze` | B | skill 内部で bare `gh issue view <issue> ... > $TMPDIR/...`（--repo 無し）を実行（`dev-issue-analyze/SKILL.md`）。cd 指示で成立 |
| dev-flow.js:4956 | issue-meta | dev-runner-haiku-ro | `cd ${WT} で作業` + `gh issue view ${ISSUE}${REPO?' --repo '+REPO:''} --json number,title,comments` | B | cd 明示。REPO null 時 --repo 無しで cwd 依存 |
| dev-flow.js:4996 | analyze-retrunc#\<issue\> | dev-runner | `cd ${WT} で作業。Skill: dev-issue-analyze` | B | analyze# と同一経路 |
| dev-flow.js:5256 | analyze-retry#\<issue\> | dev-runner | `cd ${WT} で作業。Skill: dev-issue-analyze` | B | 同上 |
| dev-flow.js:5336 | test#\<i\>/test#retry-\<i\> | dev-runner-haiku | `cd ${WT} で作業` + `${WT}/tests/run-tests.sh`（VALIDATE_TEST_PROMPT） | A | 絶対パス先頭トークン bare 形が規約で明示されている |
| dev-flow.js:5413 | diff-gate | dev-runner-haiku-ro | `worktree-diff-hash ${WT} origin/${BASE}`（dhPrompt） | A | 第1引数が worktree 絶対パス（F2 契約対象） |
| dev-flow.js:5427 | issue-labels | dev-runner-haiku-ro | `cd ${WT} で作業` + `gh issue view ${ISSUE}${REPO?' --repo '+REPO:''} --json labels --jq ...` | B | issue-meta と同型 |
| dev-flow.js:5436 | cross-repo-artifacts | dev-runner-haiku-ro | `cross-repo-artifacts ${WT} <candidate paths...>` | A | 第1引数が worktree 絶対パス（`cross-repo-artifacts.sh` Usage 確認済み） |
| dev-flow.js:5477 | diff-gate-retry | dev-runner-haiku-ro | `worktree-diff-hash ${WT} origin/${BASE}`（dhPrompt） | A | diff-gate と同一 |
| dev-flow.js:5533 | danger-grep | dev-runner-haiku-ro | `secfloor-classify ${WT} origin/${BASE}` | A | 第1引数が worktree 絶対パス（`secfloor-classify.sh` Usage: `<worktree-path> <base-ref>`） |
| dev-flow.js:5594 | ui-verify-config | dev-runner-haiku-ro | `cd ${WT} で作業` + Read `${WT}/skill-config.json` / `${WT}/.claude/skill-config.json` | A | Read 対象が絶対パス |
| dev-flow.js:5707 | ui-verify-server\<suffix\> | dev-runner-haiku | `ui-verify-server start --dir '${srvDir}' --port ... --state-dir '${stateDir}' ...` | A | `srvDir`/`stateDir` は `${WT}/...` 絶対パス |
| dev-flow.js:5761 | ui-verify-teardown\<suffix\> | dev-runner-haiku | `ui-verify-server stop --state-dir '${stateDir}'` 等 | A | `stateDir` 絶対パス |
| dev-flow.js:5850 | diff-hash-eval | dev-runner-haiku-ro | `worktree-diff-hash ${WT} origin/${BASE}`（dhPrompt, failOpenAgent） | A | diff-gate と同一 prompt |
| dev-flow.js:5972 | redgreen:AC-\<n\> | dev-runner-haiku | `redgreen-verify ${WT} '<test files>' '<impl files>'` | A | 第1引数が worktree 絶対パス（`redgreen-verify.sh` は内部で `cd "$WT"` する設計） |
| dev-flow.js:6110 | diff-hash-pr | dev-runner-haiku-ro | `worktree-diff-hash ${WT} origin/${BASE}`（dhPrompt, failOpenAgent） | A | 同一 prompt |
| dev-flow.js:6125 | pr#\<issue\> | dev-runner | `cd ${WT} で作業` + `Skill: git-commit --all --worktree ${WT}` → `Skill: git-pr ${ISSUE} --base ${BASE} --lang ja --worktree ${WT}` | B | `git-pr` skill の Step2 `git push -u origin "$BRANCH_NAME"` は `-C`/`--worktree` を取らず cwd 依存（Step3 の `create-pr.sh` 自体は `--worktree` を受けて内部で `cd` する）。cd 指示（`cd ${WT}`）で成立 |
| dev-flow.js:6187 | ci-check-lite | dev-runner-haiku-ro | `gh pr checks ${pr}${repo?' --repo '+repo:''} ...`（ciCheckPrompt） | B | cd 明示なし。REPO null 時 --repo 無しで cwd 依存 |
| dev-flow.js:6257 | reconcile-sync | dev-runner-haiku | `cd ${WT} で作業` + `git -C ${WT} fetch origin ...` / `git -C ${WT} merge --ff-only FETCH_HEAD` | A | `-C ${WT}` 明示 |
| dev-flow.js:6266 | test#final | dev-runner-haiku | VALIDATE_TEST_PROMPT（同上） | A | test# と同一 prompt |
| dev-flow.js:6293 | changed-files-final | dev-runner-haiku-ro | `cd ${WT} で作業` + `git -C ${WT} diff --name-only origin/${BASE}...HEAD` | A | `-C ${WT}` 明示 |
| dev-flow.js:6315 | ui-verify-config-final | dev-runner-haiku-ro | UI_VERIFY_CONFIG_PROMPT（同上） | A | ui-verify-config と同一 prompt |
| dev-flow.js:6348 | ci-final | dev-runner-haiku-ro | `gh pr view ${pr}${repo?' --repo '+repo:''} --json headRefOid,statusCheckRollup`（finalCiPrompt） | B | cd 明示なし。REPO null 時 --repo 無しで cwd 依存 |
| dev-flow.js:6423 | diff-hash-merge | dev-runner-haiku-ro | `worktree-diff-hash ${WT} origin/${BASE}`（dhPrompt, failOpenAgent） | A | 同一 prompt |
| dev-flow.js:6437 | danger-grep-final | dev-runner-haiku-ro | `diff-risk-classify origin/${BASE}` | B | `diff-risk-classify.sh` Usage は `[--working-tree] <base-ref>` のみ（worktree path 引数を取らない設計）。cd 明示あり（`cd ${WT} で作業。`）。--repo / path 引数なしで cd 指示に依存 |
| dev-flow.js:6450 | changed-files | dev-runner-haiku-ro | `git -C ${WT} diff --name-only origin/${BASE}...HEAD` | A | `-C ${WT}` 明示 |
| dev-flow.js:6504 | gh-pr-view | dev-runner-haiku-ro | `gh pr view ${pr.pr_number} --json mergeable,mergeStateStatus` | B | cd 明示あり（`cd ${WT} で作業。`）。--repo / path 引数なしで cd 指示に依存 |
| dev-flow.js:6551 | ci-checks | dev-runner-haiku-ro | `` `gh pr checks ${pr.pr_number}${REPO?' --repo '+REPO:''} --json name,bucket` `` | A | prompt 文中に「`--repo` で cwd 非依存化しているため cd は不要」と明記。この時点で REPO は Setup で確定済み |
| dev-flow.js:6624 | post-summary | dev-runner-haiku | `mktemp` → Write BODY_FILE → `gh pr comment ${pr.pr_number} --body-file <BODY_FILE>` | B | `--repo` 無し。cd 明示もなし |

### pr-iterate.js（11 行）

| file:line | label | agentType | 実行コマンド（先頭トークン+主要引数） | 分類 | 根拠 |
|---|---|---|---|---|---|
| pr-iterate.js:372 | journal-save | dev-runner-haiku | Write tool → 絶対パス `savePath` | A | dev-flow.js と同一関数（`runJournalHandoff`） |
| pr-iterate.js:385 | journal-log | dev-runner-haiku | Write tool → `~/.claude/journal/pending/<file>` | A | 同上 |
| pr-iterate.js:1176 | pr-meta | dev-runner-haiku-ro | `gh pr view ${PR} --json url -q .url` 等 4 コマンド + `pwd` | C | worktree 未確立段階の bootstrap probe。`pwd` で cwd を**取得する側**であり（`isoWt` の元）、cwd の正しさを前提にする側ではない。NESTED 起動時はこの呼び出し自体を skip する設計 |
| pr-iterate.js:1332 | isolation-cleanup | dev-runner-haiku | `git -C ${isoWt} clean -fdx -- <glob>` | A | `-C ${isoWt}` 明示（`isolationCleanupPrompt(isoWt, ...)`） |
| pr-iterate.js:1341 | isolation-probe | dev-runner-haiku-wo | Write tool → `${isoWt}/.devflow-tmp/.isolation-probe-<token>` | A | 絶対パス（`isolationProbePrompt(isoWt, ...)`） |
| pr-iterate.js:1379 | fix#\<i\> | dev-runner | `gh pr checkout ${PR}` → 修正 → commit → `git push` | B | cd 明示なし・`isoWt` 参照もなし。`gh pr checkout`/`git push` は起動時 cwd の git repo に依存（暗黙依存 — 表内で唯一 cd 指示も absolute path もない箇所） |
| pr-iterate.js:1389 | fix#\<i\>-retry | dev-runner | 同上（同一 prompt の再試行） | B | fix#\<i\> と同一 |
| pr-iterate.js:1429 | commit-ensure#\<i\> | dev-runner-haiku | `git -C ${isoWt} status/add/commit/push` | A | `-C ${isoWt}` 明示 |
| pr-iterate.js:1510 | ci-check#\<i\> | dev-runner-haiku-ro | `gh pr checks ${PR}${repo?' --repo '+repo:''} ...`（ciCheckPrompt, REPO は `prMeta.url` から解決） | B | cd 明示なし。REPO 解決失敗時は --repo 無しで cwd 依存（コード中に "repo を解決できず" の警告 log あり＝null になり得る） |
| pr-iterate.js:1673 | worktree-dirty-check | dev-runner-haiku-ro | `git -C ${isoWt} status --porcelain` | A | `-C ${isoWt}` 明示 |
| pr-iterate.js:1712 | post-summary | dev-runner-haiku | `mktemp` → Write BODY_FILE → `gh pr comment ${PR} --body-file <BODY_FILE>` | B | `--repo` 無し。cd 明示もなし |

### 集計

- 表の合計行数: 48（dev-flow.js 37 + pr-iterate.js 11）。`rg -c "agentType: 'dev-runner"` の合計と一致
- 分類内訳: **A = 29**、**B = 16**、**C = 3**（合計 48）
- 未確認: 0 件（全行を実読して分類した）

## 5. B 分類のまとめ

以下は呼び出し側の cd 指示、または（cd 指示すら無い場合は）exec-proxy 呼び出し元の起動時 cwd に
暗黙に依存して成立しており、本 issue の契約変更（agent 自身の判断による前置の禁止）で挙動は変わらない
（新契約は「呼び出し側が cd を指示している場合はその指示に従う」ため）。argv 化（`--repo` の常時付与
／ `git -C <path>` へのコマンド書き換え）は本 issue の非スコープであり、別 issue 候補として以下に
label を列挙する（issue の起票はしていない — 記録のみ）:

- **cd 指示あり（`cd ${WT} で作業。` 等）で成立している箇所**: `analyze#`, `issue-meta`,
  `analyze-retrunc#`, `analyze-retry#`, `issue-labels`, `pr#`, `danger-grep-final`,
  `gh-pr-view`（dev-flow.js）
- **cd 指示・path 引数のいずれも無く、exec-proxy 呼び出し元の起動時 cwd に暗黙依存している箇所**:
  `contract-probe#`, `ci-check-lite`, `ci-final`, `post-summary`
  （dev-flow.js）、`fix#`, `fix#-retry`, `ci-check#`, `post-summary`（pr-iterate.js）— 後者のグループは
  cd 指示も無いため、契約の「呼び出し側 cd 指示への追従」対象にすら該当せず、cwd 依存の根本解消には
  `--repo` 常時付与（gh 系）または `git -C <path>` 化（`gh pr checkout` 系は該当スクリプトなし）を要する

## 6. 確認方法

- `rg -n -B10 "agentType: 'dev-runner" plugins/dev-flow/.claude/workflows/dev-flow.js` /
  `plugins/dev-flow/.claude/workflows/pr-iterate.js` で全呼び出し箇所とその直前の prompt 構築コードを
  抽出
- `rg -n "agentType: 'dev-runner"` で label・agentType の一覧を確定（dev-flow.js 37 / pr-iterate.js 11）
- `rg -n "runJournalHandoff\("` で journal-save/journal-log が共有関数の呼び出しであり、物理行としては
  各ファイル 1 箇所ずつであることを確認
- 各 label が参照する prompt 定義（関数・定数）を実読: `setupBaseProbePrompt`（245行目）,
  `setupDepsPrompt`（4213行目）, `isolationCleanupPrompt`/`isolationProbePrompt`（4417/4427行目）,
  `contractProbePrompt`（4890行目）, `analyzePrompt`（4895行目）, `VALIDATE_TEST_PROMPT`（4844行目）,
  `UI_VERIFY_CONFIG_PROMPT`（4861行目）, `dhPrompt`（5398行目）, `ciCheckPrompt`（3488行目）,
  `finalCiPrompt`（3320行目）, `buildJournalSaveInstr`/`buildJournalLogInstr`（568/670行目）,
  `bodySaveInstr`（4192行目）
- 決定論スクリプトの Usage / 実装を実読して path 引数の有無を確認:
  `plugins/dev-flow/_shared/scripts/diff-risk-classify.sh`（`<base-ref>` のみ、worktree path 引数なし）、
  `plugins/dev-flow/_shared/scripts/secfloor-classify.sh`（`<worktree-path> <base-ref>`）、
  `plugins/dev-flow/_shared/scripts/worktree-diff-hash.sh`（`<worktree-path> <base-ref>`）、
  `plugins/dev-flow/_shared/scripts/redgreen-verify.sh`（`<worktree>` を受けて内部で `cd "$WT"`）、
  `plugins/dev-flow/_shared/scripts/cross-repo-artifacts.sh`（`<worktree-path> <candidate-path>...`）
- skill 定義を実読: `plugins/dev-flow/git-pr/SKILL.md`（Step2 `git push` は cwd 依存、Step3
  `create-pr.sh` は `--worktree` で内部 `cd`）、`plugins/dev-flow/dev-issue-analyze/SKILL.md`
  （内部 `gh issue view` は `--repo` を付与しない設計）
