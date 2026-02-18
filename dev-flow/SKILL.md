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
│   ├── Task: dev-kickoff 1 instance → git-pr (subagent, independent context)
│   ├── gh pr view (main context)
│   └── Task: pr-iterate (subagent, independent context)
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

dev-kickoff and pr-iterate run as Task subagents with independent contexts to keep the main dev-flow context lightweight.

| Step | Action | Complete When |
|------|--------|---------------|
| 1 | `Task: dev-kickoff` (subagent) | PR URL available |
| 2 | `gh pr view --json url` | URL captured |
| 3 | `Task: pr-iterate` (subagent) | LGTM achieved or max iterations |

### Single Mode Checklist

```
[ ] Step 1: Task subagent → dev-kickoff (see prompt below)
[ ] Step 2: PR_URL=$(gh pr view --json url --jq .url)  (run in worktree)
[ ] Step 3: Task subagent → pr-iterate (see prompt below)
```

### Step 1: dev-kickoff Subagent

Launch dev-kickoff as a Task subagent. The subagent runs in its own context and returns only the result.

**CRITICAL: Worktree is MANDATORY in single mode.** The subagent MUST create a worktree via Phase 1 (git-prepare.sh) before any implementation. Implementation in the main repository directory is NEVER allowed.

**Task prompt:**

```
Execute the dev-kickoff skill for issue #$ISSUE.
Run: Skill: dev-kickoff $ISSUE --strategy $STRATEGY --depth $DEPTH --base $BASE

CRITICAL REQUIREMENT: You MUST execute Phase 1 (worktree creation via git-prepare.sh) FIRST.
- Phase 1 creates an isolated worktree. ALL implementation MUST happen inside this worktree.
- Do NOT skip Phase 1. Do NOT implement in the current directory.
- The --task-id flag is NOT set, so this is single mode — Phase 1 is REQUIRED.

After completion, return ONLY a JSON result:
- On success: {"status": "completed", "worktree": "<path>", "pr_url": "<url>", "pr_number": <number>}
- On failure: {"status": "failed", "error": "<message>", "phase": "<failed_phase>"}
```

**Result handling:**

| Result | Action |
|--------|--------|
| `status: "completed"` | Verify `worktree` path exists and is not the main repo → proceed to Step 2 |
| `status: "completed"` but no `worktree` or worktree is main repo | **ABORT** — worktree was not created |
| `status: "failed"` | Log failure via journal.sh → abort dev-flow |
| Task tool error | Log error → abort dev-flow |

### Step 2: Get PR URL

```bash
# Run from worktree returned by Step 1
cd $WORKTREE && gh pr view --json url --jq .url
```

### Step 3: pr-iterate Subagent

Launch pr-iterate as a Task subagent.

**Task prompt:**

```
Execute the pr-iterate skill for PR $PR_URL in worktree $WORKTREE.
The skills directory is at: $SKILLS_DIR

CRITICAL REQUIREMENT: You MUST follow the COMPLETE pr-iterate workflow below.
Do NOT skip steps. Do NOT check PR status via gh CLI and return early.
You MUST perform the self-review using the Skill tool.

## Step-by-step workflow (MANDATORY):

### 1. Initialize state
$SKILLS_DIR/pr-iterate/scripts/init-iterate.sh $PR_NUMBER --max-iterations $MAX --worktree $WORKTREE

### 2. Run self-review via Skill tool
Use the Skill tool to invoke: pr-review $PR_URL
This performs a code review and may post review comments. You MUST use the Skill tool.

### 3. Record review result
$SKILLS_DIR/pr-iterate/scripts/record-iteration.sh review \
  --decision <approved|request-changes|comment> \
  --issues "指摘事項（日本語）" \
  --summary "レビュー概要（日本語）"

### 4a. If approved (LGTM)
$SKILLS_DIR/pr-iterate/scripts/record-iteration.sh complete --status lgtm
(This auto-posts a summary comment to the PR)

### 4b. If changes requested → fix → next iteration
Use Skill tool: pr-fix $PR_URL
Record fixes, then record-iteration.sh next, then go back to Step 2.

After completion, return ONLY a JSON result:
- On LGTM: {"status": "lgtm", "iterations": <count>}
- On max reached: {"status": "max_reached", "iterations": <count>}
- On failure: {"status": "failed", "error": "<message>"}
```

**Result handling:**

| Result | Action |
|--------|--------|
| `status: "lgtm"` | Workflow complete (merge manually) |
| `status: "max_reached"` | Report status, user decides |
| `status: "failed"` | Log failure via journal.sh → report error |
| Task tool error | Log error → report error |

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
$SKILLS_DIR/_lib/scripts/flow-update.sh --flow-state $FLOW_STATE \
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
$SKILLS_DIR/dev-flow/scripts/flow-status.sh --worktree $WORKTREE

# Parallel mode
$SKILLS_DIR/_lib/scripts/flow-read.sh --flow-state $FLOW_STATE
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
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-flow success \
  --issue $ISSUE --duration-turns $TURNS

# On failure (any step fails)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-flow failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>"
```

Note: dev-kickoff and pr-iterate also log independently. dev-flow logging captures the overall flow outcome.

## References

- [Workflow Details](references/workflow-detail.md) - Full phase descriptions
- [dev-kickoff](../dev-kickoff/SKILL.md) - Phase orchestrator
- [dev-decompose](../dev-decompose/SKILL.md) - Subtask decomposition
- [dev-integrate](../dev-integrate/SKILL.md) - Branch integration
- [pr-iterate](../pr-iterate/SKILL.md) - PR iteration skill
