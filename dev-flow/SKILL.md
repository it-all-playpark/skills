---
name: dev-flow
description: |
  End-to-end development flow automation - from issue to LGTM.
  Note: Merge is performed manually by the user after review approval.
  Supports parallel subtask decomposition for large issues.
  Use when: (1) complete development cycle needed, (2) issue to PR automation,
  (3) keywords: full flow, development cycle, issue to PR
  Accepts args: <issue-number> [--strategy tdd|bdd|ddd] [--depth minimal|standard|comprehensive] [--base <branch>] [--max-iterations N] [--parallel]
allowed-tools:
  - Skill
  - Bash
  - Task
---

# Dev Flow

End-to-end development automation from issue to LGTM (merge manually).

## CRITICAL: Complete All Steps

**DO NOT EXIT until pr-iterate completes.**

## Mode Selection

dev-flow operates in two modes based on issue complexity:

```
dev-flow (mode branch)
├── Single mode (default / small issues)
│   └── dev-kickoff 1 instance → git-pr → pr-iterate
│
└── Parallel mode (--parallel / large issues)
    ├── dev-issue-analyze
    ├── dev-decompose → flow.json + N worktrees
    ├── dev-kickoff × N (parallel via Task tool)
    ├── dev-integrate (merge + type check + test)
    ├── git-pr
    └── pr-iterate
```

## Single Mode (Default)

For small issues or when `--parallel` is not specified.

| Step | Action | Complete When |
|------|--------|---------------|
| 1 | `Skill: dev-kickoff` | PR URL available |
| 2 | `gh pr view --json url` | URL captured |
| 3 | `Skill: pr-iterate` | LGTM achieved or max iterations |

### Single Mode Checklist

```
[ ] Step 1: Skill: dev-kickoff $ISSUE --strategy $STRATEGY --depth $DEPTH --base $BASE
[ ] Step 2: PR_URL=$(gh pr view --json url --jq .url)
[ ] Step 3: Skill: pr-iterate $PR_URL --max-iterations $MAX
```

## Parallel Mode

For large issues requiring decomposition. Activated with `--parallel` flag.

| Step | Action | Complete When |
|------|--------|---------------|
| 1 | `Skill: dev-issue-analyze` | Requirements understood |
| 2 | `Skill: dev-decompose` | flow.json + worktrees created |
| 3 | Check decomposition result | Single fallback or proceed |
| 4 | `dev-kickoff x N` (parallel) | All subtasks completed |
| 5 | Aggregate results | flow.json updated |
| 6 | `Skill: dev-integrate` | Merge + tests pass |
| 7 | `Skill: git-pr` | PR URL available |
| 8 | `Skill: pr-iterate` | LGTM or max iterations |

### Batch Scheduling (Step 4)

Launch subtasks in dependency-ordered batches (independent first, then dependents). Each invocation:

```bash
Skill: dev-kickoff $ISSUE --worktree $SUBTASK_WORKTREE --task-id $TASK_ID --flow-state $FLOW_STATE --strategy $STRATEGY
```

### Result Aggregation (Step 5)

For each completed subtask, read kickoff.json and update flow.json:

```bash
CHANGED=$(jq -r '.actual_files_changed // [] | join(",")' $SUBTASK_WORKTREE/.claude/kickoff.json)
~/.claude/skills/_lib/scripts/flow-update.sh --flow-state $FLOW_STATE \
  subtask $TASK_ID --status completed --files-changed "$CHANGED"
```

## Usage

```
/dev-flow <issue> [--strategy tdd] [--depth comprehensive] [--base main] [--max-iterations 10] [--parallel]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | GitHub issue number |
| `--strategy` | `tdd` | Implementation strategy |
| `--depth` | `standard` | Analysis depth |
| `--base` | `main` | PR base branch |
| `--max-iterations` | `10` | Max pr-iterate iterations |
| `--parallel` | - | Enable parallel subtask decomposition |

## Completion Conditions

| Condition | Action |
|-----------|--------|
| pr-iterate completes | Workflow complete |
| LGTM achieved | Workflow complete (merge manually) |
| Max iterations reached | Report status, user decides |
| Any step fails | Report error, do not proceed |
| Decomposition yields 1 subtask | Fallback to single mode |

## No Auto-Merge

**This workflow does NOT merge the PR.** After achieving LGTM, the user should manually merge using `gh pr merge` or the GitHub UI.

## State Recovery

After auto-compact, check state:

```bash
# Single mode
~/.claude/skills/dev-flow/scripts/flow-status.sh --worktree $WORKTREE

# Parallel mode
~/.claude/skills/_lib/scripts/flow-read.sh --flow-state $FLOW_STATE
```

## Error Handling

See [Workflow Details](references/workflow-detail.md) for error handling matrix.

## Worktree Cleanup

After workflow completes (or on failure), clean up worktrees:

```bash
# List worktrees for this issue
git worktree list | grep "issue-$ISSUE"

# Remove subtask worktrees (keep merge worktree if PR exists)
git worktree remove $SUBTASK_WORKTREE --force
```

## Journal Logging

On workflow completion, log execution to skill-retrospective journal:

```bash
# On success (LGTM achieved)
~/.claude/skills/skill-retrospective/scripts/journal.sh log dev-flow success \
  --issue $ISSUE --duration-turns $TURNS

# On failure (any step fails)
~/.claude/skills/skill-retrospective/scripts/journal.sh log dev-flow failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>"
```

Note: dev-kickoff and pr-iterate also log independently. dev-flow logging captures the overall flow outcome.

## References

- [Workflow Details](references/workflow-detail.md) - Full phase descriptions
- [dev-kickoff](../dev-kickoff/SKILL.md) - Phase orchestrator
- [dev-decompose](../dev-decompose/SKILL.md) - Subtask decomposition
- [dev-integrate](../dev-integrate/SKILL.md) - Branch integration
- [pr-iterate](../pr-iterate/SKILL.md) - PR iteration skill
