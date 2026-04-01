# Dev Flow - Parallel Mode

大規模 issue 用。dry-run が `ready` を返した場合、または `--force-parallel` 指定時に使用。

## Step Overview

| Step | Action | Complete When |
|------|--------|---------------|
| 2b | `Skill: dev-decompose` (full, with `--resume` if dry-run ran) | flow.json + worktrees created |
| 3b | Check decomposition result | Verify subtask count > 1 |
| 4b | `dev-kickoff x N` (parallel) | All subtasks completed |
| 5b | Aggregate results | flow.json updated |
| 6b | `Skill: dev-integrate` | Merge + tests pass |
| 7b | `Skill: git-pr` | PR URL available |
| 8b | `Skill: pr-iterate` | LGTM or max iterations |

## Step 2b: Full Decomposition

If dry-run already ran (auto-detect path), pass its result to avoid re-analysis:
```bash
Skill: dev-decompose $ISSUE --resume $DRY_RUN_RESULT --base $BASE --env-mode $ENV_MODE
```

If `--force-parallel` (no dry-run), run full decomposition:
```bash
Skill: dev-decompose $ISSUE --base $BASE --env-mode $ENV_MODE
```

## Batch Scheduling (Step 4b)

Launch subtasks in dependency-ordered batches (independent first, then dependents). Each invocation:

```bash
Skill: dev-kickoff $ISSUE --worktree $SUBTASK_WORKTREE --task-id $TASK_ID --flow-state $FLOW_STATE --strategy $STRATEGY
```

**CRITICAL: Subtask サブエージェントには `git push` しないよう明示指示すること。**
Parallel mode では subtask ブランチはローカルのみ。リモートに push するのは最終 merge ブランチだけ（Step 7b の git-pr 時）。
サブエージェントのプロンプトに以下を含めること:
> DO NOT run `git push`. Keep all changes local. Only the final merge branch will be pushed.

## Result Aggregation (Step 5b)

For each completed subtask, read kickoff.json and update flow.json:

```bash
CHANGED=$(jq -r '.actual_files_changed // [] | join(",")' $SUBTASK_WORKTREE/.claude/kickoff.json)
$SKILLS_DIR/_lib/scripts/flow-update.sh --flow-state $FLOW_STATE \
  subtask $TASK_ID --status completed --files-changed "$CHANGED"
```
