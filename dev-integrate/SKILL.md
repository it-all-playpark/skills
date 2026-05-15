---
name: dev-integrate
description: |
  Verify that all child PRs are merged into the integration branch, run type check and dev-validate.
  v2 (child-split mode) only. No Kahn-sort topological merge.
  Use when: (1) post-child-merge integration, (2) keywords: integrate, integration branch verify
  Accepts args: [--flow-state <path>] [--base <branch>]
allowed-tools:
  - Bash
  - Task
  - Skill
---

# Dev Integrate (v2)

Verify all children merged successfully into the integration branch, run type
check, and run `dev-validate`. Used by `dev-flow --child-split` Step 4.

**v2 design**: children are merged into the integration branch incrementally
by `dev-flow` child execution (each child PR auto-merges via
`auto-merge-child.sh`), so `dev-integrate` no longer performs N-way merge.
It only verifies and validates.

The previous v1 design (Kahn's algorithm topological merge of subtask
branches) has been **removed** (no-backcompat).

## Responsibilities

- Read flow.json v2 and verify all `children[].status == "completed"`
- Check out the integration branch into a worktree (or use cwd if it is the
  integration worktree)
- Run type check (tsc / mypy / go vet by stack detection)
- Run `Skill: dev-validate --worktree $INTEGRATION_WORKTREE`
- Update `flow.json.status = integrated` on success

## Workflow

```
1. Read flow.json v2 (reject v1)
2. Verify all children completed
3. Check out integration branch (cd into worktree)
4. Type check (best-effort by stack)
5. Run dev-validate
6. Update flow.json.status
```

## Step 1: Read flow.json

```bash
$SKILLS_DIR/_lib/scripts/flow-read.sh --flow-state $FLOW_STATE
```

Rejects with schema error if version != `2.0.0`.

## Step 2: Verify Children Completed

```bash
$SKILLS_DIR/dev-integrate/scripts/verify-children-merged.sh \
  --flow-state $FLOW_STATE
```

Returns `{status: all_complete|incomplete, incomplete_children: [...]}`.
Aborts if any child is not `completed`.

## Step 3-5: Run validation

Inside the integration worktree:

```bash
# Type check (best-effort by stack detection)
if [ -f tsconfig.json ]; then npx tsc --noEmit
elif [ -f pyproject.toml ] || [ -f setup.py ]; then mypy . || true
elif [ -f go.mod ]; then go vet ./...
fi

# Validation
Skill: dev-validate --worktree $INTEGRATION_WORKTREE
```

## Step 6: Update flow.json

```bash
$SKILLS_DIR/_lib/scripts/flow-update.sh --flow-state $FLOW_STATE status integrated
```

## Error Handling

| Scenario | Action |
|----------|--------|
| flow.json v1 schema | Abort with explicit no-backcompat error |
| Some children incomplete | Abort, list incomplete children |
| Type check fails | Report, do not mark integrated |
| dev-validate fails | Report, do not mark integrated |

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `--flow-state` | auto | Path to flow.json |
| `--base` | from flow.json | (For backward calling, unused in v2 - integration branch is in flow.json) |

## Output

Updates flow.json. Returns:

```json
{
  "status": "integrated|failed",
  "type_check": "passed|failed|skipped",
  "validation": "passed|failed"
}
```

## Journal Logging

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-integrate <success|failure> \
  --issue $ISSUE --duration-turns $TURNS [--error-category <cat> --error-msg "<msg>"]
```
