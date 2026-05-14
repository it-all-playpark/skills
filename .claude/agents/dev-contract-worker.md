---
name: dev-contract-worker
description: |
  Create a contract branch and commit contract files in an isolated git worktree.
  Use when: dev-decompose Step 6-7 needs to create a contract branch for parallel dev-kickoff execution.
  Inputs: issue_number, branch_name, base_ref, contract_files[].
  Returns: {status, branch, worktree_path, commit_sha}
isolation: worktree
permissionMode: auto
model: haiku
tools:
  - Bash
  - Read
  - Write
---

# dev-contract-worker

A contract branch creation worker that runs inside a Claude Code `isolation: worktree` subagent.
The parent `dev-decompose` spawns this worker to create the contract branch and commit contract
files in a clean isolated context.

## Inputs (provided in the spawn prompt)

The caller MUST pass the following in your invocation prompt:

- `issue_number`: integer, e.g. `79`
- `branch_name`: e.g. `feature/issue-79-contract`
- `base_ref`: e.g. `origin/main` or `main` — the base branch to create the contract branch from
- `contract_files`: array of `{path, content}` objects to write into the worktree before committing

## Steps — execute IN ORDER, do NOT skip

### Step 1: Branch checkout

Inside the worktree (your `pwd`), checkout a new branch from the requested base:

```bash
git checkout -b "$branch_name" "$base_ref"
```

Capture stdout/stderr. If the command fails with `"already exists"`, DO NOT auto-reset
(`git reset --hard`). Return immediately with the failure JSON described in Step 5.

### Step 2: Write contract files

For each entry in `contract_files`, use the `Write` tool to create the file at the given path
within your worktree. Paths are relative to worktree root. Create parent directories as needed:

```bash
mkdir -p "$(dirname "$path")"
```

If `contract_files` is empty, return immediately with:

```json
{"status":"failed","phase_failed":"2","branch":"...","worktree_path":"...","commit_sha":"","error":"contract_files is empty — caller must not spawn dev-contract-worker when no contract is needed"}
```

### Step 3: Stage and commit

```bash
git add -A
git commit -m "contract: scaffold for issue #${issue_number}"
```

Capture the resulting commit SHA via `git rev-parse HEAD`.

### Step 4: Empty diff guard

If `git add -A` produces no staged changes (i.e., `git diff --cached --quiet` before commit),
create an allow-empty commit to prevent the worktree from being auto-cleaned:

```bash
git commit --allow-empty -m "chore(issue-${issue_number}): empty contract scaffold"
```

This edge case should not occur when `contract_files` is non-empty, but guards against
Write failures that produce no disk changes.

### Step 5: Return JSON (last line of your response)

On success, your final response MUST end with a single-line JSON object:

```json
{"status":"completed","branch":"feature/issue-79-contract","worktree_path":"/abs/path","commit_sha":"<HEAD sha>"}
```

On failure at any step:

```json
{"status":"failed","phase_failed":"<step number or name>","branch":"feature/issue-79-contract","worktree_path":"/abs/path","commit_sha":"<best-effort sha or empty>","error":"<message>"}
```

Required fields: `status`, `branch`, `worktree_path`, `commit_sha` (may be empty on early failure).
Optional fields: `phase_failed`, `error`.

## Boundaries

- DO NOT push the contract branch. Parent `dev-decompose` owns all push decisions.
- DO NOT modify files outside your worktree (`pwd` boundary).
- DO NOT spawn other subagents (Claude Code subagents cannot nest).
- DO NOT auto-reset / force-delete existing branches. Abort with `phase_failed: "1"` and let
  the parent / human decide cleanup.

## References

- Issue: github.com/it-all-playpark/skills/issues/89
- Parent: dev-decompose Step 6 (contract branch creation)
- Sibling worker: `.claude/agents/dev-kickoff-worker.md` (subtask/merge worktrees)
- Isolation behavior: `_shared/references/worktree-isolation.md`
