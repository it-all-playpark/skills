---
name: dev-kickoff
description: |
  End-to-end feature development orchestrator using git worktree. Coordinates git-prepare, issue-analyze, implement, validate, commit, and create-pr skills.
  Use when: starting new feature development from GitHub issue, full development cycle automation with isolated worktree.
  Accepts args: <issue-number> [--strategy tdd|bdd|ddd] [--depth minimal|standard|comprehensive] [--base <branch>] [--lang ja|en] [--env-mode hardlink|symlink|copy|none] [--worktree <path>] [--task-id <id>] [--flow-state <path>]
allowed-tools:
  - Bash
  - TodoWrite
---

# Kickoff

Orchestrate complete feature development cycle from issue to PR.

## CRITICAL: Complete All 6 Phases

**DO NOT EXIT until Phase 6 (PR creation) completes and pr-iterate is called.**

| Phase | Action | Complete When | Parallel Mode |
|-------|--------|---------------|---------------|
| 1 | Worktree creation | Path exists, .env verified | SKIP |
| 2 | Issue analysis | Requirements understood | SKIP |
| 3 | Implementation | Code written | Execute |
| 4 | Validation | Tests pass | Execute |
| 5 | Commit | Changes committed | Execute (enhanced) |
| 6 | PR creation | PR URL available | SKIP |

After Phase 6: Call `Skill: pr-iterate $PR_URL` to complete the workflow.

## Phase Checklist

```
[ ] Phase 1: git-prepare.sh → init-kickoff.sh          (skip if --task-id)
[ ] Phase 2: Skill: dev-issue-analyze                   (skip if --task-id)
[ ] Phase 3: Skill: dev-implement
[ ] Phase 4: Skill: dev-validate --fix
[ ] Phase 5: Skill: git-commit --all
[ ] Phase 6: Skill: git-pr → pr-iterate                 (skip if --task-id)
```

## State Management

State persisted in `$WORKTREE/.claude/kickoff.json` for recovery.

### Initialize (After Phase 1)

```bash
$SKILLS_DIR/dev-kickoff/scripts/init-kickoff.sh $ISSUE $BRANCH $WORKTREE \
  --base $BASE --strategy $STRATEGY --depth $DEPTH --lang $LANG --env-mode $ENV_MODE
```

### Update Phase Status

```bash
# Start phase
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh <phase> in_progress --worktree $PATH

# Complete phase
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh <phase> done --result "Summary" --worktree $PATH

# After PR creation (Phase 6)
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 6_pr done \
  --result "PR created" --pr-number 123 --pr-url "URL" --worktree $PATH
```

## Phase Execution

| Phase | Command | Subagent | Parallel Mode |
|-------|---------|----------|---------------|
| 1 | `$SKILLS_DIR/git-prepare/scripts/git-prepare.sh $ISSUE --base $BASE --env-mode $ENV_MODE` | - | SKIP |
| 1b | `$SKILLS_DIR/dev-kickoff/scripts/init-kickoff.sh ...` | - | SKIP |
| 2 | `Skill: dev-issue-analyze $ISSUE --depth $DEPTH` | Task(Explore) | SKIP |
| 3 | `Skill: dev-implement --strategy $STRATEGY --worktree $PATH` | - | Execute |
| 4 | `Skill: dev-validate --fix --worktree $PATH` | Task(quality-engineer) | Execute |
| 5 | `Skill: git-commit --all --worktree $PATH` | - | Execute (enhanced) |
| 6 | `Skill: git-pr $ISSUE --base $BASE --lang $LANG --worktree $PATH` | - | SKIP |

Phase 1: Must execute script. Direct `git worktree add` is prohibited.

## Phase 1 Verification

```bash
ls $WORKTREE/.env || echo "ERROR: .env not linked"
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | GitHub issue number |
| `--strategy` | `tdd` | Implementation strategy |
| `--depth` | `standard` | Analysis depth |
| `--base` | `main` | PR base branch |
| `--lang` | `ja` | PR language |
| `--env-mode` | `hardlink` | Env file handling |
| `--worktree` | - | Pre-created worktree path (skips Phase 1) |
| `--task-id` | - | Subtask ID from flow.json (enables parallel mode) |
| `--flow-state` | - | Path to flow.json (read-only reference) |

## Parallel Subtask Mode

When `--task-id` is specified, dev-kickoff runs in parallel subtask mode (see Phase table "Parallel Mode" column).

### Reading Subtask Scope

The subtask scope is read from flow.json:

```bash
$SKILLS_DIR/_lib/scripts/flow-read.sh --flow-state $FLOW_STATE --subtask $TASK_ID
```

### Phase 5 Enhancement

After commit, record changed files:

```bash
git diff --name-only $BASE_BRANCH...HEAD
```

Result stored in kickoff.json under `actual_files_changed` field.

### Return Value

Return value in `--task-id` mode is minimal:

```json
{"task_id": "task1", "status": "completed|failed"}
```

## Error Handling

| Phase | On Failure |
|-------|------------|
| 1-2 | Abort, update state |
| 3 | Pause for intervention |
| 4 | Retry with --fix |
| 5-6 | Report command, save state |

## Journal Logging

On workflow completion or failure, log execution to skill-retrospective journal:

```bash
# On success (after Phase 6)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

# On failure (at any phase)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" \
  --error-phase <phase> --worktree $WORKTREE

# On partial (completed with manual intervention)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff partial \
  --issue $ISSUE --error-category <category> --error-msg "<message>" \
  --recovery "<what was done>" --recovery-turns $N --worktree $WORKTREE
```

## References

- [Phase Details](references/phase-detail.md) - Detailed phase documentation
- [State Schema](references/phase-detail.md#state-schema) - kickoff.json format
