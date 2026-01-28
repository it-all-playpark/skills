# Dev Kickoff - Phase Details

Detailed documentation for each phase in the dev-kickoff workflow.

## Phase Overview

```
Phase 1: Worktree Creation (git-prepare.sh)
    ↓
Phase 1b: State Initialization (init-kickoff.sh)
    ↓
Phase 2: Issue Analysis (dev-issue-analyze)
    ↓
Phase 3: Implementation (dev-implement)
    ↓
Phase 4: Validation (dev-validate)
    ↓
Phase 5: Commit (git-commit)
    ↓
Phase 6: PR Creation (git-pr)
    ↓
Handoff: pr-iterate
```

## Phase 1: Worktree Creation

**Command:**
```bash
~/.claude/skills/git-prepare/scripts/git-prepare.sh $ISSUE --base $BASE --env-mode $ENV_MODE
```

**Purpose:** Create isolated git worktree for feature development.

**Output:**
- Worktree at `../{repo}-worktrees/feature-issue-{N}-m/`
- Branch: `feature/issue-{N}-m`
- Environment files linked/copied per `--env-mode`

**Verification:**
```bash
ls $WORKTREE/.env || echo "ERROR: .env not found"
```

**Completion Criteria:**
- Worktree directory exists
- Branch created and checked out
- .env file present (if env-mode != none)

## Phase 1b: State Initialization

**Command:**
```bash
~/.claude/skills/dev-kickoff/scripts/init-kickoff.sh $ISSUE $BRANCH $WORKTREE \
  --base $BASE --strategy $STRATEGY --depth $DEPTH --lang $LANG --env-mode $ENV_MODE
```

**Purpose:** Create kickoff.json for state tracking.

**Output:**
- `$WORKTREE/.claude/kickoff.json` created
- Phase 1 marked as "done"
- Current phase set to "2_analyze"

## Phase 2: Issue Analysis

**Command:**
```
Skill: dev-issue-analyze $ISSUE --depth $DEPTH
```

**Subagent:** Task(Explore) - for large file reads and codebase exploration

**Purpose:** Understand issue requirements and affected code.

**Completion Criteria:**
- Requirements documented
- Affected files identified
- Implementation approach determined

**State Update:**
```bash
~/.claude/skills/dev-kickoff/scripts/update-phase.sh 2_analyze done \
  --result "Identified N files to modify" \
  --worktree $PATH
```

## Phase 3: Implementation

**Command:**
```
Skill: dev-implement --strategy $STRATEGY --worktree $PATH
```

**Purpose:** Write the actual code changes.

**Strategies:**
- `tdd`: Test-driven development (write tests first)
- `bdd`: Behavior-driven development
- `ddd`: Domain-driven design

**Completion Criteria:**
- All code changes written
- Tests added (if TDD)
- No syntax errors

**State Update:**
```bash
~/.claude/skills/dev-kickoff/scripts/update-phase.sh 3_implement done \
  --result "Implemented feature X" \
  --worktree $PATH
```

## Phase 4: Validation

**Command:**
```
Skill: dev-validate --fix --worktree $PATH
```

**Subagent:** Task(quality-engineer) - for test execution and log analysis

**Purpose:** Verify implementation works correctly.

**Checks:**
- Unit tests pass
- Lint checks pass
- Type checks pass (if applicable)
- Integration tests pass

**On Failure:**
1. `--fix` attempts automatic fixes
2. If still failing, pause for intervention
3. Report specific failures

**Completion Criteria:**
- All tests pass
- No lint errors
- No type errors

**State Update:**
```bash
~/.claude/skills/dev-kickoff/scripts/update-phase.sh 4_validate done \
  --result "All tests pass" \
  --worktree $PATH
```

## Phase 5: Commit

**Command:**
```
Skill: git-commit --all --worktree $PATH
```

**Purpose:** Create git commit with changes.

**Commit Message:**
- Generated based on changes
- Follows conventional commits format
- References issue number

**Completion Criteria:**
- All changes staged
- Commit created
- No uncommitted changes

**State Update:**
```bash
~/.claude/skills/dev-kickoff/scripts/update-phase.sh 5_commit done \
  --result "Committed: <commit message>" \
  --worktree $PATH
```

## Phase 6: PR Creation

**Command:**
```
Skill: git-pr $ISSUE --base $BASE --lang $LANG --worktree $PATH
```

**Purpose:** Create GitHub Pull Request.

**Output:**
- PR created on GitHub
- PR number and URL available

**State Update (with PR info):**
```bash
~/.claude/skills/dev-kickoff/scripts/update-phase.sh 6_pr done \
  --result "PR created" \
  --pr-number 123 \
  --pr-url "https://github.com/org/repo/pull/123" \
  --worktree $PATH
```

This sets `next_action: "pr-iterate"` in kickoff.json.

## Handoff to pr-iterate

After Phase 6 completes:

1. kickoff.json contains:
   - `pr.number`: PR number
   - `pr.url`: PR URL
   - `next_action`: "pr-iterate"
   - `current_phase`: "completed"

2. Next action:
   ```
   Skill: pr-iterate $PR_URL
   ```

## State Schema

### kickoff.json

```json
{
  "version": "1.0",
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
    "3_implement": {
      "status": "in_progress",
      "started_at": "2026-01-28T10:15:00Z"
    },
    "4_validate": { "status": "pending" },
    "5_commit": { "status": "pending" },
    "6_pr": { "status": "pending" }
  },
  "next_actions": ["Continue implementation"],
  "decisions": [],
  "config": {
    "strategy": "tdd",
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

## Subagent Delegation

| Phase | Subagent | Why |
|-------|----------|-----|
| 2 | Task(Explore) | Large codebase reads, file discovery |
| 4 | Task(quality-engineer) | Test execution, failure analysis |

Other phases run directly without subagent delegation.

## Error Handling

### Phase 1-2 Failures

```bash
~/.claude/skills/dev-kickoff/scripts/update-phase.sh $PHASE failed \
  --error "Error message" \
  --worktree $PATH
```

Action: Abort workflow, report error.

### Phase 3 Failures

Action: Pause for intervention, save progress.

### Phase 4 Failures

1. Retry with `--fix`
2. If still failing, pause
3. Report specific test failures

### Phase 5-6 Failures

Action: Report manual command to run, save state.

Manual recovery:
```bash
# Phase 5
git add -A && git commit -m "feat: ..."

# Phase 6
gh pr create --title "..." --body "..."
```

## Recovery Commands

Check current state:
```bash
~/.claude/skills/dev-kickoff/scripts/next-action.sh --worktree $PATH
```

Resume from current phase:
```bash
# Read next_action from output and execute
```
