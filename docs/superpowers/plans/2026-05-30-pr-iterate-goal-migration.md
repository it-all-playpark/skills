# pr-iterate goal 駆動移行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pr-iterate を state machine skill から「skill-scoped Stop hook + subagent」の goal 駆動パラダイムへ移行し、`/pr-iterate <pr>` 一発で approved+CI passed まで自律ループさせる。

**Architecture:** ループ駆動を skill frontmatter の agent-based Stop hook に委譲（完了条件を毎ターン実検証）。判断系は pr-reviewer（既存）+ pr-fixer（新規）subagent。iterate.json 等の state machine を全廃。

**Tech Stack:** Claude Code skills / subagents / agent-based Stop hooks（v2.1.139+）、bash、bats、gh CLI。

**Spec:** `docs/superpowers/specs/2026-05-30-pr-iterate-goal-migration-design.md`

---

## ✅ Phase 0（gating）は docs で決着 — Task 0 廃止

当初 Task 0（agent-based Stop hook の引数展開 spike）が Task 3 の gating だったが、
**公式 docs（Claude Code v2.1.158, 2026-05-30 確認）で解決済**：

- hook の `prompt:` 内 `$ARGUMENTS` は **hook の JSON input** に展開され、skill 引数
  `$pr` には展開されない。`$pr` 等の skill 引数展開は **SKILL.md 本文のみ**。
- よって plan 当初の「hook prompt に `$pr` を埋める」本線は廃案。**採用方式は
  prompt-type / 会話判定**（本文が verdict/CI を会話に明示 → `type: prompt` Stop hook が
  会話から判定）。詳細は design doc Open question 1 を参照。
- **Task 0 spike は実施しない**（ライブ観察不要）。Task 3 は下記の改訂版で進める。

---

### Task 0: 廃止（docs で決着済 — 実施しない）

当初の引数展開 spike は不要。design doc の Open question 1 に確定結果を記録済。

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

### Task 3: pr-iterate SKILL.md を goal 駆動（prompt-type Stop hook / 会話判定）へ書き換え

**採用方式（docs 決着済）**: hook prompt には skill 引数が展開されないため、`$pr` は
**SKILL.md 本文でのみ**展開する。本文が毎ターン pr-reviewer verdict と `check-ci.sh` の
実出力を**会話に明示**し、`type: prompt` の Stop hook（Haiku 既定）が会話から
`approved + CI passed` を判定する。新スクリプト・state ファイルは作らない。

**重要（Task 2 からの carry-forward）**: 本文に pr-fixer の出力スキーマを再宣言しない。
pr-fixer の契約は `.claude/agents/pr-fixer.md` を正とする（`skipped: [{file,message,reason}]`）。
旧 SKILL.md の `skipped: [{issue_id, reason}]` や条件付き Write 但し書きは**全面書き換えで消す**。

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
  - Task
  - Bash(gh:*)
  - Bash(~/.claude/skills/pr-iterate/scripts/*)
  - Bash(~/.claude/skills/skill-retrospective/scripts/*)
hooks:
  Stop:
    - type: prompt
      prompt: |
        直近の会話だけを根拠に、対象 PR が LGTM に到達したか判定せよ。
        完了条件（両方必須）:
        - pr-reviewer の最新 verdict が approved
        - check-ci.sh の最新出力の status が passed
        両方を会話が明示していれば {"ok": true}。
        どちらか未達・不明なら {"ok": false, "reason": "<残作業を1文・日本語>"}。
        会話のアシスタント手番が20回を超えていれば {"ok": true, "reason": "max turns reached"}。
---
```

- [ ] **Step 2: 本文を 1 ターン手順へ置換**

```markdown
# PR Iterate: $pr

PR #$pr のレビュー指摘が解消され **approved + CI passed** になるまで、Stop hook が
本スキルを毎ターン再実行する。**ループ・iteration カウンタは書かない。**
Stop hook は会話だけを見て継続判定するので、各ターンで下記の状態を会話に明示すること。

## 1 ターンの手順

1. `pr-reviewer` subagent を `Task`（subagent_type: pr-reviewer）で呼び、PR #$pr の verdict を取得（read-only）。
2. `~/.claude/skills/pr-iterate/scripts/check-ci.sh $pr` を実行し CI status を取得。
3. **状態を会話に明示**（Stop hook 判定の根拠）：
   `PR #$pr: verdict=<approved|request-changes|comment>, CI=<passed|failed|pending>`
4. verdict が `approved` かつ CI が `passed` なら、これまでの review→fix 経緯を
   日本語で簡潔にまとめた最終サマリーを構築し `gh pr comment $pr --body "<サマリー>"`
   で投稿して終了（旧 post-summary.sh は iterate.json 依存のため廃止。本文が会話履歴から
   サマリーを構築する）。サマリーには PR 番号・主な指摘と対応・最終 CI 状態を含める。
5. それ以外（verdict が request-changes/comment、または CI failed）なら
   `pr-fixer` subagent を `Task`（subagent_type: pr-fixer）で呼び、`pr_number` と
   `verdict.issues` を渡して修正+push させる。
6. ターンを終える（継続判定は Stop hook が行う）。

> 注: approved+CI passed に到達したターンでのみサマリーを投稿し、その後 Stop hook が
> `{"ok": true}` を返してループ終了するため、重複投稿の懸念はない（旧 `summary_posted_at`
> による dedup は不要）。

## 言語ルール
verdict.message / summary / 投稿文 / Stop hook の reason は日本語。

## Journal Logging
approved+CI passed 到達時に skill-retrospective へ記録：
`~/.claude/skills/skill-retrospective/scripts/journal.sh log pr-iterate success --issue $pr`
```

- [ ] **Step 3: 静的検証（live スモークは Task 8 に集約）**

`pr-iterate/SKILL.md` の frontmatter が YAML として valid か、本文に `$pr` 以外の
未定義変数が無いか、参照スクリプト（check-ci.sh / post-summary.sh）が実在するかを確認:
```bash
grep -n "post-summary.sh\|check-ci.sh" pr-iterate/SKILL.md
ls pr-iterate/scripts/check-ci.sh pr-iterate/scripts/post-summary.sh
```
（live 起動は `~/.claude/skills` = メイン repo からのロードになるため、本ブランチ単体では
動作確認できない。実起動の確認は Task 8 E2E で、メイン repo に新コードが入った状態で行う。）

- [ ] **Step 4: Commit**

```bash
git add pr-iterate/SKILL.md
git commit -m "feat(pr-iterate): goal 駆動（prompt-type Stop hook / 会話判定）へ書き換え"
```

---

### Task 4: state machine scripts と iterate.json を廃止

**スクリプト棚卸し（実調査済 2026-05-30）— Keep/Delete を確定:**

| script | iterate.json 依存 | 判定 |
|--------|:---:|------|
| `check-ci.sh` | なし（`<pr>` を取る standalone） | **Keep**（新 SKILL.md が使用）|
| `pr-iterate-setup.sh` | なし（`<pr>` checkout helper） | **Keep**（standalone helper・state-free）|
| `fixer-finish.sh` / `.bats` | なし | **Keep**（Task 1 で追加）|
| `init-iterate.sh` | あり | **Delete** |
| `record-iteration.sh` | あり | **Delete** |
| `check-resume.sh` | あり | **Delete** |
| `post-summary.sh` | あり（iteration history 完全結合） | **Delete**（新 SKILL.md は `gh pr comment` で代替）|
| `references/summary-template.md` | （post-summary 専用テンプレ） | **Delete** |
| `check-lgtm.sh` | なし（review-file 方式） | **条件付き Delete** — repo 全体 grep で pr-iterate 以外（特に旧 pr-review skill）からの参照が無い場合のみ削除。参照があれば **Keep**（本 plan のスコープ外）|

**Files:**
- Delete: `pr-iterate/scripts/init-iterate.sh`
- Delete: `pr-iterate/scripts/record-iteration.sh`
- Delete: `pr-iterate/scripts/check-resume.sh`
- Delete: `pr-iterate/scripts/post-summary.sh`
- Delete: `pr-iterate/references/summary-template.md`
- Delete（条件付き）: `pr-iterate/scripts/check-lgtm.sh`（外部参照ゼロ時のみ）
- Delete: 上記の `*.bats`（存在すれば）
- Keep: `check-ci.sh` / `pr-iterate-setup.sh` / `fixer-finish.sh` / `.bats`

- [ ] **Step 1: 削除対象が他から参照されていないか確認**

各削除候補を repo 全体で grep し、pr-iterate 自身（Task 3 で書換済の SKILL.md）以外からの
参照を洗い出す:
```bash
grep -rn "init-iterate\|record-iteration\|check-resume\|post-summary\|summary-template\|iterate\.json" \
  --include="*.sh" --include="*.md" . \
  | grep -v "pr-iterate/scripts/\(init-iterate\|record-iteration\|check-resume\|post-summary\)"
# check-lgtm は別途、外部参照の有無を判定:
grep -rn "check-lgtm" --include="*.sh" --include="*.md" . | grep -v "pr-iterate/scripts/check-lgtm"
```
Expected: dev-flow/dev-kickoff/pre-compact-save 等の参照を洗い出す（Task 5・7 で対応）。
**check-lgtm が pr-review 等から参照されていれば削除しない**（Keep）。

- [ ] **Step 2: 削除**

```bash
rip pr-iterate/scripts/init-iterate.sh pr-iterate/scripts/record-iteration.sh \
    pr-iterate/scripts/check-resume.sh pr-iterate/scripts/post-summary.sh \
    pr-iterate/references/summary-template.md
# check-lgtm.sh は Step 1 で外部参照ゼロを確認できた場合のみ:
# rip pr-iterate/scripts/check-lgtm.sh
```
対応する `*.bats` が存在すれば併せて削除する。

- [ ] **Step 3: bats 一括が通ることを確認**

Run: `bash tests/run-all-bats.sh`
Expected: PASS（削除した script の bats も消えているか確認）

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(pr-iterate): state machine scripts と post-summary を廃止（Stop hook + gh pr comment が代替）"
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
