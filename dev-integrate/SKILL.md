---
name: dev-integrate
description: |
  Merge parallel subtask branches, resolve conflicts, run type checks and integration tests.
  Use when: (1) merging parallel subtask results, (2) post-implementation integration,
  (3) keywords: integrate, merge subtasks, consolidate branches
  Accepts args: [--flow-state <path>] [--base <branch>]
allowed-tools:
  - Bash
  - Task
---

# Dev Integrate

Merge parallel subtask branches, resolve conflicts, run type checks and integration tests.

## Responsibilities

- Read flow.json and verify all subtasks completed
- Detect planned vs actual file changes (actual_files_changed vs files)
- Create merge worktree (git-prepare --suffix merge)
- Merge each subtask branch in dependency order (leaves first)
- Detect and attempt auto-resolution of conflicts
- Run type checking (tsc --noEmit, mypy, etc.)
- Run integration tests via dev-validate
- Update flow.json integration section

## Workflow

```
1. Read flow.json, verify all subtasks status == "completed"
2. Warn if actual_files_changed differs from planned files
3. Determine merge order from depends_on (topological sort, leaves first)
4. Create merge worktree via git-prepare --suffix merge --base $CONTRACT_BRANCH
5. For each subtask in order:
   a. git merge --no-ff $TASK_BRANCH
   b. If conflict: attempt auto-resolution, record in flow.json
   c. If unresolvable: stop and request user intervention
6. Run type check (detect project type: tsc for TS, mypy for Python, etc.)
7. Run Skill: dev-validate --worktree $MERGE_WORKTREE
8. Update flow.json integration section with results
```

## Execution

### Step 1: Verify Subtask Completion

```bash
~/.claude/skills/_lib/scripts/flow-read.sh --flow-state $FLOW_STATE \
  --field '.subtasks[] | select(.status != "completed") | .id'
```

If any subtask is not completed, abort and report which subtasks are pending.

### Step 2: Detect File Change Drift

```bash
~/.claude/skills/dev-integrate/scripts/check-drift.sh --flow-state $FLOW_STATE
```

Warn on differences between planned and actual files changed. Do not abort on drift --
it is informational only.

### Step 3: Determine Merge Order

Use topological sort based on `depends_on` fields. Independent subtasks (no dependencies)
are merged first, followed by subtasks that depend on them.

### Step 4: Create Merge Worktree

```bash
~/.claude/skills/git-prepare/scripts/git-prepare.sh $ISSUE --suffix merge --base $BASE
```

### Step 5: Merge Subtask Branches

```bash
~/.claude/skills/dev-integrate/scripts/merge-subtasks.sh \
  --flow-state $FLOW_STATE --worktree $MERGE_WORKTREE
```

### Step 6: Type Check

Detect project type and run appropriate type checker:

```bash
# Detect project type:
if [ -f "tsconfig.json" ]; then npx tsc --noEmit
elif [ -f "setup.py" ] || [ -f "pyproject.toml" ]; then mypy .
elif [ -f "go.mod" ]; then go vet ./...
fi
```

### Step 7: Integration Validation

```
Skill: dev-validate --worktree $MERGE_WORKTREE
```

### Step 8: Update Flow State

```bash
~/.claude/skills/_lib/scripts/flow-update.sh --flow-state $FLOW_STATE \
  integration --field status --value "integrated"
~/.claude/skills/_lib/scripts/flow-update.sh --flow-state $FLOW_STATE \
  integration --field merge_worktree --value "$MERGE_WORKTREE"
~/.claude/skills/_lib/scripts/flow-update.sh --flow-state $FLOW_STATE \
  integration --field type_check --value "passed"
~/.claude/skills/_lib/scripts/flow-update.sh --flow-state $FLOW_STATE \
  integration --field validation --value "passed"
```

## Merge Order

Topological sort: independent subtasks first, then dependents. See [Integration Guide](references/integration-guide.md) for details.

## Error Handling

| Scenario | Action |
|----------|--------|
| Subtask not completed | Abort, report pending subtasks |
| Unresolvable merge conflict | **Stop, request user intervention** |
| Type check / test fails | Report, attempt fix with --fix |

See [Integration Guide](references/integration-guide.md) for conflict resolution patterns and recovery procedures.

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `--flow-state` | auto | Path to flow.json |
| `--base` | from flow.json | Base branch for merge worktree |

## Output

Updates flow.json integration section.

Returns:
```json
{"status": "integrated|failed", "merge_worktree": "/path", "type_check": "passed|failed", "validation": "passed|failed"}
```
