#!/usr/bin/env bash
# git-prepare.sh - Create isolated git worktree for feature development
# Usage: git-prepare.sh <issue-number> [options]
#
# Options:
#   --suffix <suffix>     Branch suffix (default: m)
#   --base <branch>       Base branch (default: dev)
#   --local               Skip gh issue develop and keep branch local-only (no remote push)
#
# Output: JSON with worktree info
#
# .env files are handled by .worktreeinclude (Claude Code copies matching files
# automatically on `git worktree add`). If .worktreeinclude does not exist,
# this script generates it via generate-worktreeinclude.sh.

set -euo pipefail

# Defaults
SUFFIX="m"
BASE_BRANCH="dev"
LOCAL_ONLY=false
ISSUE_NUMBER=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --suffix) SUFFIX="$2"; shift 2 ;;
        --base) BASE_BRANCH="$2"; shift 2 ;;
        --local) LOCAL_ONLY=true; shift ;;
        --env-mode) shift 2 ;; # Deprecated: ignored for backward compatibility
        -h|--help)
            echo "Usage: git-prepare.sh <issue-number> [--suffix <s>] [--base <branch>] [--local]"
            exit 0
            ;;
        -*)
            echo "Error: Unknown option $1" >&2
            exit 1
            ;;
        *)
            if [[ -z "$ISSUE_NUMBER" ]]; then
                ISSUE_NUMBER="$1"
            fi
            shift
            ;;
    esac
done

# Validate
if [[ -z "$ISSUE_NUMBER" ]]; then
    echo "Error: Issue number required" >&2
    exit 1
fi

# Get repository info
REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")

# Compute paths
BRANCH_NAME="feature/issue-${ISSUE_NUMBER}-${SUFFIX}"
WORKTREE_BASE="${REPO_ROOT}/../${REPO_NAME}-worktrees"
WORKTREE_PATH="${WORKTREE_BASE}/feature-issue-${ISSUE_NUMBER}-${SUFFIX}"

# Script directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GENERATE_WORKTREEINCLUDE="$SCRIPT_DIR/../../_lib/scripts/generate-worktreeinclude.sh"

# Create worktrees directory
mkdir -p "$WORKTREE_BASE"

# Fetch latest
git fetch origin "$BASE_BRANCH" 2>/dev/null || true

# Ensure .worktreeinclude exists (auto-generate if missing)
WORKTREEINCLUDE_RESULT=""
if [[ -x "$GENERATE_WORKTREEINCLUDE" ]]; then
    WORKTREEINCLUDE_RESULT=$("$GENERATE_WORKTREEINCLUDE" --repo-root "$REPO_ROOT" 2>/dev/null || echo '{"status":"error"}')
fi

# Check if worktree already exists
if [[ -d "$WORKTREE_PATH" ]]; then
    jq -n \
        --arg worktree_path "$WORKTREE_PATH" \
        --arg branch "$BRANCH_NAME" \
        '{status: "exists", worktree_path: $worktree_path, branch: $branch}'
    exit 0
fi

# Check if branch exists locally
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
    # Branch exists, use it
    git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
else
    if [[ "$LOCAL_ONLY" == true ]]; then
        # Local-only mode: create branch locally without touching remote
        git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" "origin/$BASE_BRANCH"
    else
        # Try creating linked branch via gh issue develop (links to issue's Development sidebar)
        if gh issue develop "$ISSUE_NUMBER" --name "$BRANCH_NAME" --base "$BASE_BRANCH" 2>/dev/null; then
            git fetch origin "$BRANCH_NAME" 2>/dev/null || true
        fi

        # Create worktree (auto-tracks remote branch if exists, otherwise creates from base)
        if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH_NAME" 2>/dev/null; then
            git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
        else
            git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" "origin/$BASE_BRANCH"
        fi
    fi
fi

# Output JSON result
jq -n \
    --arg worktree_path "$WORKTREE_PATH" \
    --arg branch "$BRANCH_NAME" \
    --arg base "origin/$BASE_BRANCH" \
    '{status: "created", worktree_path: $worktree_path, branch: $branch, base: $base}'
