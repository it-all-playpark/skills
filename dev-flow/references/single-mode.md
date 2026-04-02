# Dev Flow - Single Mode

小規模 issue、または auto-detect が `single_fallback` を返した場合に使用。

dev-kickoff と pr-iterate は Task subagent として独立コンテキストで実行し、メインの dev-flow コンテキストを軽量に保つ。

## Step Overview

| Step | Action | Complete When |
|------|--------|---------------|
| 2a | `Task: dev-kickoff` (subagent) | PR URL available |
| 3a | `gh pr view --json url` | URL captured |
| 4a | `Task: pr-iterate` (subagent) | LGTM achieved or max iterations |

## Checklist

```
[ ] Step 0: Skill: dev-issue-analyze
[ ] Step 1: Mode decision -> single
[ ] Step 2a: Task subagent -> dev-kickoff (see prompt below)
[ ] Step 3a: PR_URL=$(gh pr view --json url --jq .url)  (run in worktree)
[ ] Step 4a: Task subagent -> pr-iterate (see prompt below)
```

## Step 2a: dev-kickoff Subagent

Launch dev-kickoff as a Task subagent with `mode: "auto"`. The subagent runs in its own context and returns only the result.

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
| `status: "completed"` | Verify `worktree` path exists and is not the main repo -> proceed to Step 3a |
| `status: "completed"` but no `worktree` or worktree is main repo | **ABORT** -- worktree was not created |
| `status: "failed"` | Log failure via journal.sh -> abort dev-flow |
| Task tool error | Log error -> abort dev-flow |

## Step 3a: Get PR URL

```bash
# Run from worktree returned by Step 2a
cd $WORKTREE && gh pr view --json url --jq .url
```

## Step 4a: pr-iterate Subagent

Launch pr-iterate as a Task subagent with `mode: "auto"`.

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

### 4b. If changes requested -> fix -> next iteration
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
| `status: "failed"` | Log failure via journal.sh -> report error |
| Task tool error | Log error -> report error |
