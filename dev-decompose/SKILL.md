---
name: dev-decompose
description: |
  Decompose a parent issue into child GitHub issues + integration branch + batch flow.json.
  Use when: (1) large issue needs multi-PR coordination, (2) child-split mode for dev-flow,
  (3) keywords: decompose, child-split, child issue, integration branch
  Accepts args: <issue-number> --child-split [--base <branch>] [--flow-state <path>] [--dry-run]
allowed-tools:
  - Bash
  - Task
model: opus
effort: max
---

# Dev Decompose

Decompose a parent GitHub issue into:
1. **Child issues** (created via `gh issue create`)
2. **Integration branch** (`integration/issue-{N}-{slug}`)
3. **Batch flow.json** (v2 schema, serial / parallel batches)

Used by `dev-flow --child-split` to drive multi-PR coordination through `run-batch-loop.sh`.

## Responsibilities

- Read parent issue body / analysis (from `dev-issue-analyze`)
- Propose a child split (2-12 children, max enforced by `skill-config.json`)
- Generate `gh issue create` plan + batches array
- Create integration branch via `_lib/scripts/integration-branch.sh`
- Initialize v2 flow.json via `init-flow-v2.sh`
- Validate the result via `_lib/scripts/validate-decomposition.sh`

## Workflow

```
1. Read parent issue analysis
2. Propose child-split plan (LLM)
   - 1 commit = 1 child issue if the parent body has an explicit 実装順序 section
   - Otherwise group by file boundary / responsibility
3. Apply max_child_issues limits (soft: 8, hard: 12)
4. Create integration branch (integration-branch.sh create)
5. Create child issues (create-child-issues.sh)
6. Compose batches (run-batch-loop friendly format)
7. Write flow.json v2 (init-flow-v2.sh --children-json --batches-json)
8. Validate (validate-decomposition.sh)
```

### Step 1-3: Plan Generation

LLM reads the parent issue and produces a **plan JSON**:

```json
{
  "integration_branch_slug": "dag-to-batch",
  "children": [
    {
      "slug": "run-batch-loop",
      "title": "feat(_shared): run-batch-loop.sh を新設",
      "scope": "Extract night-patrol Phase 3 batch loop into _shared",
      "body": "## Context\n...\n\n## Tasks\n- ...",
      "labels": ["enhancement"]
    },
    ...
  ],
  "batches": [
    {"batch": 1, "mode": "serial",   "children_slug": ["run-batch-loop"]},
    {"batch": 2, "mode": "parallel", "children_slug": ["auto-merge-guard", "integration-branch"]}
  ]
}
```

`batches[].children_slug` is reconciled to `children[]` issue numbers after Step 5.

### Step 4: Create Integration Branch

```bash
$SKILLS_DIR/_lib/scripts/integration-branch.sh create \
  --issue $PARENT \
  --slug "$INTEGRATION_SLUG" \
  --base "$BASE_BRANCH"
```

Output: `{status: created|exists, branch: "integration/issue-N-slug", ...}`

### Step 5: Create Child Issues

```bash
$SKILLS_DIR/dev-decompose/scripts/create-child-issues.sh \
  --parent $PARENT --plan "$PLAN_PATH" \
  [--dry-run]
```

Output: `children[]` with `issue` numbers populated.

`max_child_issues_hard` (12) violates abort. `max_child_issues_soft` (8) emits a warning.

### Step 6-7: Initialize flow.json

Resolve `batches[].children_slug` → `batches[].children` (issue numbers), write to files, and call:

```bash
$SKILLS_DIR/dev-decompose/scripts/init-flow-v2.sh $PARENT \
  --flow-state "$FLOW_STATE" \
  --integration-branch "$INTEGRATION_BRANCH" \
  --integration-base "$BASE_BRANCH" \
  --children-json "$CHILDREN_JSON" \
  --batches-json "$BATCHES_JSON"
```

### Step 8: Validate

```bash
$SKILLS_DIR/_lib/scripts/validate-decomposition.sh --flow-state "$FLOW_STATE"
```

Validation enforces:
- schema version `2.0.0` (v1 schema rejected — no-backcompat)
- batches 1-indexed and contiguous
- children unique per batch
- max_child_issues_hard
- `integration_branch.name` pattern

## Dry-Run Mode (`--dry-run`)

Skips actual `gh issue create` and integration branch creation. Returns the plan JSON only.

```json
{
  "status": "dry-run",
  "parent": 93,
  "proposed_children": [...],
  "proposed_batches": [...],
  "warnings": []
}
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | Parent GitHub issue number |
| `--child-split` | (mode) | Required mode flag (v2 only; explicit) |
| `--base` | `dev` | Base branch for integration branch |
| `--flow-state` | auto | Output path for flow.json |
| `--dry-run` | false | Plan only, no side effects |

`auto-detect dry-run` (v1 fallback) is **removed**. Callers must explicitly choose `--force-single` (in `dev-flow`) or `--child-split` (here).

## Config

`skill-config.json`:

```json
{
  "dev-decompose": {
    "max_child_issues_soft": 8,
    "max_child_issues_hard": 12
  }
}
```

## Output

flow.json (v2 schema). Return value:

```json
{
  "status": "decomposed|dry-run|failed",
  "parent": 93,
  "child_count": N,
  "integration_branch": "integration/issue-93-slug",
  "flow_state": "/path/to/flow.json"
}
```

## Error Handling

| Condition | Action |
|-----------|--------|
| Parent issue not found | Abort with error JSON |
| Child plan empty | Abort with error JSON |
| Child count > hard limit | Abort with explicit `max_child_issues_hard` error |
| Integration branch creation fails | Abort |
| `gh issue create` fails | Abort and surface gh error |
| Validation fails | Report errors, do not return success |

## Journal Logging

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-decompose <success|failure> \
  --issue $ISSUE --duration-turns $TURNS [--error-category <cat> --error-msg "<msg>"]
```

## References

- [Decomposition Guide](references/decomposition-guide.md) - When to split, batch design heuristics, examples
- [integration-branch.sh](../_lib/scripts/integration-branch.sh) - Integration branch helper
- [run-batch-loop.sh](../_shared/scripts/run-batch-loop.sh) - Used by dev-flow to consume the batches array
- [flow.schema.json](../_lib/schemas/flow.schema.json) - v2 schema
- [dev-flow](../dev-flow/SKILL.md) - Consumer of decompose output (`--child-split` mode)
