# Parallel Subtask Mode

When `--task-id` is specified, dev-kickoff runs in parallel subtask mode (see Phase table "Parallel Mode" column in SKILL.md).

## Reading Subtask Scope

The subtask scope is read from flow.json:

```bash
$SKILLS_DIR/_lib/scripts/flow-read.sh --flow-state $FLOW_STATE --subtask $TASK_ID
```

## Reading Shared Findings (Phase 3 input)

Before dev-plan-impl writes impl-plan.md, fetch unacked cross-worker findings
and feed them into the plan context. `--ack` marks them read so subsequent
workers don't re-process them:

```bash
$SKILLS_DIR/_shared/scripts/flow-read-findings.sh \
  --flow-state $FLOW_STATE --task-id $TASK_ID --unacked-only --ack
```

See [`_shared/references/shared-findings.md`](../../_shared/references/shared-findings.md) for the full pattern.

## Appending Shared Findings (Phase 4/5)

When the worker makes a decision that affects other workers (breaking type
changes, shared API contract interpretation, repo-wide design decisions, new
dependencies), append a finding so other workers can incorporate it:

```bash
$SKILLS_DIR/_shared/scripts/flow-append-finding.sh \
  --flow-state $FLOW_STATE --task-id $TASK_ID \
  --category breaking_change \
  --title "..." --description "..." \
  --scope "src/types/user.ts"
```

## Phase 7 Enhancement

After commit, record changed files:

```bash
git diff --name-only $BASE_BRANCH...HEAD
```

Result stored in kickoff.json under `actual_files_changed` field.

## Return Value

Return value in `--task-id` mode is minimal:

```json
{"task_id": "task1", "status": "completed|failed"}
```
