# Dev Flow - Workflow Details

Detailed documentation for the dev-flow skill workflow.

## Architecture

### Single Mode (Default)

dev-kickoff and pr-iterate run as Task subagents with independent contexts.
The main dev-flow context stays lightweight (instruction + result only).

```
dev-flow (main context - lightweight)
    │
    ├─→ Step 1: Task subagent → dev-kickoff (independent context)
    │       ├─→ Phase 1: git-prepare.sh (worktree)
    │       ├─→ Phase 2: dev-issue-analyze (exploration)
    │       ├─→ Phase 3: dev-implement (coding)
    │       ├─→ Phase 4: dev-validate (testing)
    │       ├─→ Phase 5: git-commit (commit)
    │       ├─→ Phase 6: git-pr (PR creation)
    │       └── Returns: {status, worktree, pr_url, pr_number}
    │
    ├─→ Step 2: Get PR URL (main context)
    │       └─→ gh pr view --json url --jq .url
    │
    └─→ Step 3: Task subagent → pr-iterate (independent context)
            ├─→ Review → Fix → Push → Repeat
            └── Returns: {status, iterations}
```

### Parallel Mode (--parallel)

```
dev-flow (orchestrator)
    │
    ├─→ Step 1: dev-issue-analyze (comprehensive)
    │
    ├─→ Step 2: dev-decompose
    │       ├─→ Identify affected files
    │       ├─→ Build dependency graph
    │       ├─→ Split into subtasks (file boundary)
    │       ├─→ Generate shared contract (interfaces/types)
    │       ├─→ Create contract branch + commit
    │       ├─→ Create N worktrees (git-prepare x N)
    │       └─→ Generate flow.json
    │
    ├─→ Step 3: Check decomposition
    │       └─→ subtask_count == 1 → fallback to single mode
    │
    ├─→ Step 4: Batch scheduling (depends_on graph)
    │       ├─→ Batch 1: [task1, task3] (independent) ── parallel
    │       │       ├─→ dev-kickoff --task-id task1 (Phase 3-5 only)
    │       │       └─→ dev-kickoff --task-id task3 (Phase 3-5 only)
    │       └─→ Batch 2: [task2] (depends on task1) ── after batch 1
    │               └─→ dev-kickoff --task-id task2 (Phase 3-5 only)
    │
    ├─→ Step 5: Aggregate results
    │       └─→ Read kickoff.json → update flow.json (actual_files_changed)
    │
    ├─→ Step 6: dev-integrate
    │       ├─→ Check drift (planned vs actual files)
    │       ├─→ Merge subtask branches (topological order)
    │       ├─→ Type check (tsc/mypy/go vet)
    │       └─→ dev-validate (integration tests)
    │
    ├─→ Step 7: git-pr (from merge worktree)
    │
    └─→ Step 8: pr-iterate (review loop)
```

## State Flow

### State Files

| File | Location | Mode | Purpose |
|------|----------|------|---------|
| kickoff.json | `$WORKTREE/.claude/kickoff.json` | Single | Phase tracking, PR info |
| iterate.json | `$WORKTREE/.claude/iterate.json` | Both | Iteration count, review status |
| flow.json | `$WORKTREE_BASE/.claude/flow.json` | Parallel | Overall flow state, subtask tracking |
| kickoff.json (N) | `$SUBTASK_WT/.claude/kickoff.json` | Parallel | Per-subtask phase state |

### Single Mode Phase Progression

```
1_prepare → 2_analyze → 3_implement → 4_validate → 5_commit → 6_pr → completed
```

### Parallel Mode Status Progression

```
analyzing → decomposing → implementing → integrating → pr → iterating → completed
```

## Single Mode Details

### Step 1: dev-kickoff (Task Subagent)

dev-kickoff runs as a Task subagent with its own independent context. The main dev-flow context only holds the Task invocation prompt and the returned result JSON. This prevents dev-kickoff's internal turns (up to 50) from accumulating in the main context.

The orchestrator handles 6 phases internally. See [dev-kickoff/SKILL.md](../../dev-kickoff/SKILL.md).

#### Task Invocation

The Task tool is used to spawn a subagent that executes `Skill: dev-kickoff`. The subagent returns a structured JSON result containing the worktree path and PR information.

#### Completion Signal

When Phase 6 (PR creation) completes, kickoff.json is updated with:
- `pr.number`: PR number
- `pr.url`: Full PR URL
- `next_action`: "pr-iterate"
- `current_phase`: "completed"

The subagent returns: `{"status": "completed", "worktree": "<path>", "pr_url": "<url>", "pr_number": <number>}`

#### Error Signal

On failure, the subagent returns: `{"status": "failed", "error": "<message>", "phase": "<failed_phase>"}`

### Step 2: Get PR URL

```bash
# Run from worktree returned by Step 1 subagent
cd $WORKTREE && gh pr view --json url --jq .url
```

### Step 3: pr-iterate (Task Subagent)

pr-iterate runs as a Task subagent with its own independent context. This prevents the review-fix loop iterations from accumulating in the main dev-flow context.

Handles the review-fix-push loop. See [pr-iterate/SKILL.md](../../pr-iterate/SKILL.md).

#### Task Invocation

The Task tool is used to spawn a subagent that executes `Skill: pr-iterate`. The subagent returns a structured JSON result containing the final status and iteration count.

#### Result Signal

- LGTM: `{"status": "lgtm", "iterations": <count>}`
- Max reached: `{"status": "max_reached", "iterations": <count>}`
- Failure: `{"status": "failed", "error": "<message>"}`

## Parallel Mode Details

### Step 1: Issue Analysis

```
Skill: dev-issue-analyze $ISSUE --depth comprehensive
```

Produces comprehensive analysis including affected files list, used as input for decomposition.

### Step 2: Decomposition

```
Skill: dev-decompose $ISSUE --base $BASE --env-mode $ENV_MODE
```

Creates:
- Contract branch: `feature/issue-{N}-contract`
- Subtask worktrees: `feature-issue-{N}-task1`, `feature-issue-{N}-task2`, ...
- flow.json with subtask definitions

### Step 3: Fallback Check

If `subtask_count == 1`:
- Switch to single mode
- Use the single subtask worktree
- Run dev-kickoff normally

### Step 4: Parallel Execution

Launch subtasks via Task tool in dependency-ordered batches:

```
# Batch computation:
# 1. Find subtasks with empty depends_on → Batch 1
# 2. After Batch 1 completes, find subtasks whose deps are all done → Batch 2
# 3. Repeat until all subtasks scheduled

# Each subtask invocation:
Skill: dev-kickoff $ISSUE \
  --worktree $SUBTASK_WORKTREE \
  --task-id $TASK_ID \
  --flow-state $FLOW_STATE \
  --strategy $STRATEGY
```

In `--task-id` mode, dev-kickoff only executes:
- Phase 3: implement (scoped to subtask files/checklist)
- Phase 4: validate
- Phase 5: commit (+ records actual_files_changed)

### Step 5: Result Aggregation

For each completed subtask:
1. Read `actual_files_changed` from subtask's kickoff.json
2. Update flow.json via `flow-update.sh`
3. Check for failures (any subtask status == "failed" → abort)

### Step 6: Integration

```
Skill: dev-integrate --flow-state $FLOW_STATE
```

See [dev-integrate/SKILL.md](../../dev-integrate/SKILL.md).

### Step 7: PR Creation

```
Skill: git-pr $ISSUE --base $BASE --worktree $MERGE_WORKTREE
```

PR is created from the merge worktree containing all integrated changes.

### Step 8: PR Iteration

```
Skill: pr-iterate $PR_URL --max-iterations $MAX
```

Same as single mode.

## Recovery After Auto-Compact

### Single Mode Recovery

1. **Check State**
   ```bash
   $SKILLS_DIR/dev-flow/scripts/flow-status.sh --worktree $PATH
   ```
2. Follow `next_action` from output

### Parallel Mode Recovery

1. **Check flow.json**
   ```bash
   $SKILLS_DIR/_lib/scripts/flow-read.sh --flow-state $FLOW_STATE
   ```
2. Check `status` field for current stage
3. Check `subtasks[].status` for per-task progress
4. Resume from current stage

## Error Handling

| Scenario | Action |
|----------|--------|
| Phase fails in kickoff | kickoff.json records error, stops |
| Subtask fails in parallel | flow.json records, abort remaining |
| PR creation fails | Manual `gh pr create`, then update state |
| pr-iterate fails | Check iterate.json, retry or manual fix |
| Merge conflict | dev-integrate attempts auto-resolve |
| Type check fails | Report errors, attempt fix |
| State file missing | Cannot recover, start fresh |

## Debugging

### Single Mode

```bash
cat $WORKTREE/.claude/kickoff.json | jq '.'
cat $WORKTREE/.claude/kickoff.json | jq '.current_phase, .phases'
```

### Parallel Mode

```bash
# Overall status
cat $FLOW_STATE | jq '{status, subtasks: [.subtasks[] | {id, status}]}'

# Specific subtask
cat $FLOW_STATE | jq '.subtasks[] | select(.id == "task1")'

# Integration results
cat $FLOW_STATE | jq '.integration'

# Per-subtask kickoff state
cat $SUBTASK_WT/.claude/kickoff.json | jq '.current_phase'
```

## Integration Points

### With dev-kickoff
- Single mode: dev-flow launches dev-kickoff as Task subagent (independent context)
- Parallel mode: dev-flow launches multiple dev-kickoff instances via Task tool
- kickoff.json is the per-task handoff point
- In single mode, the Task subagent returns `{status, worktree, pr_url, pr_number}` to dev-flow

### With dev-decompose
- dev-flow calls dev-decompose after issue analysis
- flow.json is the handoff point (contains subtask definitions)

### With dev-integrate
- dev-flow calls dev-integrate after all subtasks complete
- flow.json is used for merge order and drift detection
- Merge worktree is the output

### With pr-iterate
- Single mode: dev-flow launches pr-iterate as Task subagent (independent context)
- Parallel mode: dev-flow extracts PR URL from flow.json, passes to pr-iterate (Skill call)
- pr-iterate creates its own iterate.json
- In single mode, the Task subagent returns `{status, iterations}` to dev-flow

### With GitHub CLI
- `gh pr view` for PR status
- `gh pr checks` for CI status
- `gh pr merge` - User performs manually after LGTM
