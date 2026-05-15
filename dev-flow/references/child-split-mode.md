# Dev Flow - Child-Split Mode

Parent issue → child issues + integration branch + batch loop + integration PR.

Use when the parent issue is decomposable into multiple PRs that can land
independently (typically driven by an explicit "実装順序" table or layered
linear DAG dependencies).

## Step Overview

| Step | Action | Complete When |
|------|--------|---------------|
| 1 | `Skill: dev-issue-analyze` | parent requirements captured |
| 2 | `Skill: dev-decompose --child-split` | flow.json v2 + integration branch + child issues |
| 3 | `run-batch-loop.sh` | all child PRs merged into integration branch |
| 4 | `Skill: dev-integrate` (v2) | type check + dev-validate pass |
| 5 | `Skill: git-pr` | final non-draft integration PR created |
| 6 | `Skill: pr-iterate` | LGTM or max iterations |

## Step 1: Issue Analysis

```bash
Skill: dev-issue-analyze $PARENT --depth $DEPTH
```

## Step 2: Decompose

```bash
WORKTREE_BASE="$HOME/ghq/.../skills-worktrees/feature-issue-${PARENT}"
mkdir -p "$WORKTREE_BASE/.claude"
FLOW_STATE="$WORKTREE_BASE/.claude/flow.json"

Skill: dev-decompose $PARENT --child-split \
  --base $BASE \
  --flow-state $FLOW_STATE
```

Output checks:
- `integration_branch.name` exists in `git branch --list`
- `children[]` count <= `max_child_issues_hard` (12)
- All children are real GitHub issues (`gh issue view`)

## Step 3: Batch Loop

```bash
INTEGRATION_BRANCH=$(jq -r '.integration_branch.name' $FLOW_STATE)
BATCHES_JSON=$(mktemp)
jq '.batches' $FLOW_STATE > $BATCHES_JSON

$SKILLS_DIR/_shared/scripts/run-batch-loop.sh \
  --batches-json $BATCHES_JSON \
  --issue-runner "Skill: dev-flow {issue} --force-single --base $INTEGRATION_BRANCH --lang ja" \
  --on-success "$SKILLS_DIR/dev-flow/scripts/auto-merge-child.sh {issue} --base $INTEGRATION_BRANCH --flow-state $FLOW_STATE" \
  --state-file $WORKTREE_BASE/.claude/batch-state.json
```

### Per-child execution flow

For each child issue:

1. `Skill: dev-flow <child> --force-single --base integration/issue-N-slug --lang ja`
   - This spawns dev-kickoff which creates a worktree, implements, and opens a **draft** child PR
   - The child PR base is the integration branch (NOT main/dev)
2. `auto-merge-child.sh <child>` runs:
   - `auto-merge-guard.sh --pr <child-pr>` → confirms base is `integration/issue-*` (allowed)
   - `gh pr merge <child-pr> --merge --admin --delete-branch`
   - `flow-update.sh child <child> --status completed --merged-at $NOW`

### Failure handling

If a child fails:
- `run-batch-loop.sh` records the failure but **continues with remaining batches if downstream batches don't depend on the failed one** (caller decides via `--on-failure`)
- Default behavior: log failure, continue. Operator reviews `batch-state.json` after the run.

For now, **fail-fast** is the default; downstream batches are not entered if the previous batch had any failure (caller passes `--on-failure "exit 1"` if strict mode is desired).

## Step 4: Integration Validation

After all children are merged into the integration branch, run dev-integrate:

```bash
Skill: dev-integrate --flow-state $FLOW_STATE
```

dev-integrate (v2) does:
- Verify all `flow.json.children[].status == "completed"`
- Check out the integration branch
- Run type check (tsc / mypy / go vet by stack detection)
- Run `dev-validate --worktree $INTEGRATION_WORKTREE`
- Update `flow.json.status = integrated`

No Kahn-sort, no merge-subtask logic — children are already merged.

## Step 5: Final Integration PR

```bash
Skill: git-pr $PARENT --base $BASE --lang ja --worktree $INTEGRATION_WORKTREE
```

This is a **non-draft** PR (final review by humans). All the child PR
diffs are already on the integration branch, so this final PR's diff
equals the cumulative child changes.

## Step 6: pr-iterate

```bash
Task: pr-iterate $FINAL_PR_URL --max-iterations $MAX
```

## Child PR draft flag

Child PRs are created with `--draft` to suppress CI on the
`integration/issue-*` base. The final integration PR (Step 5) is
non-draft to trigger full CI on the `dev` / `main` base.

Configure your CI to skip `draft: true` PRs or `base: integration/**`
PRs — see [`docs/ci-skip-recipe.md`](../../docs/ci-skip-recipe.md).

## Recovery

If interrupted mid-loop:

```bash
# Resume from batch N
$SKILLS_DIR/_shared/scripts/run-batch-loop.sh \
  --batches-json $BATCHES_JSON \
  --issue-runner "..." \
  --batch-from $N \
  --state-file $WORKTREE_BASE/.claude/batch-state.json
```

`flow-update.sh child <issue> --status running` is set per-child, so
re-runs see which children are already completed.

## Why this design

- DAG (depends_on) was replaced by linear batches; ~90% of workflows fit
- Integration branch absorbs cross-PR conflicts incrementally (vs N-way
  merge at the end with subtask DAG)
- Child PRs against integration branch are draft, suppressing N×CI runs
- Final integration PR triggers full CI exactly once

See parent issue #93 for the full rationale.
