# pr-iterate goal 駆動移行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pr-iterate を state machine skill から「skill-scoped Stop hook + subagent」の goal 駆動パラダイムへ移行し、`/pr-iterate <pr>` 一発で approved+CI passed まで自律ループさせる。

**Architecture:** ループ駆動を skill frontmatter の agent-based Stop hook に委譲（完了条件を毎ターン実検証）。判断系は pr-reviewer（既存）+ pr-fixer（新規）subagent。iterate.json 等の state machine を全廃。

**Tech Stack:** Claude Code skills / subagents / agent-based Stop hooks（v2.1.139+）、bash、bats、gh CLI。

**Spec:** `docs/superpowers/specs/2026-05-30-pr-iterate-goal-migration-design.md`

---

## ⚠️ Phase 0 が gating

Task 0 の spike 結果で Stop hook の形が分岐する：
- **引数展開 OK** → agent-based Stop hook に `$pr` を埋める（design 本線）
- **引数展開 NG** → 本文が verdict/CI を会話に明示し、引数不要の prompt-based Stop hook にフォールバック

Task 3 はこの結果を反映するため、Task 0 完了まで着手しない。

---

### Task 0: Phase 0 spike — agent-based Stop hook の引数展開検証

**Files:**
- Create（一時・検証後削除）: `.claude/skills/_spike-hook-arg/SKILL.md`

- [ ] **Step 1: 検証用 skill を作成**

```yaml
---
name: _spike-hook-arg
description: spike — agent-based Stop hook の引数展開検証用。使用後削除。
arguments: [pr]
disable-model-invocation: true
hooks:
  Stop:
    - type: agent
      prompt: |
        次の値が数値 999 と一致するか確認: "$pr"。
        一致したら {"ok": true, "reason": "arg expanded: $pr"}、
        不一致なら {"ok": false, "reason": "got literal: $pr"} を返せ。
        いずれにせよ1ターンで判定し継続させない。
---
# _spike-hook-arg
このターンでは何もせず即終了する。Stop hook の評価理由を観察するのが目的。
```

- [ ] **Step 2: セッション reload（subagent/skill hook 登録のため）**

新セッションを開始（hook はセッション開始時に登録される）。

- [ ] **Step 3: spike を起動して hook の reason を観察**

Run: `/_spike-hook-arg 999`
観察: `/goal` 風の status / transcript に出る Stop hook の reason に
`arg expanded: 999`（展開成功）か `got literal: $pr`（展開失敗）のどちらが出るか。

- [ ] **Step 4: 結果を design doc の Open question 1 に追記**

`docs/superpowers/specs/2026-05-30-pr-iterate-goal-migration-design.md` の
Open questions セクションに結果（OK/NG）と採用する Stop hook 形式を1行追記。

- [ ] **Step 5: spike skill を削除して commit**

```bash
rip .claude/skills/_spike-hook-arg
git add -A
git commit -m "spike(pr-iterate): agent-based Stop hook の引数展開を検証"
```

---

### Task 1: pr-fixer の commit+push 決定論スクリプト

pr-fixer subagent 本文から呼ぶ決定論部分（commit+push）を script 化し bats で固定する。
既存 `pr-fix/scripts/pr-finish.sh` のロジックを pr-iterate 配下へ移す。

**Files:**
- Create: `pr-iterate/scripts/fixer-finish.sh`
- Test: `pr-iterate/scripts/fixer-finish.bats`

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bats
# fixer-finish.bats
setup() {
  REPO="$(mktemp -d)"; cd "$REPO"
  git init -q; git config user.email t@t; git config user.name t
  echo a > f.txt; git add f.txt; git commit -qm init
  SCRIPT="${BATS_TEST_DIRNAME}/fixer-finish.sh"
}
teardown() { rm -rf "$REPO"; }

@test "変更なしなら no_changes を JSON で返し commit しない" {
  run bash "$SCRIPT" --no-push
  [ "$status" -eq 0 ]
  [[ "$output" == *'"result":"no_changes"'* ]]
}

@test "変更ありなら commit して committed を返す" {
  echo b >> f.txt
  run bash "$SCRIPT" --no-push --message "fix: tweak"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"result":"committed"'* ]]
  run git log --oneline -1
  [[ "$output" == *"fix: tweak"* ]]
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bats pr-iterate/scripts/fixer-finish.bats`
Expected: FAIL（`fixer-finish.sh` not found）

- [ ] **Step 3: Write minimal implementation**

```bash
#!/usr/bin/env bash
# fixer-finish.sh - pr-fixer の commit+push 決定論部。変更検出→commit→(push)。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

NO_PUSH=0; MSG="fix: address review feedback"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-push) NO_PUSH=1; shift ;;
    --message) MSG="$2"; shift 2 ;;
    *) die_json "Unknown option: $1" 1 ;;
  esac
done

if git diff --quiet && git diff --cached --quiet; then
  echo '{"result":"no_changes"}'; exit 0
fi

git add -A
git commit -qm "$MSG"
if [[ "$NO_PUSH" -eq 0 ]]; then
  git push 2>/dev/null || die_json "push failed" 1
fi
echo '{"result":"committed"}'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bats pr-iterate/scripts/fixer-finish.bats`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
chmod +x pr-iterate/scripts/fixer-finish.sh
git add pr-iterate/scripts/fixer-finish.sh pr-iterate/scripts/fixer-finish.bats
git commit -m "feat(pr-iterate): pr-fixer 用 commit+push スクリプトを追加"
```

---

### Task 2: pr-fixer subagent 定義

**Files:**
- Create: `.claude/agents/pr-fixer.md`

- [ ] **Step 1: pr-fixer.md を作成**

```markdown
---
name: pr-fixer
description: |
  Apply minimal fixes to a PR based on a reviewer's issue list, then commit+push.
  Invoked by orchestration (pr-iterate). Returns {applied[], skipped[]}.
permissionMode: auto
model: sonnet
tools:
  - Read
  - Edit
  - Grep
  - Glob
  - Bash
---

# pr-fixer

pr-reviewer の `issues` リストを受け、PR 差分範囲内へ最小修正を適用し commit+push する
subagent。レビュー送信や計画判断はしない。

## Objective
渡された issues に対し、PR 差分範囲内のファイルへ最小限の修正を適用し、
`fixer-finish.sh` で commit+push する。

## Inputs（spawn prompt に含まれる）
- `pr_number`、`issues`: [{file, line?, severity, message}]

## Steps
1. issues を severity 順（critical→nit）に確認
2. 各 issue について PR 差分範囲内のファイルを Edit で最小修正
3. 対応不能/範囲外の issue は skip（理由を記録）
4. lint/test がある場合は実行して回帰を確認
5. `~/.claude/skills/pr-iterate/scripts/fixer-finish.sh --message "<日本語要約>"` で commit+push

## Output
{"applied": [{"file","change_summary"}], "skipped": [{"issue","reason"}]}
（change_summary / reason は日本語）

## Tools
- 使用可: Read, Edit, Grep, Glob, Bash（lint/test/git via fixer-finish.sh）
- 禁止: Write（新規作成は issue が要求した場合のみ）, gh pr review（送信は親のみ）,
  main/dev 直接操作, subagent spawn

## Boundaries
- PR 差分範囲内のファイルのみ編集
- `.github/workflows/` は issue が明示した場合のみ
- 依存追加は lockfile がある場合のみ

## Token cap
2000 語以内、編集ファイル最大 15 件。
```

- [ ] **Step 2: Commit**

```bash
git add .claude/agents/pr-fixer.md
git commit -m "feat(pr-iterate): pr-fixer subagent 定義を追加"
```

- [ ] **Step 3: セッション reload**

新セッションを開始（subagent はセッション開始時に登録される。reload しないと
`agentType:'pr-fixer'` が解決できない）。

---

### Task 3: pr-iterate SKILL.md を goal 駆動へ書き換え

Task 0 の spike 結果を反映する。以下は **引数展開 OK** の本線。NG なら Step 1 の
`hooks.Stop[].prompt` から `$pr` を除き、本文が「verdict=X / CI=Y」を会話に明示する形へ。

**Files:**
- Modify: `pr-iterate/SKILL.md`（全面書き換え）

- [ ] **Step 1: frontmatter を置換**

```yaml
---
name: pr-iterate
description: |
  Iterate a PR until LGTM via a skill-scoped completion-condition loop.
  Use when: (1) PR needs review→fix rounds, (2) keywords: iterate, until LGTM
  Accepts args: <pr-number-or-url>
argument-hint: [pr-number]
arguments: [pr]
allowed-tools:
  - Agent
  - Bash(gh:*)
  - Bash(~/.claude/skills/pr-iterate/scripts/*)
  - Bash(~/.claude/skills/skill-retrospective/scripts/*)
hooks:
  Stop:
    - type: agent
      prompt: |
        PR #$pr が LGTM か検証せよ。
        - pr-reviewer の直近 verdict が approved
        - `~/.claude/skills/pr-iterate/scripts/check-ci.sh $pr` の status が passed
        両方満たせば {"ok": true}。未達なら {"ok": false, "reason": "<残作業1文>"}。
        会話が20ターンを超えていれば {"ok": true, "reason": "max turns reached"}。
---
```

- [ ] **Step 2: 本文を 1 ターン手順へ置換**

```markdown
# PR Iterate: $pr

レビュー指摘が解消され approved + CI passed になるまで、Stop hook が本スキルを
毎ターン再実行する。**ループ・iteration カウンタは書かない。**

## 1 ターンの手順

1. `pr-reviewer` subagent を Agent で呼び、PR #$pr の verdict を取得（read-only）。
2. `verdict.decision == approved` なら
   `~/.claude/skills/pr-iterate/scripts/post-summary.sh` で最終サマリーを投稿し終了。
3. `request-changes` / `comment` なら `pr-fixer` subagent を Agent で呼び、
   `verdict.issues` を渡して修正+push させる。
4. ターンを終える（継続判定は Stop hook が行う）。

## 言語ルール
verdict.message / summary / 投稿文は日本語。

## Journal Logging
LGTM 到達時に skill-retrospective へ記録：
`~/.claude/skills/skill-retrospective/scripts/journal.sh log pr-iterate success --issue $pr`
```

- [ ] **Step 3: 手動スモーク（reload 後）**

新セッションで `/pr-iterate <自分の test PR>` を起動し、
(a) pr-reviewer が呼ばれ verdict が出る (b) request-changes なら pr-fixer が走る
(c) Stop hook の reason が status に出てループが回る、を確認。

- [ ] **Step 4: Commit**

```bash
git add pr-iterate/SKILL.md
git commit -m "feat(pr-iterate): goal 駆動（skill-scoped Stop hook）へ書き換え"
```

---

### Task 4: state machine scripts と iterate.json を廃止

**Files:**
- Delete: `pr-iterate/scripts/init-iterate.sh`
- Delete: `pr-iterate/scripts/record-iteration.sh`
- Delete: `pr-iterate/scripts/check-resume.sh`
- Delete: 上記の `*.bats`（存在すれば）
- Keep: `check-ci.sh` / `post-summary.sh` / submit 系

- [ ] **Step 1: 削除対象が他から参照されていないか確認**

Run: `grep -rn "init-iterate\|record-iteration\|check-resume\|iterate\.json" --include="*.sh" --include="*.md" . | grep -v "pr-iterate/scripts/\(init-iterate\|record-iteration\|check-resume\)"`
Expected: dev-flow/dev-kickoff/pre-compact-save 等の参照を洗い出す（Task 5・7 で対応）。

- [ ] **Step 2: 削除**

```bash
rip pr-iterate/scripts/init-iterate.sh pr-iterate/scripts/record-iteration.sh pr-iterate/scripts/check-resume.sh
```

- [ ] **Step 3: bats 一括が通ることを確認**

Run: `bash tests/run-all-bats.sh`
Expected: PASS（削除した script の bats も消えているか確認）

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(pr-iterate): state machine scripts を廃止（Stop hook が代替）"
```

---

### Task 5: pre-compact-save.sh の iterate.json 参照を削除

**Files:**
- Modify: `_lib/scripts/pre-compact-save.sh`（`ITERATE_STATE` 参照を削除）
- Test: `_lib/scripts/pre-compact-save.bats`（存在すれば追記、なければ最小作成）

- [ ] **Step 1: 該当行を確認**

Run: `grep -n "ITERATE_STATE\|iterate.json" _lib/scripts/pre-compact-save.sh`
Expected: line 17（`ITERATE_STATE=...`）と line 126（dump テキスト内の参照）。

- [ ] **Step 2: Write failing test（iterate.json に触れないこと）**

```bash
@test "pre-compact dump は iterate.json を参照しない" {
  run grep -c "iterate.json" "${BATS_TEST_DIRNAME}/pre-compact-save.sh"
  [ "$output" -eq 0 ]
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bats _lib/scripts/pre-compact-save.bats`
Expected: FAIL（現状 iterate.json 参照あり）

- [ ] **Step 4: 参照を削除**

`ITERATE_STATE="$STATE_DIR/iterate.json"` 行と、dump テキスト（line ~126）の
`.claude/iterate.json` 言及を削除。kickoff.json 参照は残す。

- [ ] **Step 5: Run test to verify it passes**

Run: `bats _lib/scripts/pre-compact-save.bats`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add _lib/scripts/pre-compact-save.sh _lib/scripts/pre-compact-save.bats
git commit -m "refactor(pre-compact): pr-iterate 廃止に伴い iterate.json 参照を削除"
```

---

### Task 6: 旧 pr-fix skill を削除

pr-fixer subagent が代替するため削除（no-backcompat 原則）。

**Files:**
- Delete: `pr-fix/`（SKILL.md, scripts/）

- [ ] **Step 1: pr-fix の被参照を確認**

Run: `grep -rln "pr-fix\b\|Skill: \`pr-fix\|pr-fix/scripts" --include="*.md" --include="*.sh" . | grep -v "pr-fix/"`
Expected: pr-iterate 旧本文（Task 3 で除去済）以外に残る参照を洗い出す。

- [ ] **Step 2: 残参照を更新後、削除**

```bash
rip pr-fix
```

- [ ] **Step 3: bats 一括 PASS**

Run: `bash tests/run-all-bats.sh`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: 旧 pr-fix skill を削除（pr-fixer subagent が代替）"
```

---

### Task 7: dev-flow / dev-kickoff の pr-iterate 呼び出し口を確認

**Files:**
- Modify（必要時）: `dev-flow/SKILL.md`, `dev-flow/references/*.md`, `dev-kickoff/*` の
  `Skill: pr-iterate` / iterate.json 参照箇所

- [ ] **Step 1: 呼び出し口を列挙**

Run: `grep -rn "pr-iterate\|iterate\.json\|record-iteration" dev-flow/ dev-kickoff/ --include="*.md" --include="*.sh"`

- [ ] **Step 2: 各参照を新形式へ更新**

- `Skill: pr-iterate $PR` → 新 pr-iterate は引数 `<pr>` のみ受ける形に整合（`--max-iterations` 廃止を反映）
- `iterate.json` を前提にした recovery/status 記述は「Stop hook + --resume が代替」へ書き換え
- 各修正は1ファイルずつ確認しながら最小変更

- [ ] **Step 3: bats 一括 + grep で旧参照ゼロを確認**

Run: `bash tests/run-all-bats.sh && grep -rn "record-iteration\|init-iterate\|check-resume" dev-flow/ dev-kickoff/ || echo "no stale refs"`
Expected: PASS かつ stale 参照なし。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(dev-flow): pr-iterate goal 駆動化に伴い呼び出し口を更新"
```

---

### Task 8: E2E 検証と PR 作成

- [ ] **Step 1: 実 PR でフルループを確認**

新セッションで request-changes になる test PR に対し `/pr-iterate <pr>` を起動し、
review→fix→再 review→approved まで Stop hook 駆動で自律完走することを確認。
途中 submit が無く最終サマリーのみ投稿されることも確認。

- [ ] **Step 2: journal を確認**

Run: `~/.claude/skills/skill-retrospective/scripts/journal.sh ...`（success が記録されているか）

- [ ] **Step 3: PR 作成**

```bash
git push -u origin worktree-pr-review-wf-poc
gh pr create --title "feat(pr-iterate): goal 駆動（Stop hook + subagent）へ移行" \
  --body "spec: docs/superpowers/specs/2026-05-30-pr-iterate-goal-migration-design.md"
```

---

## Self-Review（記入済）

**Spec coverage:** spec の各節 → Task 対応:
- パラダイム転換 → Task 3（Stop hook）/ Task 4（state 廃止）
- pr-fixer 新規 → Task 1+2 / pr-reviewer は既存（PoC で実証済、変更なし）
- 廃止リスト → Task 4 / 残す決定論 → check-ci・post-summary（Task 4 で keep）
- pre-compact 連携 → Task 5 / 旧 pr-fix 削除 → Task 6 / 呼び出し口 → Task 7
- Open question 1（引数展開）→ Task 0 spike（gating）

**Placeholder scan:** Task 7 Step 2 のみ「各参照を最小変更」と幅がある。これは grep 結果に
依存し事前に全列挙できないため、手順（1ファイルずつ確認）と完了条件（Step 3 で stale ゼロ）を
明示して曖昧さを限定した。他は完全コード記載。

**Type consistency:** `fixer-finish.sh` の出力 `{"result":"committed"|"no_changes"}` は
Task 1 で定義し pr-fixer（Task 2 Step 5）が呼ぶ形で一貫。pr-fixer 出力
`{applied[], skipped[]}` は spec と一致。Stop hook 完了条件（approved + CI passed）は
Task 0/3 で同一表現。
