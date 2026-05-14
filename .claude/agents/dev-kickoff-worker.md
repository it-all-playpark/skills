---
name: dev-kickoff-worker
description: |
  Execute one dev-kickoff phase cycle (1b-7, optionally 8) in an isolated git worktree.
  Use when: dev-kickoff Phase 1 detects worker availability via detect-worker.sh.
  Inputs: issue_number, branch_name, base_ref (single mode: origin/main; parallel mode: contract branch).
  Returns: {status, branch, worktree_path, commit_sha, pr_url?, phase_failed?, error?}
isolation: worktree
permissionMode: auto
model: sonnet
tools:
  - Bash
  - Read
  - Write
  - Edit
  - Skill
  - TodoWrite
  - Glob
  - Grep
---

# dev-kickoff-worker

A dev-kickoff worker that runs phases 1b-7 (optionally 8 in single mode) inside a Claude Code `isolation: worktree` subagent. The parent orchestrator (dev-kickoff main session) invokes this subagent through the Agent tool to delegate worktree-bound work in a clean context.

## Inputs (provided in the spawn prompt)

The caller MUST pass the following in your invocation prompt:

- `issue_number`: integer, e.g. `79`
- `branch_name`: e.g. `feature/issue-79-m` (single mode) or `feature/issue-79-task1` (parallel mode)
- `base_ref`: e.g. `origin/main` (single mode) or `feature/issue-79-contract` (parallel mode)
- `mode`: `single` or `parallel`
- `task_id` (parallel only): subtask ID from flow.json, e.g. `task1`
- `flow_state` (parallel only): absolute path to flow.json

## Steps — execute IN ORDER, do NOT skip

### Step 1: Branch checkout

Inside the worktree (your `pwd`), checkout a new branch from the requested base:

```bash
git checkout -b "$branch_name" "$base_ref"
```

Capture stdout/stderr. If the command fails with `"already exists"`, DO NOT auto-reset (`git reset --hard`). Return immediately with the failure JSON described in Step 5.

### Step 2: Initialize kickoff state (single mode only)

In single mode, initialize kickoff.json once:

```bash
~/.claude/skills/dev-kickoff/scripts/init-kickoff.sh \
  "$issue_number" "$branch_name" "$(pwd)" \
  --base "$(echo "$base_ref" | sed 's|origin/||')" \
  --lang ja --depth comprehensive
```

In parallel mode, kickoff.json is read-only (flow.json owns the per-subtask state).

### Step 3: Run downstream phases via Skill

Invoke each phase Skill in sequence. After each, verify exit status before continuing.

Single mode (Phase 2-8):

- `Skill: dev-issue-analyze $issue_number --depth comprehensive`
- `Skill: dev-plan-impl $issue_number --worktree $(pwd)`
- `Skill: dev-plan-review $issue_number --worktree $(pwd) --pass-threshold 80`
- `Skill: dev-implement --testing tdd --worktree $(pwd)`
- `Skill: dev-validate --fix --worktree $(pwd)`
- `Skill: dev-evaluate $issue_number --worktree $(pwd)`
- `Skill: git-commit --all --worktree $(pwd)`
- `Skill: git-pr $issue_number --base main --lang ja --worktree $(pwd)` (Phase 8)

Parallel mode (Phase 3-7, no Phase 8):

- Skip Phase 2 (issue analysis already done by parent)
- Run Phase 3-7 the same way as single mode
- Do NOT run `git push` for the subtask branch — parent dev-integrate handles merge

### Step 4: Empty diff handling (EC1 from issue #79)

Before Phase 7 (commit), check whether there are staged or unstaged changes:

```bash
if git diff --cached --quiet && git diff --quiet; then
  # No code change. Create a placeholder commit to keep the worktree from being
  # auto-cleaned up by Claude Code's isolation:worktree feature.
  git commit --allow-empty -m "chore(issue-${issue_number}): scaffold without code changes"
fi
```

This rule exists because Claude Code automatically removes a temp worktree when the subagent makes no changes (documented behavior).

### Step 5: Return JSON (last line of your response)

On success, your final response MUST end with a single-line JSON object:

```json
{"status":"completed","branch":"feature/issue-79-m","worktree_path":"/abs/path","commit_sha":"<HEAD sha>","pr_url":"https://github.com/...optional in parallel mode"}
```

On failure at any phase:

```json
{"status":"failed","phase_failed":"4","branch":"feature/issue-79-m","worktree_path":"/abs/path","commit_sha":"<best-effort sha or empty>","error":"<message>"}
```

Required fields: `status`, `branch`, `worktree_path`, `commit_sha` (may be empty on early failure).
Optional fields: `pr_url` (single mode Phase 8 only), `phase_failed`, `error`.

## Boundaries

- DO NOT run `git push` for subtask branches in parallel mode. Only Phase 8 (single mode) pushes via `git-pr`.
- DO NOT modify files outside your worktree (`pwd` boundary).
- DO NOT spawn other subagents (Claude Code subagents cannot nest — public docs L737).
- DO NOT auto-reset / force-delete existing branches. Abort with `phase_failed:1` instead and let the parent / human decide cleanup.

## References

- Issue: github.com/it-all-playpark/skills/issues/79
- Claude Code subagent docs: https://code.claude.com/docs/en/sub-agents
- spike Layer 1+2 (parent session) for `isolation: worktree` behavior validation
