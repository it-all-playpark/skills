---
name: dev-flow
description: |
  End-to-end development flow automation - from issue to LGTM.
  Note: Merge is performed manually by the user after review approval.
  Auto-detects parallel vs single mode based on issue complexity.
  Use when: (1) complete development cycle needed, (2) issue to PR automation,
  (3) keywords: full flow, development cycle, issue to PR
  Accepts args: <issue-number> [--strategy tdd|bdd|ddd] [--depth minimal|standard|comprehensive] [--base <branch>] [--max-iterations N] [--force-single] [--force-parallel]
allowed-tools:
  - Skill
  - Bash
  - Task
---

# Dev Flow

End-to-end development automation from issue to LGTM (merge manually).

## 言語ルール

**PR本文・レビューコメント・PRコメントは必ず日本語で記述すること。**
- サブエージェントへのプロンプトでも日本語出力を明示指定する
- 技術用語・コード識別子・ファイルパスはそのまま

## CRITICAL: Complete All Steps

**DO NOT EXIT until pr-iterate completes.**

## Mode Selection (Auto-Detect)

dev-flow automatically selects single or parallel mode using `dev-decompose --dry-run`.
Override with `--force-single` or `--force-parallel` when needed.

```
dev-flow <issue>
│
├─→ Step 0: dev-issue-analyze --depth standard
│
├─→ Step 1: Mode Decision
│   ├── --force-single  → Single Mode (skip dry-run)
│   ├── --force-parallel → Parallel Mode (skip dry-run)
│   └── auto (default)  → dev-decompose --dry-run
│       ├── single_fallback → Single Mode
│       └── ready          → Parallel Mode
│
├─→ [Single]   Steps 2a-4a (see below)
└─→ [Parallel] Steps 2b-9b (see below)
```

## Step 0: Issue Analysis (Always)

```bash
Skill: dev-issue-analyze $ISSUE --depth standard
```

Provides context for both modes and for dry-run decomposition assessment.

## Step 1: Mode Decision

### Auto-Detect (default)

```bash
Skill: dev-decompose $ISSUE --dry-run
```

Assess issue complexity using actual codebase file dependencies (not issue text parsing).
Criteria defined in [Decomposition Guide](../dev-decompose/references/decomposition-guide.md#when-to-fall-back-to-single-mode):

- `single_fallback`: < 4 affected files, single component, all files tightly coupled, or 1 subtask after grouping
- `ready`: Multiple independent subtask groups identified

### Force Overrides

| Flag | Behavior |
|------|----------|
| `--force-single` | Skip dry-run, go directly to Single Mode |
| `--force-parallel` | Skip dry-run, go directly to Parallel Mode (full dev-decompose) |
| `--parallel` | **Deprecated alias** for `--force-parallel`. Shows deprecation notice |
| Both specified | **Error**: "Cannot specify both --force-single and --force-parallel" |

## Single Mode

For small issues or when auto-detect returns `single_fallback`.

dev-kickoff and pr-iterate run as Task subagents with independent contexts to keep the main dev-flow context lightweight.

| Step | Action | Complete When |
|------|--------|---------------|
| 2a | `Task: dev-kickoff` (subagent) | PR URL available |
| 3a | `gh pr view --json url` | URL captured |
| 4a | `Task: pr-iterate` (subagent) | LGTM achieved or max iterations |

### Single Mode Checklist

```
[ ] Step 0: Skill: dev-issue-analyze (see above)
[ ] Step 1: Mode decision → single
[ ] Step 2a: Task subagent → dev-kickoff (see prompt below)
[ ] Step 3a: PR_URL=$(gh pr view --json url --jq .url)  (run in worktree)
[ ] Step 4a: Task subagent → pr-iterate (see prompt below)
```

### Step 2a: dev-kickoff Subagent

Launch dev-kickoff as a Task subagent. The subagent runs in its own context and returns only the result.

**CRITICAL: Worktree is MANDATORY in single mode.** The subagent MUST create a worktree via Phase 1 (git-prepare.sh) before any implementation. Implementation in the main repository directory is NEVER allowed.

**Task prompt:**

```
Execute the dev-kickoff skill for issue #$ISSUE.
Run: Skill: dev-kickoff $ISSUE --strategy $STRATEGY --depth $DEPTH --base $BASE --lang ja

CRITICAL REQUIREMENT: You MUST execute Phase 1 (worktree creation via git-prepare.sh) FIRST.
- Phase 1 creates an isolated worktree. ALL implementation MUST happen inside this worktree.
- Do NOT skip Phase 1. Do NOT implement in the current directory.
- The --task-id flag is NOT set, so this is single mode — Phase 1 is REQUIRED.

LANGUAGE REQUIREMENT: All PR body content, commit messages descriptions, and GitHub comments MUST be written in Japanese (日本語).
Technical terms, code identifiers, and file paths remain in their original form.

After completion, return ONLY a JSON result:
- On success: {"status": "completed", "worktree": "<path>", "pr_url": "<url>", "pr_number": <number>}
- On failure: {"status": "failed", "error": "<message>", "phase": "<failed_phase>"}
```

**Result handling:**

| Result | Action |
|--------|--------|
| `status: "completed"` | Verify `worktree` path exists and is not the main repo → proceed to Step 3a |
| `status: "completed"` but no `worktree` or worktree is main repo | **ABORT** — worktree was not created |
| `status: "failed"` | Log failure via journal.sh → abort dev-flow |
| Task tool error | Log error → abort dev-flow |

### Step 3a: Get PR URL

```bash
# Run from worktree returned by Step 2a
cd $WORKTREE && gh pr view --json url --jq .url
```

### Step 4a: pr-iterate Subagent

Launch pr-iterate as a Task subagent.

**Task prompt:**

```
Execute the pr-iterate skill for PR $PR_URL in worktree $WORKTREE.
The skills directory is at: $SKILLS_DIR

LANGUAGE REQUIREMENT: All review comments, PR comments, and summaries MUST be written in Japanese (日本語).
Technical terms, code identifiers, and file paths remain in their original form.

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

For large issues. Activated automatically when dry-run returns `ready`, or with `--force-parallel`.

| Step | Action | Complete When |
|------|--------|---------------|
| 2b | `Skill: dev-decompose` (full, with `--resume` if dry-run ran) | flow.json + worktrees created |
| 3b | Check decomposition result | Verify subtask count > 1 |
| 4b | `dev-kickoff x N` (parallel) | All subtasks completed |
| 5b | Aggregate results | flow.json updated |
| 6b | `Skill: dev-integrate` | Merge + tests pass |
| 7b | `Skill: git-pr` | PR URL available |
| 8b | `Skill: pr-iterate` | LGTM or max iterations |

### Step 2b: Full Decomposition

If dry-run already ran (auto-detect path), pass its result to avoid re-analysis:
```bash
Skill: dev-decompose $ISSUE --resume $DRY_RUN_RESULT --base $BASE --env-mode $ENV_MODE
```

If `--force-parallel` (no dry-run), run full decomposition:
```bash
Skill: dev-decompose $ISSUE --base $BASE --env-mode $ENV_MODE
```

### Batch Scheduling (Step 4b)

Launch subtasks in dependency-ordered batches (independent first, then dependents). Each invocation:

```bash
Skill: dev-kickoff $ISSUE --worktree $SUBTASK_WORKTREE --task-id $TASK_ID --flow-state $FLOW_STATE --strategy $STRATEGY
```

### Result Aggregation (Step 5b)

For each completed subtask, read kickoff.json and update flow.json:

```bash
CHANGED=$(jq -r '.actual_files_changed // [] | join(",")' $SUBTASK_WORKTREE/.claude/kickoff.json)
$SKILLS_DIR/_lib/scripts/flow-update.sh --flow-state $FLOW_STATE \
  subtask $TASK_ID --status completed --files-changed "$CHANGED"
```

## Usage

```
/dev-flow <issue> [--strategy tdd] [--depth comprehensive] [--base dev] [--max-iterations 10] [--force-single] [--force-parallel]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | GitHub issue number |
| `--strategy` | `tdd` | Implementation strategy |
| `--depth` | `standard` | Analysis depth |
| `--base` | `dev` | PR base branch |
| `--max-iterations` | `10` | Max pr-iterate iterations |
| `--force-single` | - | Skip auto-detect, force single mode |
| `--force-parallel` | - | Skip auto-detect, force parallel mode |
| `--parallel` | - | **Deprecated**: alias for `--force-parallel` |

## Completion Conditions

| Condition | Action |
|-----------|--------|
| pr-iterate completes | Workflow complete |
| LGTM achieved | Workflow complete (merge manually) |
| Max iterations reached | Report status, user decides |
| Any step fails | Report error, do not proceed |
| Dry-run returns single_fallback | Use single mode |

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

On workflow completion, log execution to skill-retrospective journal.
**CRITICAL: Always pass `--args` with the original invocation arguments** so that usage patterns are tracked.

```bash
# On success (LGTM achieved)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-flow success \
  --issue $ISSUE --duration-turns $TURNS --args "$ORIGINAL_ARGS"

# On failure (any step fails)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-flow failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" --args "$ORIGINAL_ARGS"
```

Where `$ORIGINAL_ARGS` is the full argument string passed to dev-flow (e.g. `"42 --force-parallel --strategy tdd"`).

Note: dev-kickoff and pr-iterate also log independently. dev-flow logging captures the overall flow outcome.

## References

- [Workflow Details](references/workflow-detail.md) - Full phase descriptions
- [dev-kickoff](../dev-kickoff/SKILL.md) - Phase orchestrator
- [dev-decompose](../dev-decompose/SKILL.md) - Subtask decomposition
- [dev-integrate](../dev-integrate/SKILL.md) - Branch integration
- [pr-iterate](../pr-iterate/SKILL.md) - PR iteration skill
