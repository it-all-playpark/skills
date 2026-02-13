---
name: pr-iterate
description: |
  Continuous improvement loop - iterate on PR until LGTM.
  Use when: (1) PR needs multiple rounds of fixes, (2) automated improvement cycle,
  (3) keywords: iterate, improve loop, continuous fix, until LGTM
  Accepts args: <pr-number-or-url> [--max-iterations N]
allowed-tools:
  - Skill
  - Bash
---

# PR Iterate

## ⚠️ Important: No Auto-Merge

**This skill does NOT merge the PR.** After achieving LGTM, the user should manually merge using `gh pr merge` or the GitHub UI.

## Usage

```
/pr-iterate <pr> [--max-iterations N] [--no-summary]
```

| Arg | Default | Description |
|-----|---------|-------------|
| `--max-iterations` | `10` | 最大iteration回数 |
| `--no-summary` | `false` | LGTM時のサマリー投稿をスキップ |

## State Persistence

State is persisted in `$WORKTREE/.claude/iterate.json` for recovery after auto-compact.

### Worktree Auto-Detection

The scripts automatically detect the worktree path using this priority:
1. `--worktree` explicit argument
2. `kickoff.json` auto-detect (reads `worktree` field from `.claude/kickoff.json`)
3. Current git root (fallback)

### Initialize State

```bash
# Explicit worktree
$SKILLS_DIR/pr-iterate/scripts/init-iterate.sh $PR [--max-iterations N] --worktree $PATH

# Auto-detect from kickoff.json (when running from worktree or main repo with kickoff.json)
$SKILLS_DIR/pr-iterate/scripts/init-iterate.sh $PR [--max-iterations N]
```

### Record Results

```bash
# Record review decision (--summary, --issues は日本語で記述)
$SKILLS_DIR/pr-iterate/scripts/record-iteration.sh review \
  --decision <approved|request-changes|comment> \
  [--issues "型安全性の問題,未使用のimport"] \
  [--summary "コード品質に問題なし"]

# Record CI status
$SKILLS_DIR/pr-iterate/scripts/record-iteration.sh ci --status <passed|failed|pending>

# Record fixes applied (--applied は日本語で記述)
$SKILLS_DIR/pr-iterate/scripts/record-iteration.sh fix --applied "型アノテーションを追加,未使用importを削除"

# Start next iteration
$SKILLS_DIR/pr-iterate/scripts/record-iteration.sh next

# Complete iteration loop (LGTM時は自動でサマリーをPRコメントに投稿)
$SKILLS_DIR/pr-iterate/scripts/record-iteration.sh complete --status <lgtm|failed|max_reached>

# サマリー投稿をスキップする場合
$SKILLS_DIR/pr-iterate/scripts/record-iteration.sh complete --status lgtm --no-summary

# 手動でサマリーを投稿する場合
$SKILLS_DIR/pr-iterate/scripts/post-summary.sh [--worktree PATH] [--dry-run]
```

### Resume After Compact

1. Read `.claude/iterate.json`
2. Check `current_iteration`, `status`, and `next_actions`
3. Resume from where you left off

## Workflow

1. Initialize: `init-iterate.sh $PR`
2. Loop (max N iterations):
   - Skill: `pr-review $PR`
   - Record: `record-iteration.sh review --decision ... --issues ... --summary ...`
     - **⚠️ `--summary`, `--issues` の値は日本語で記述すること**
   - If LGTM → `record-iteration.sh complete --status lgtm` → exit (自動でサマリー投稿)
   - Skill: `pr-fix $PR`
   - Record: `record-iteration.sh fix --applied ...`
     - **⚠️ `--applied` の値は日本語で記述すること**
   - Record: `record-iteration.sh next`

## LGTM時のサマリー投稿

`complete --status lgtm` 実行時に自動でPRコメントにiteration履歴サマリーを投稿します。

### サマリー内容
- PR番号、iteration回数、完了日時
- 各iterationのレビュー結果、指摘事項、適用した修正、CI状態
- 最終判定理由

### オプション
- `--no-summary`: サマリー投稿をスキップ
- `--dry-run` (post-summary.sh): 投稿せずにプレビュー表示

### 重複投稿防止
`iterate.json` に `summary_posted_at` フラグを記録し、重複投稿を防止します。

### エラーハンドリング
サマリー投稿に失敗してもiteration完了処理は成功として扱います。

## Subagent Delegation

| Step | Subagent | Reason |
|------|----------|--------|
| pr-review | Task(Plan) | Sequential thinking for complex review analysis |

## State File Location

```
$WORKTREE/
├── .claude/
│   ├── kickoff.json    # From dev-kickoff (contains worktree path, PR info)
│   └── iterate.json    # pr-iterate state
└── docs/
    └── STATE.md        # Human-readable summary (auto-generated)
```

## iterate.json Schema

```json
{
  "pr_number": 456,
  "pr_url": "https://github.com/org/repo/pull/456",
  "worktree_path": "/path/to/worktree",
  "current_iteration": 1,
  "max_iterations": 10,
  "status": "in_progress",
  "summary_posted_at": "2026-01-28T10:00:00Z"
}
```

`summary_posted_at` はLGTM完了時にサマリー投稿後に追加されます（重複投稿防止用）。

## Journal Logging

On workflow completion, log execution to skill-retrospective journal:

```bash
# On LGTM
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log pr-iterate success \
  --issue $ISSUE --duration-turns $TURNS

# On max iterations reached
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log pr-iterate partial \
  --issue $ISSUE --error-category config --error-msg "max iterations reached ($N)" \
  --recovery "manual intervention needed" --recovery-turns 0

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log pr-iterate failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>"
```

## Error Handling

| Scenario | Action |
|----------|--------|
| Review decision unclear | Ask for clarification, record decision |
| CI persistently failing | Record failures, pause after 3 consecutive |
| Max iterations reached | Set status `max_reached`, report manual intervention needed |
| Network/API errors | Retry once, then record error and pause |
