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

### Step 1-4: Analysis & File Grouping

Analyze issue, build file dependency graph, partition into subtasks. See [Decomposition Guide](references/decomposition-guide.md) for strategy and edge cases.

### Step 5-7: Contract Generation

Generate contract per [Decomposition Guide](references/decomposition-guide.md). Branch: `feature/issue-{N}-contract`.

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

Additionally verify manually: contract branch exists and has commits, all worktree paths exist on disk.

## Decomposition Rules

See [Decomposition Guide](references/decomposition-guide.md) for rules (file exclusivity, test co-location, contract isolation, coupling), edge cases, and examples.

## Contract Branch Pattern

```
main --> feature/issue-{N}-contract (dev-decompose commits shared types)
  |-- feature/issue-{N}-task1 (branched from contract)
  |-- feature/issue-{N}-task2 (branched from contract)
  |-- feature/issue-{N}-task3 (branched from contract)
  +-- feature/issue-{N}-merge (integration target)
```

## Fallback

If decomposition yields 1 subtask, return fallback (see [Decomposition Guide](references/decomposition-guide.md) for criteria):

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

Structure: `{ version, issue, status, subtasks[], contract, config, created_at, updated_at }`

See [flow.schema.json](../_lib/schemas/flow.schema.json) for full schema.

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
