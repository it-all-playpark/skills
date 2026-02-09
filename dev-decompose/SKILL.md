---
name: dev-decompose
description: |
  Decompose large issues into parallel subtasks with file-boundary isolation.
  Creates contract branch, worktrees, and flow.json for parallel dev-kickoff execution.
  Use when: (1) large issues need parallel implementation, (2) file-boundary decomposition,
  (3) keywords: decompose, split, parallel, subtasks
  Accepts args: <issue-number> [--base <branch>] [--env-mode hardlink|symlink|copy|none] [--flow-state <path>]
allowed-tools:
  - Bash
  - Task
---

# Dev Decompose

Decompose large issues into parallel subtasks with file-boundary isolation. Creates a contract branch, per-task worktrees, and a flow.json manifest for parallel dev-kickoff execution.

## Responsibilities

- Receive issue analysis results (from dev-issue-analyze or issue body)
- Identify affected files and build a file dependency graph
- Split work into non-conflicting subtasks at file boundaries
- Define `depends_on` relationships between subtasks
- Generate shared contract (types/interfaces) committed to a contract branch
- Create N worktrees via git-prepare (base: contract branch, suffix: task1, task2, ...)
- Generate flow.json with subtask definitions, checklists, and contract info

## Workflow

```
1. Read issue analysis (from dev-issue-analyze output or issue body)
2. Identify affected files and dependencies
3. Group files into subtasks (no file overlap)
4. Define checklist for each subtask
5. Generate shared contract (interfaces/types if needed)
6. Create contract branch from base
7. Commit contract files to contract branch
8. Create worktrees for each subtask (git-prepare --base contract-branch --suffix taskN)
9. Generate flow.json
10. Validate decomposition (validate-decomposition.sh)
```

### Step 1-2: Analysis Intake

Read the output from `dev-issue-analyze` (comprehensive depth recommended). Extract:
- Affected files list
- Components and modules involved
- Acceptance criteria
- Breaking change indicators

Build a file dependency graph: which files import/reference which other files.

### Step 3-4: File Grouping

Partition affected files into subtasks such that:
- Each file belongs to exactly one subtask
- Test files go with their implementation subtask
- Files that are tightly coupled (mutual imports) stay together
- Each subtask has at least 1 checklist item derived from acceptance criteria

### Step 5-7: Contract Generation

If subtasks share types or interfaces:
1. Extract shared types into contract files (e.g., `src/types/contract.ts`)
2. Create `feature/issue-{N}-contract` branch from base
3. Commit contract files to the contract branch
4. All task worktrees branch from this contract branch

### Step 8: Worktree Creation

For each subtask, call git-prepare:
```bash
~/.claude/skills/git-prepare/scripts/git-prepare.sh $ISSUE \
  --suffix task${INDEX} \
  --base feature/issue-${ISSUE}-contract \
  --env-mode $ENV_MODE
```

### Step 9: Flow State Generation

Initialize flow.json:
```bash
~/.claude/skills/dev-decompose/scripts/init-flow.sh $ISSUE \
  --flow-state $FLOW_STATE \
  --base $BASE \
  --env-mode $ENV_MODE
```

Then populate subtask entries with file assignments, checklists, and dependency info.

### Step 10: Validation

```bash
~/.claude/skills/_lib/scripts/validate-decomposition.sh --flow-state $FLOW_STATE
```

## Decomposition Rules

1. **File exclusivity** -- Each file belongs to exactly one subtask. No file appears in two subtasks.
2. **Test co-location** -- Test files go with their implementation subtask (e.g., `foo.test.ts` goes with `foo.ts`).
3. **Contract isolation** -- Shared types and interfaces go to the contract branch, not to individual subtasks.
4. **Parallel eligibility** -- Subtasks with no `depends_on` entries can run in parallel.
5. **Minimum granularity** -- Every subtask must have at least 1 checklist item.
6. **Tightly coupled files** -- Files with mutual imports must remain in the same subtask.

## Contract Branch Pattern

```
main --> feature/issue-{N}-contract (dev-decompose commits shared types)
  |-- feature/issue-{N}-task1 (branched from contract)
  |-- feature/issue-{N}-task2 (branched from contract)
  |-- feature/issue-{N}-task3 (branched from contract)
  +-- feature/issue-{N}-merge (integration target)
```

The contract branch holds shared interfaces and types that all subtasks depend on. Each task branch is created from the contract branch so that every subtask sees the shared definitions.

## Validation

Auto-validate the decomposition after generating flow.json:

```bash
~/.claude/skills/_lib/scripts/validate-decomposition.sh --flow-state $FLOW_STATE
```

Validation checks:
- No file appears in more than one subtask
- Every subtask has at least 1 checklist item
- All `depends_on` references point to existing subtask IDs
- Contract branch exists and has commits
- All worktree paths exist on disk

## Fallback

If decomposition results in only 1 subtask, the issue is not worth splitting. Return a single-mode fallback signal so the caller can route to a standard (non-parallel) dev-kickoff instead.

```json
{"status": "single_fallback", "subtask_count": 1, "reason": "All files are tightly coupled"}
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | GitHub issue number |
| `--base` | `main` | Base branch for contract |
| `--env-mode` | `hardlink` | Env file handling for worktrees |
| `--flow-state` | auto | Path to flow.json output location |

When `--flow-state` is `auto`, the path defaults to `$WORKTREE_BASE/.claude/flow.json` where `$WORKTREE_BASE` is the parent worktrees directory for the issue.

## Output

flow.json is created at `$WORKTREE_BASE/.claude/flow.json`.

```json
{
  "version": "1.0.0",
  "issue": 42,
  "status": "decomposed",
  "contract_branch": "feature/issue-42-contract",
  "subtasks": [
    {
      "id": "task1",
      "title": "Implement user model",
      "files": ["src/models/user.ts", "src/models/user.test.ts"],
      "checklist": ["Define User entity with required fields", "Add validation logic"],
      "depends_on": [],
      "worktree": "/path/to/worktrees/feature-issue-42-task1",
      "branch": "feature/issue-42-task1",
      "status": "pending"
    },
    {
      "id": "task2",
      "title": "Implement user API endpoints",
      "files": ["src/routes/user.ts", "src/routes/user.test.ts"],
      "checklist": ["Create GET /users endpoint", "Create POST /users endpoint"],
      "depends_on": ["task1"],
      "worktree": "/path/to/worktrees/feature-issue-42-task2",
      "branch": "feature/issue-42-task2",
      "status": "pending"
    }
  ],
  "contract": {
    "files": ["src/types/user.ts"],
    "branch": "feature/issue-42-contract"
  },
  "config": {
    "base": "main",
    "env_mode": "hardlink"
  },
  "created_at": "2026-02-09T10:00:00Z",
  "updated_at": "2026-02-09T10:00:00Z"
}
```

Return value:
```json
{"status": "decomposed|single_fallback", "subtask_count": N, "flow_state": "/path/to/flow.json"}
```

## Error Handling

| Condition | Action |
|-----------|--------|
| Issue not found | Abort with error JSON |
| No affected files identified | Abort with error JSON |
| Contract branch creation fails | Abort, clean up worktrees |
| Worktree creation fails | Abort, report which subtask failed |
| Validation fails | Report specific violations, do not proceed |

## References

- [Decomposition Guide](references/decomposition-guide.md) - Detailed strategy and edge cases
- [git-prepare](../git-prepare/SKILL.md) - Worktree creation
- [dev-issue-analyze](../dev-issue-analyze/SKILL.md) - Issue analysis input
- [dev-kickoff](../dev-kickoff/SKILL.md) - Per-subtask execution
