#!/usr/bin/env bash
# worktree-finalize.sh — inspect a worktree and auto-cleanup if untouched.
#
# Mirrors Claude Code's `isolation: worktree` post-run behavior: if the
# worktree has no changes (no uncommitted diff and no commits ahead of base),
# remove it. Otherwise emit metadata so the caller can promote it (PR, merge).
#
# Usage:
#   bash worktree-finalize.sh <worktree-path> [base-ref]
#
# Output (stdout, JSON):
#   {"changed": false}
#     - no diff, no commits ahead; worktree removed.
#   {"changed": true, "path": "...", "branch": "...", "commit": "..."}
#     - changes present; worktree retained.
#
# Exit: 0 success | 1 usage | 2 git/state error

set -euo pipefail

usage() {
  echo "usage: $0 <worktree-path> [base-ref]" >&2
  exit 1
}

[ $# -lt 1 ] && usage
WT_PATH="$1"
BASE_REF="${2:-main}"

[ -d "$WT_PATH" ] || {
  echo "worktree path does not exist: $WT_PATH" >&2
  exit 2
}

git -C "$WT_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "not a git worktree: $WT_PATH" >&2
  exit 2
}

BRANCH=$(git -C "$WT_PATH" branch --show-current)
COMMIT=$(git -C "$WT_PATH" rev-parse HEAD)

unchanged=true

# uncommitted (staged + unstaged) changes
if ! git -C "$WT_PATH" diff --quiet HEAD 2>/dev/null; then
  unchanged=false
elif [ -n "$(git -C "$WT_PATH" status --porcelain 2>/dev/null)" ]; then
  unchanged=false
fi

# commits ahead of base
if [ "$unchanged" = true ]; then
  if git -C "$WT_PATH" show-ref --verify --quiet "refs/heads/$BASE_REF" \
     || git -C "$WT_PATH" show-ref --verify --quiet "refs/remotes/origin/$BASE_REF"; then
    count=$(git -C "$WT_PATH" rev-list --count "$BASE_REF..HEAD" 2>/dev/null || echo 0)
    if [ "$count" -gt 0 ]; then
      unchanged=false
    fi
  fi
fi

if [ "$unchanged" = true ]; then
  # auto-cleanup
  REPO_TOPLEVEL=$(git -C "$WT_PATH" rev-parse --path-format=absolute --git-common-dir | xargs dirname)
  git -C "$REPO_TOPLEVEL" worktree remove --force "$WT_PATH" >&2 || true
  printf '{"changed":false}\n'
  exit 0
fi

printf '{"changed":true,"path":"%s","branch":"%s","commit":"%s"}\n' \
  "$WT_PATH" "$BRANCH" "$COMMIT"
