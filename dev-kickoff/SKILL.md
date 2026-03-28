---
name: dev-kickoff
description: |
  End-to-end feature development orchestrator using git worktree. Coordinates git-prepare, issue-analyze, implement, validate, commit, and create-pr skills.
  Use when: starting new feature development from GitHub issue, full development cycle automation with isolated worktree.
  Accepts args: <issue-number> [--testing tdd|bdd] [--design ddd] [--depth minimal|standard|comprehensive] [--base <branch>] [--lang ja|en] [--env-mode hardlink|symlink|copy|none] [--worktree <path>] [--task-id <id>] [--flow-state <path>]
allowed-tools:
  - Bash
  - TodoWrite
  - Skill
  - Task
---

# Kickoff

Orchestrate complete feature development cycle from issue to PR.

## 言語ルール

**`--lang ja`（デフォルト）の場合、PR本文・GitHubコメントは必ず日本語で記述すること。**
- Phase 8（git-pr）で作成するPR body は日本語
- 技術用語・コード識別子・ファイルパスはそのまま

## CRITICAL: Complete All 8 Phases

**DO NOT EXIT until Phase 8 (PR creation) completes and pr-iterate is called.**

**CRITICAL: Phase 1 (Worktree) is MANDATORY unless `--task-id` is specified.**
When `--task-id` is NOT set (= single mode), Phase 1 MUST be executed FIRST. Implementation in the main repository directory is NEVER allowed.

| Phase | Action | Complete When | Single Mode | Parallel Mode (--task-id) |
|-------|--------|---------------|-------------|---------------------------|
| 1 | Worktree creation | Path exists, .env verified | **REQUIRED** | SKIP |
| 2 | Issue analysis | Requirements understood | **REQUIRED** | SKIP |
| 3 | Implementation plan | impl-plan.md created | Execute | Execute |
| 4 | Implementation | Code written | Execute | Execute |
| 5 | Validation | Tests pass | Execute | Execute |
| 6 | Evaluation | Quality gate passed | Execute | Execute |
| 7 | Commit | Changes committed | Execute | Execute |
| 8 | PR creation | PR URL available | Execute | SKIP |

After Phase 8: Call `Skill: pr-iterate $PR_URL` to complete the workflow.

## Phase Checklist

```
[ ] Phase 1: git-prepare.sh → init-kickoff.sh          (REQUIRED unless --task-id)
[ ] Phase 2: Skill: dev-issue-analyze                   (REQUIRED unless --task-id)
[ ] Phase 3: Skill: dev-plan-impl                       (NEW - Opus planner)
[ ] Phase 4: Skill: dev-implement                       (Sonnet generator)
[ ] Phase 5: Skill: dev-validate --fix
[ ] Phase 6: Skill: dev-evaluate                        (NEW - Opus evaluator, context:fork)
  → fail + design feedback → back to Phase 3
  → fail + implementation feedback → back to Phase 4
  → pass or max iterations (5) → Phase 7
[ ] Phase 7: Skill: git-commit --all
[ ] Phase 8: Skill: git-pr → pr-iterate                 (REQUIRED unless --task-id)
```

## State Management

State persisted in `$WORKTREE/.claude/kickoff.json` for recovery.

### Initialize (After Phase 1)

```bash
$SKILLS_DIR/dev-kickoff/scripts/init-kickoff.sh $ISSUE $BRANCH $WORKTREE \
  --base $BASE --testing $TESTING --design $DESIGN --depth $DEPTH --lang $LANG --env-mode $ENV_MODE
```

### Update Phase Status

```bash
# Start phase
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh <phase> in_progress --worktree $PATH

# Complete phase
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh <phase> done --result "Summary" --worktree $PATH

# After PR creation (Phase 8)
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 8_pr done \
  --result "PR created" --pr-number 123 --pr-url "URL" --worktree $PATH
```

## Phase Execution

| Phase | Command | Subagent | Parallel Mode |
|-------|---------|----------|---------------|
| 1 | `$SKILLS_DIR/git-prepare/scripts/git-prepare.sh $ISSUE --base $BASE --env-mode $ENV_MODE` | - | SKIP |
| 1b | `$SKILLS_DIR/dev-kickoff/scripts/init-kickoff.sh ...` | - | SKIP |
| 2 | `Skill: dev-issue-analyze $ISSUE --depth $DEPTH` | Task(Explore) | SKIP |
| 3 | `Skill: dev-plan-impl $ISSUE --worktree $PATH` | - | Execute |
| 4 | `Skill: dev-implement --testing $TESTING [--design $DESIGN] --worktree $PATH` | - | Execute |
| 5 | `Skill: dev-validate --fix --worktree $PATH` | Task(quality-engineer) | Execute |
| 6 | `Skill: dev-evaluate $ISSUE --worktree $PATH` | context:fork | Execute |
| 7 | `Skill: git-commit --all --worktree $PATH` | - | Execute |
| 8 | `Skill: git-pr $ISSUE --base $BASE --lang $LANG --worktree $PATH` | - | SKIP |

Phase 1: Must execute script. Direct `git worktree add` is prohibited.

## Evaluate-Retry Loop

After Phase 6 (dev-evaluate) returns evaluation JSON:

1. **Record result**: `update-phase.sh 6_evaluate done --eval-result '$JSON' --worktree $PATH`
2. **If `verdict == "pass"`**: Proceed to Phase 7 (git-commit)
3. **If `verdict == "fail"` AND iterations < max_iterations (default 5)**:
   - Read `feedback_level` from the evaluation result
   - If `"design"`: Reset to Phase 3
     ```bash
     $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 6_evaluate done --reset-to 3_plan_impl --worktree $PATH
     ```
     Pass feedback to dev-plan-impl for plan revision
   - If `"implementation"`: Reset to Phase 4
     ```bash
     $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 6_evaluate done --reset-to 4_implement --worktree $PATH
     ```
     Pass feedback to dev-implement for code revision
4. **If max_iterations reached**: Proceed to Phase 7 with warning log
5. **If evaluate fork fails**: Retry once. If still fails, skip evaluation and proceed to Phase 7 with warning. Record error in kickoff.json.

## Phase 1 Verification

```bash
ls $WORKTREE/.env || echo "ERROR: .env not linked"
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | GitHub issue number |
| `--testing` | `tdd` | Implementation approach: tdd (test-first), bdd (behavior-first) |
| `--design` | - | Design approach: ddd (domain modeling) |

| `--depth` | `standard` | Analysis depth |
| `--base` | `dev` | PR base branch |
| `--lang` | `ja` | PR language |
| `--env-mode` | `hardlink` | Env file handling |
| `--worktree` | - | Pre-created worktree path (skips Phase 1) |
| `--task-id` | - | Subtask ID from flow.json (enables parallel mode) |
| `--flow-state` | - | Path to flow.json (read-only reference) |

## Parallel Subtask Mode

When `--task-id` is specified, dev-kickoff runs in parallel subtask mode (see Phase table "Parallel Mode" column).

### Reading Subtask Scope

The subtask scope is read from flow.json:

```bash
$SKILLS_DIR/_lib/scripts/flow-read.sh --flow-state $FLOW_STATE --subtask $TASK_ID
```

### Phase 7 Enhancement

After commit, record changed files:

```bash
git diff --name-only $BASE_BRANCH...HEAD
```

Result stored in kickoff.json under `actual_files_changed` field.

### Return Value

Return value in `--task-id` mode is minimal:

```json
{"task_id": "task1", "status": "completed|failed"}
```

## Error Handling

| Phase | On Failure |
|-------|------------|
| 1-2 | Abort, update state |
| 3-4 | Pause for intervention |
| 5 | Retry with --fix |
| 6 | Retry once, then skip with warning |
| 7-8 | Report command, save state |

## Journal Logging

On workflow completion or failure, log execution to skill-retrospective journal:

```bash
# On success (after Phase 8)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

# On failure (at any phase)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" \
  --error-phase <phase> --worktree $WORKTREE

# On partial (completed with manual intervention)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff partial \
  --issue $ISSUE --error-category <category> --error-msg "<message>" \
  --recovery "<what was done>" --recovery-turns $N --worktree $WORKTREE
```

## References

- [Phase Details](references/phase-detail.md) - Detailed phase documentation
- [State Schema](references/phase-detail.md#state-schema) - kickoff.json format
