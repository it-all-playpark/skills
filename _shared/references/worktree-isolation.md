# Worktree Isolation — Spike Results

Findings from the `isolation: worktree` spike conducted in issues #79 and #82.
Preserved here as a permanent reference for workers spawned with `isolation: worktree`.

## 1. Directory Structure

When Claude Code spawns a subagent with `isolation: worktree`, it creates a temporary
directory at:

```
<repo>/.claude/worktrees/agent-<uuid>/
```

The directory starts **empty** (only `.claude/` metadata is pre-populated). The agent's
`pwd` is set to this directory.

### Key: `git-common-dir` vs `worktreePath`

```bash
# Inside the isolation:worktree subagent
pwd
# → /path/to/repo/.claude/worktrees/agent-<uuid>

git rev-parse --git-common-dir
# → ../../../.git   (shared with the main repo — same object store)

git rev-parse --show-toplevel
# → /path/to/repo   (main repo, NOT the worktree dir)
```

**Implication**: The isolated directory is NOT a standalone git repository. It shares
the main repo's `.git` object store via `GIT_COMMON_DIR`. Files in the worktree are
managed by the branch that is checked out there.

## 2. Branch Checkout Pattern

The worker must always begin with:

```bash
git checkout -b "$branch_name" "$base_ref"
```

This populates the `pwd` directory with all files from `$base_ref`. Before this command,
the directory only contains the `.claude/` subdirectory.

If the branch already exists, `git checkout -b` fails with "already exists". The worker
must NOT auto-reset. Return `phase_failed: "1"` and let the parent decide cleanup.

## 3. `[locked]` Worktree Cleanup

Claude Code automatically removes the temporary worktree directory after the subagent
completes **only if no files were modified**. If the agent creates or modifies files,
the worktree is retained with a `[locked]` flag in `git worktree list` output.

```bash
git worktree list
# /path/to/repo                         abc1234 [main]
# /path/to/repo/.claude/worktrees/...   def5678 [feature/issue-N-m] (locked)
```

The parent can prune it after use:

```bash
git worktree remove --force /path/to/repo/.claude/worktrees/agent-<uuid>
# or
git worktree prune
```

**Empty-commit guard**: If a worker runs but makes no changes (e.g., analysis-only run),
create an allow-empty commit to prevent the worktree from being auto-cleaned:

```bash
if git diff --cached --quiet && git diff --quiet; then
  git commit --allow-empty -m "chore(issue-${issue_number}): scaffold without code changes"
fi
```

## 4. Push Prohibition

Workers with `isolation: worktree` must NOT push their branch. Only the final Phase 8
(`git-pr` in single mode) pushes via the PR creation flow. Subtask and contract branches
stay local until the merge branch is pushed by `dev-integrate`.

Summary of push rules by worker type:

| Worker | Push allowed? |
|--------|--------------|
| `dev-contract-worker` | No — parent dev-decompose decides |
| `dev-kickoff-worker` (mode: parallel) | No — parent dev-integrate merges |
| `dev-kickoff-worker` (mode: single) | Yes — Phase 8 git-pr pushes |
| `dev-kickoff-worker` (mode: merge) | No — parent dev-integrate pushes merge branch |

## 5. Decomposition Matrix

Worker types and their intended use cases:

| Subagent type | model | isolation | Spawned by | Purpose |
|---------------|-------|-----------|------------|---------|
| `dev-contract-worker` | haiku | worktree | dev-decompose | Create contract branch + commit contract files |
| `dev-kickoff-worker` (single) | sonnet | worktree | dev-kickoff | Full issue dev cycle (Phase 1b-8) |
| `dev-kickoff-worker` (parallel) | sonnet | worktree | dev-decompose / dev-flow | Single subtask dev cycle (Phase 3-7) |
| `dev-kickoff-worker` (merge) | sonnet | worktree | dev-integrate | Merge subtask branches + integration validate |

## 6. Nesting Prohibition

Claude Code subagents spawned via `isolation: worktree` cannot nest further subagents
(documented behavior, public docs). Workers must not use the `Task` or `Agent` tools
to spawn additional subagents.

## References

- Issue #79: spike layer 1+2, isolation:worktree behavior validation
- Issue #82: dev-integrate merge worktree worker
- Issue #89: dev-contract-worker introduction, git-prepare deletion
- [`dev-kickoff-worker.md`](../../.claude/agents/dev-kickoff-worker.md)
- [`dev-contract-worker.md`](../../.claude/agents/dev-contract-worker.md)
