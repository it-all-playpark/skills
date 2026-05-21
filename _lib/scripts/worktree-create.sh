#!/usr/bin/env bash
# worktree-create.sh — portable replacement for Claude Code's `isolation: worktree`.
#
# Creates a fresh git worktree at <repo>-worktrees/feature/issue-<N>, branching
# from <base-ref> (default: main). Bash + git only — works under any agent
# (Claude Code, Codex CLI, Antigravity, plain shell).
#
# Usage:
#   bash worktree-create.sh <issue-number> [base-ref]
#
# Output (stdout): absolute path of the new worktree
# Exit: 0 success | 1 usage error | 2 git/state error

set -euo pipefail

usage() {
  echo "usage: $0 <issue-number> [base-ref]" >&2
  exit 1
}

[ $# -lt 1 ] && usage
ISSUE="$1"
BASE_REF="${2:-main}"

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "not in a git repository" >&2
  exit 2
}
REPO_NAME=$(basename "$REPO_ROOT")
WT_ROOT="$(dirname "$REPO_ROOT")/${REPO_NAME}-worktrees"
BRANCH="feature/issue-$ISSUE"
WT_PATH="$WT_ROOT/$BRANCH"

if [ -d "$WT_PATH" ]; then
  echo "worktree already exists at $WT_PATH" >&2
  exit 2
fi

if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "branch '$BRANCH' already exists" >&2
  exit 2
fi

mkdir -p "$WT_ROOT"
git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WT_PATH" "$BASE_REF" >&2

echo "$WT_PATH"
