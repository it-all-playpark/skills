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

The parent can prune it after use. For dev-flow 管理 worktree（`df-*`）は、生の
`git worktree remove` の代わりに `_shared/scripts/worktree-teardown.sh <worktree-path>` を
使うこと:

```bash
_shared/scripts/worktree-teardown.sh /path/to/repo/.claude/worktrees/df-<issue>
# or (df-* 以外・従来通り)
git worktree remove --force /path/to/repo/.claude/worktrees/agent-<uuid>
git worktree prune
```

`worktree-teardown.sh` は `git worktree remove` する前に、その worktree の
`.veridelta/runs/*.json`（red→green の検証証跡）を repo 直下 `.veridelta-archive/` へ退避してから
削除する。退避失敗は teardown を止めない（fail-open）。痕跡は
`~/.claude/logs/veridelta-archive.log` に記録される。retention は件数/バイト上限があり、
超過した古い entry から自動で回収される。

**実行文脈の注意**: `worktree-teardown.sh`（および内部で使う退避処理）は**非 sandbox の
human terminal で実行すること**。Claude sandbox 下では repo 内（`.veridelta-archive/`）への
書き込みが deny され、退避が fail-open no-op になる（remove 自体は成功するが証跡は残らない）。
sandbox 経由でどうしても使いたい場合は、`.claude/settings.json` の sandbox write allow に
`.veridelta-archive/` を追加する（人間が設定変更する）。

手動検証（red→green 記録が teardown 後も退避先から読めることの確認）も同様に、
**非 sandbox の human terminal で実施する**こと。

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
| `dev-kickoff-worker` (mode: single) | Yes — Phase 8 git-pr pushes |

issue #93 で contract branch / parallel / merge mode は撤廃された。複数 issue の並列実行は
`dev-decompose --child-split` で child issue を発行し、`dev-flow --child-split` の batch loop
が child を独立 single-mode dev-kickoff として消化する（child PR は `integration/issue-{N}-{slug}`
に直接 merge、Kahn 法 topological merge は廃止）。

## 5. Decomposition Matrix

Worker types and their intended use cases:

| Subagent type | model | isolation | Spawned by | Purpose |
|---------------|-------|-----------|------------|---------|
| `dev-kickoff-worker` (single) | sonnet | worktree | dev-kickoff | Full issue dev cycle (Phase 1b-8) |

## 6. Nesting Prohibition

Claude Code subagents spawned via `isolation: worktree` cannot nest further subagents
(documented behavior, public docs). Workers must not use the `Task` or `Agent` tools
to spawn additional subagents.

## References

- Issue #79: spike layer 1+2, isolation:worktree behavior validation
- Issue #93: parallel / merge / contract mode 撤廃、child-split (child issue + integration branch + batch loop) に統一
- [`dev-kickoff-worker.md`](../../.claude/agents/dev-kickoff-worker.md)
