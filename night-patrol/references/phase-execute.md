# Phase 3: Execute - Detailed Steps

Update state: `phase: 3, status: "executing"`

Read `.claude/triage-results.json`.

Apply `--max-issues` limit if set (take first N issues from execution plan).

## Batch Loop

For each batch in `execution_plan.batches` (ordered by batch number):

### 1. Pre-execute guard check

```bash
$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-execute \
  --cumulative-lines $CUMULATIVE
```

If `pass: false` -> skip all remaining batches, proceed to Phase 4.

### 2. Execute batch

**Parallel batch** (`mode: "parallel"`):
Launch each issue as a Task subagent:

```
Task: dev-flow <issue-number> --base nightly/$DATE
```

Wait for all to complete.

**Serial batch** (`mode: "serial"`):
Execute each issue sequentially:

```
Skill(skill: "dev-flow", args: "<issue-number> --base nightly/$DATE")
```

### 3. Process results (per issue)

For each completed issue:
- If dev-flow returned LGTM PR -> auto-merge into `nightly/$DATE` (確認不要)
  ```bash
  gh pr merge <PR_NUMBER> --merge --admin --delete-branch
  ```
  **Note:** `--admin` bypasses confirmation. Safe because nightly branch is for autonomous patrol only.
- If max_reached or error -> record as skipped/failed
- Update `cumulative_lines_changed` in state

### 4. Post-issue guard check

After each individual issue completes, check cumulative lines:

```bash
$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-execute \
  --cumulative-lines $CUMULATIVE
```

If `pass: false` -> skip all remaining issues in current batch AND remaining batches, proceed to Phase 4.

### 5. Update state

Add result to `results[]`, update counters in `.claude/night-patrol.json`.

## After all batches

Update state: `status: "completed"`

If subcommand is `execute`, stop here.
