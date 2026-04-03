# Parallel Subtask Mode

When `--task-id` is specified, dev-kickoff runs in parallel subtask mode (see Phase table "Parallel Mode" column in SKILL.md).

## Reading Subtask Scope

The subtask scope is read from flow.json:

```bash
$SKILLS_DIR/_lib/scripts/flow-read.sh --flow-state $FLOW_STATE --subtask $TASK_ID
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
