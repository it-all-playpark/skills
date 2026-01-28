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
~/.claude/skills/pr-iterate/scripts/init-iterate.sh $PR [--max-iterations N] --worktree $PATH

# Auto-detect from kickoff.json (when running from worktree or main repo with kickoff.json)
~/.claude/skills/pr-iterate/scripts/init-iterate.sh $PR [--max-iterations N]
```

### Record Results

```bash
# Record review decision
~/.claude/skills/pr-iterate/scripts/record-iteration.sh review \
  --decision <approved|request-changes|comment> \
  [--issues "issue1,issue2"] \
  [--summary "Review summary"]

# Record CI status
~/.claude/skills/pr-iterate/scripts/record-iteration.sh ci --status <passed|failed|pending>

# Record fixes applied
~/.claude/skills/pr-iterate/scripts/record-iteration.sh fix --applied "fix1,fix2"

# Start next iteration
~/.claude/skills/pr-iterate/scripts/record-iteration.sh next

# Complete iteration loop (LGTM時は自動でサマリーをPRコメントに投稿)
~/.claude/skills/pr-iterate/scripts/record-iteration.sh complete --status <lgtm|failed|max_reached>

# サマリー投稿をスキップする場合
~/.claude/skills/pr-iterate/scripts/record-iteration.sh complete --status lgtm --no-summary

# 手動でサマリーを投稿する場合
~/.claude/skills/pr-iterate/scripts/post-summary.sh [--worktree PATH] [--dry-run]
```

### Resume After Compact

1. Read `.claude/iterate.json`
2. Check `current_iteration`, `status`, and `next_actions`
3. Resume from where you left off

## Workflow

1. Initialize: `init-iterate.sh $PR`
2. Loop (max N iterations):
   - Skill: `pr-review $PR`
   - Record: `record-iteration.sh review --decision ... --issues ...`
   - If LGTM → `record-iteration.sh complete --status lgtm` → exit (自動でサマリー投稿)
   - Skill: `pr-fix $PR`
   - Record: `record-iteration.sh fix --applied ...`
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

## Error Handling

| Scenario | Action |
|----------|--------|
| Review decision unclear | Ask for clarification, record decision |
| CI persistently failing | Record failures, pause after 3 consecutive |
| Max iterations reached | Set status `max_reached`, report manual intervention needed |
| Network/API errors | Retry once, then record error and pause |
