#!/usr/bin/env bash
# git-prepare.sh - Create isolated git worktree for feature development
# Usage: git-prepare.sh <issue-number> [options]
#
# Options:
#   --suffix <suffix>     Branch suffix (default: m)
#   --base <branch>       Base branch (default: dev)
#   --env-mode <mode>     hardlink|symlink|copy|none (default: hardlink)
#
# Output: JSON with worktree info

set -euo pipefail

# Defaults
SUFFIX="m"
BASE_BRANCH="dev"
ENV_MODE="hardlink"
ISSUE_NUMBER=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --suffix) SUFFIX="$2"; shift 2 ;;
        --base) BASE_BRANCH="$2"; shift 2 ;;
        --env-mode) ENV_MODE="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: git-prepare.sh <issue-number> [--suffix <s>] [--base <branch>] [--env-mode <mode>]"
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

if [[ ! "$ENV_MODE" =~ ^(hardlink|symlink|copy|none)$ ]]; then
    echo "Error: Invalid env-mode. Use: hardlink, symlink, copy, or none" >&2
    exit 1
fi

# Get repository info
REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")

# Compute paths
BRANCH_NAME="feature/issue-${ISSUE_NUMBER}-${SUFFIX}"
WORKTREE_BASE="${REPO_ROOT}/../${REPO_NAME}-worktrees"
WORKTREE_PATH="${WORKTREE_BASE}/feature-issue-${ISSUE_NUMBER}-${SUFFIX}"

# Sync env helper path
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_ENV="$SCRIPT_DIR/../../sync-env/scripts/sync-env.sh"

# Create worktrees directory
mkdir -p "$WORKTREE_BASE"

# Fetch latest
git fetch origin "$BASE_BRANCH" 2>/dev/null || true

# Check if worktree already exists
if [[ -d "$WORKTREE_PATH" ]]; then
    # Sync .env files even for existing worktrees (without --force to skip existing)
    if [[ "$ENV_MODE" != "none" ]]; then
        ENV_RESULT=$("$SYNC_ENV" --worktree "$WORKTREE_PATH" --source "$REPO_ROOT" --mode "$ENV_MODE")
    else
        ENV_RESULT='{"status":"skipped","mode":"none","files_synced":[],"total_synced":0}'
    fi
    echo "{\"status\":\"exists\",\"worktree_path\":\"$WORKTREE_PATH\",\"branch\":\"$BRANCH_NAME\",\"env_mode\":\"$ENV_MODE\"}"
    exit 0
fi

# Check if branch exists
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
    # Branch exists, use it
    git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
else
    # Create new branch from base
    git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" "origin/$BASE_BRANCH"
fi

# Sync environment files via sync-env skill (--force for new worktrees)
if [[ "$ENV_MODE" != "none" ]]; then
    ENV_RESULT=$("$SYNC_ENV" --worktree "$WORKTREE_PATH" --source "$REPO_ROOT" --mode "$ENV_MODE" --force)
else
    ENV_RESULT='{"status":"skipped","mode":"none","files_synced":[],"total_synced":0}'
fi

# Extract env_files array from sync-env result
ENV_FILES_JSON=$(echo "$ENV_RESULT" | grep -o '"files_synced":\[[^]]*\]' | sed 's/"files_synced"://' || echo '[]')

# Output JSON result
cat <<EOF
{
  "status": "created",
  "worktree_path": "$WORKTREE_PATH",
  "branch": "$BRANCH_NAME",
  "base": "origin/$BASE_BRANCH",
  "env_mode": "$ENV_MODE",
  "env_files": ${ENV_FILES_JSON}
}
EOF
