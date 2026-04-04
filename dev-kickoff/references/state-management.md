# State Management

State persisted in `$WORKTREE/.claude/kickoff.json` for recovery.

## Initialize (After Phase 1)

```bash
$SKILLS_DIR/dev-kickoff/scripts/init-kickoff.sh $ISSUE $BRANCH $WORKTREE \
  --base $BASE --testing $TESTING --design $DESIGN --depth $DEPTH --lang $LANG --env-mode $ENV_MODE
```

## Update Phase Status

```bash
# Start phase
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh <phase> in_progress --worktree $PATH

# Complete phase
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh <phase> done --result "Summary" --worktree $PATH

# After PR creation (Phase 8)
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 8_pr done \
  --result "PR created" --pr-number 123 --pr-url "URL" --worktree $PATH
```

## Phase 1 Verification

```bash
ls $WORKTREE/.env || echo "ERROR: .env not linked"
```

## State Schema

### kickoff.json

```json
{
  "version": "1.0.0",
  "issue": 123,
  "branch": "feature/issue-123-m",
  "worktree": "/path/to/worktree",
  "base_branch": "main",
  "started_at": "2026-01-28T10:00:00Z",
  "updated_at": "2026-01-28T12:00:00Z",
  "current_phase": "3_implement",
  "phases": {
    "1_prepare": {
      "status": "done",
      "started_at": "2026-01-28T10:00:00Z",
      "completed_at": "2026-01-28T10:01:00Z",
      "result": "Worktree created"
    },
    "2_analyze": {
      "status": "done",
      "started_at": "2026-01-28T10:01:00Z",
      "completed_at": "2026-01-28T10:15:00Z",
      "result": "Identified 5 files"
    },
    "3_plan_impl": {
      "status": "in_progress",
      "started_at": "2026-01-28T10:15:00Z"
    },
    "3b_plan_review": { "status": "pending" },
    "4_implement": { "status": "pending" },
    "5_validate": { "status": "pending" },
    "6_evaluate": { "status": "pending" },
    "7_commit": { "status": "pending" },
    "8_pr": { "status": "pending" }
  },
  "next_actions": ["Continue implementation plan"],
  "decisions": [],
  "config": {
    "testing": "tdd",
    "design": null,
    "depth": "standard",
    "lang": "ja",
    "env_mode": "hardlink"
  }
}
```

### After PR Creation

```json
{
  "current_phase": "completed",
  "pr": {
    "number": 456,
    "url": "https://github.com/org/repo/pull/456",
    "created_at": "2026-01-28T12:00:00Z"
  },
  "next_action": "pr-iterate"
}
```

## Recovery Commands

Check current state:
```bash
$SKILLS_DIR/dev-kickoff/scripts/next-action.sh --worktree $PATH
```

Resume from current phase:
```bash
# Read next_action from output and execute
```
