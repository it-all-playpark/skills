---
name: dev-decompose
description: |
  Decompose large issues into parallel subtasks with file-boundary isolation.
  Creates contract branch, worktrees, and flow.json for parallel dev-kickoff execution.
  Use when: (1) large issues need parallel implementation, (2) file-boundary decomposition,
  (3) keywords: decompose, split, parallel, subtasks
  Accepts args: <issue-number> [--base <branch>] [--env-mode hardlink|symlink|copy|none] [--flow-state <path>] [--dry-run]
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

### Full Execution (default)

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

### Dry-Run Mode (`--dry-run`)

Lightweight mode that executes only Steps 1-4 (analysis and file grouping) without creating branches, worktrees, or flow.json. Used by dev-flow for auto-detect mode selection.

```
1. Read issue analysis (from dev-issue-analyze output or issue body)
2. Identify affected files and dependencies
2b. Read past integration feedback via analyze-past-conflicts.sh
    (files + directory prefixes that recurred in previous conflicts)
3. Group files into subtasks (no file overlap), biasing files flagged by
   step 2b toward the same subtask when possible
4. Apply fallback criteria (see Decomposition Guide)
→ Return assessment JSON (no side effects). The dry-run JSON includes a
  `past_conflict_hints` field with the analyzer output for observability.
```

**Reading past feedback**:

```bash
$SKILLS_DIR/dev-decompose/scripts/analyze-past-conflicts.sh \
  --affected-files "src/types/user.ts,src/api/auth.ts,..." \
  --limit 50 --min-occurrences 2
```

Output shape (informational, decomposer LLM makes the final call):

```jsonc
{
  "has_hints": true,
  "scanned_events": 42,
  "recurring_files": [
    {"file": "src/types/user.ts", "occurrences": 3,
     "lessons": ["同じ types/ 配下は 1 subtask にまとめるべき"]}
  ],
  "recurring_prefixes": [
    {"prefix": "src/types", "occurrences": 4}
  ]
}
```

See [`_shared/references/integration-feedback.md`](../_shared/references/integration-feedback.md)
for the pub/sub pattern and how events are written by `dev-integrate`.

Dry-run output:
```json
// single_fallback
{"status": "single_fallback", "reason": "Fewer than 4 affected files", "file_count": 2}

// ready for parallel
{"status": "ready", "subtask_count": 3, "file_groups": [
  {"id": "task1", "files": ["src/models/user.ts", "src/models/user.test.ts"]},
  {"id": "task2", "files": ["src/routes/auth.ts", "src/middleware/jwt.ts"]}
]}
```

To continue from dry-run to full execution, pass the dry-run result path:
```bash
Skill: dev-decompose $ISSUE --resume /path/to/dry-run-result.json --base $BASE
```

### Step 1-4: Analysis & File Grouping

Analyze issue, build file dependency graph, partition into subtasks. See [Decomposition Guide](references/decomposition-guide.md) for strategy and edge cases.

### Step 5-7: Contract Generation

Generate contract per [Decomposition Guide](references/decomposition-guide.md). Branch: `feature/issue-{N}-contract`.

**IMPORTANT: Contract branch は worktree で作成すること。メインリポジトリで直接 checkout しない。**

```bash
# Step 6: contract worktree 作成（--local でリモート push を防止）
$SKILLS_DIR/git-prepare/scripts/git-prepare.sh $ISSUE \
  --suffix contract \
  --base $BASE \
  --env-mode $ENV_MODE \
  --local

# Step 7: contract worktree 内でファイル作成・コミット
cd $CONTRACT_WORKTREE
# ... create contract files, git add, git commit ...
```

### Step 8: Worktree Creation

For each subtask, call git-prepare with `--local` to keep branches local:
```bash
$SKILLS_DIR/git-prepare/scripts/git-prepare.sh $ISSUE \
  --suffix task${INDEX} \
  --base feature/issue-${ISSUE}-contract \
  --env-mode $ENV_MODE \
  --local
```

**Subtask/contract ブランチはリモートに push しない。** push が必要なのは最終的な merge ブランチのみ（PR 作成時）。

### Step 9: Flow State Generation

Initialize flow.json:
```bash
$SKILLS_DIR/dev-decompose/scripts/init-flow.sh $ISSUE \
  --flow-state $FLOW_STATE \
  --base $BASE \
  --env-mode $ENV_MODE
```

Then populate subtask entries with file assignments, checklists, and dependency info.

### Step 10: Validation

```bash
$SKILLS_DIR/_lib/scripts/validate-decomposition.sh --flow-state $FLOW_STATE
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
| `--dry-run` | false | Run Steps 1-4 only (analysis + grouping), no side effects |
| `--resume` | - | Path to dry-run result JSON, skip Steps 1-4 and continue from Step 5 |

When `--flow-state` is `auto`, the path defaults to `$WORKTREE_BASE/.claude/flow.json` where `$WORKTREE_BASE` is the parent worktrees directory for the issue.

## Output

### Full Execution

flow.json is created at `$WORKTREE_BASE/.claude/flow.json`.

Structure: `{ version, issue, status, subtasks[], contract, config, created_at, updated_at }`

See [flow.schema.json](../_lib/schemas/flow.schema.json) for full schema.

Return value:
```json
{"status": "decomposed|single_fallback", "subtask_count": N, "flow_state": "/path/to/flow.json"}
```

### Dry-Run

No files created on disk. Return value only:
```json
// Ready for parallel
{
  "status": "ready",
  "subtask_count": N,
  "file_groups": [{"id": "taskN", "files": ["..."]}],
  "past_conflict_hints": {
    "has_hints": true,
    "scanned_events": 42,
    "recurring_files": [{"file": "src/types/user.ts", "occurrences": 3, "lessons": ["..."]}],
    "recurring_prefixes": [{"prefix": "src/types", "occurrences": 4}]
  }
}

// Fallback to single
{"status": "single_fallback", "reason": "<criteria from Decomposition Guide>", "file_count": N, "past_conflict_hints": {...}}
```

`past_conflict_hints` is populated by
`dev-decompose/scripts/analyze-past-conflicts.sh` reading
`_shared/integration-feedback.json`. If the feedback file is missing or
empty, the field has `{"has_hints": false, ...}` and decomposition proceeds
normally.

## Error Handling

| Condition | Action |
|-----------|--------|
| Issue not found | Abort with error JSON |
| No affected files identified | Abort with error JSON |
| Contract branch creation fails | Abort, clean up worktrees |
| Worktree creation fails | Abort, report which subtask failed |
| Validation fails | Report specific violations, do not proceed |

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success (flow.json created)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-decompose success \
  --issue $ISSUE --duration-turns $TURNS

# On single_fallback (dry-run determined single mode)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-decompose success \
  --issue $ISSUE --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-decompose failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>"
```

## References

- [Decomposition Guide](references/decomposition-guide.md) - Detailed strategy and edge cases
- [git-prepare](../git-prepare/SKILL.md) - Worktree creation
- [dev-issue-analyze](../dev-issue-analyze/SKILL.md) - Issue analysis input
- [dev-kickoff](../dev-kickoff/SKILL.md) - Per-subtask execution
