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
| 3b | Plan review | Plan approved or revised | Execute | Execute |
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
[ ] Phase 3b: Skill: dev-plan-review                    (NEW - Opus reviewer, context:fork)
  → fail → back to Phase 3 (with feedback)
  → pass or max rounds (3) → Phase 4
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

State persisted in `$WORKTREE/.claude/kickoff.json`. Use `init-kickoff.sh` after Phase 1, `update-phase.sh` for status updates.

Details: [State Management](references/state-management.md)

## Phase Execution

| Phase | Command | Subagent | Parallel Mode |
|-------|---------|----------|---------------|
| 1 | `$SKILLS_DIR/git-prepare/scripts/git-prepare.sh $ISSUE --base $BASE --env-mode $ENV_MODE` | - | SKIP |
| 1b | `$SKILLS_DIR/dev-kickoff/scripts/init-kickoff.sh ...` | - | SKIP |
| 2 | `Skill: dev-issue-analyze $ISSUE --depth $DEPTH` | Task(Explore) | SKIP |
| 3 | `Skill: dev-plan-impl $ISSUE --worktree $PATH` | - | Execute |
| 3b | `Skill: dev-plan-review $ISSUE --worktree $PATH` | context:fork | Execute |
| 4 | `Skill: dev-implement --testing $TESTING [--design $DESIGN] --worktree $PATH` | - | Execute |
| 5 | `Skill: dev-validate --fix --worktree $PATH` | Task(quality-engineer) | Execute |
| 6 | `Skill: dev-evaluate $ISSUE --worktree $PATH` | context:fork | Execute |
| 7 | `Skill: git-commit --all --worktree $PATH` | - | Execute |
| 8 | `Skill: git-pr $ISSUE --base $BASE --lang $LANG --worktree $PATH` | - | SKIP |

Phase 1: Must execute script. Direct `git worktree add` is prohibited.

## Evaluate-Retry Loop

Phase 6 verdict determines next step: `pass` -> Phase 7, `fail` -> retry from Phase 3 (design feedback) or Phase 4 (implementation feedback). Max 5 iterations. Fork failure -> retry once, then skip with warning.

Details: [Evaluate-Retry Loop](references/evaluate-retry.md)

## Plan-Review Loop

Phase 3b verdict determines next step: `pass` → Phase 4, `fail` → retry from Phase 3 (dev-plan-impl with feedback). Max 3 rounds. Fork failure → retry once, then skip with warning.

Details: [Plan-Review Loop](references/evaluate-retry.md#plan-review-loop-phase-3b)

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

When `--task-id` is specified, phases 1-2 and 8 are skipped. Subtask scope read from flow.json. Returns minimal `{"task_id", "status"}` JSON.

Details: [Parallel Mode](references/parallel-mode.md)

## Error Handling

Phases 1-2: abort. Phases 3-5: analyze error, retry with context (max 2), then pause. Phase 6: retry once, skip with warning. Phases 7-8: retry once, report manual command.

Details: [Error Handling](references/error-handling.md)

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

- [State Management](references/state-management.md) - Init scripts, update commands, state schema, recovery
- [Evaluate-Retry Loop](references/evaluate-retry.md) - Detailed evaluate-retry flow with reset commands
- [Error Handling](references/error-handling.md) - Per-phase error handling, auto-retry protocol
- [Parallel Mode](references/parallel-mode.md) - Subtask scope reading, phase 7 enhancement, return value
- [Phase Details](references/phase-detail.md) - Detailed phase documentation
