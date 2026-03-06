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

# Helper: run sync-env if available, otherwise skip with warning
run_sync_env() {
    local worktree="$1" source="$2" mode="$3" force_flag="${4:-}"
    if [[ "$mode" == "none" ]]; then
        echo '{"status":"skipped","mode":"none","files_synced":[],"total_synced":0}'
        return
    fi
    if [[ -x "$SYNC_ENV" ]]; then
        "$SYNC_ENV" --worktree "$worktree" --source "$source" --mode "$mode" $force_flag
    else
        echo "Warning: sync-env.sh not found, skipping env sync" >&2
        echo '{"status":"skipped","mode":"'"$mode"'","files_synced":[],"total_synced":0}'
    fi
}

# Check if worktree already exists
if [[ -d "$WORKTREE_PATH" ]]; then
    # Sync .env files even for existing worktrees (without --force to skip existing)
    ENV_RESULT=$(run_sync_env "$WORKTREE_PATH" "$REPO_ROOT" "$ENV_MODE")
    ENV_SYNC_JSON=$(echo "$ENV_RESULT" | jq -c '{status: .status, files_synced: .files_synced, total_synced: .total_synced}' 2>/dev/null || echo '{"status":"unknown"}')
    jq -n \
        --arg worktree_path "$WORKTREE_PATH" \
        --arg branch "$BRANCH_NAME" \
        --arg env_mode "$ENV_MODE" \
        --argjson env_sync "$ENV_SYNC_JSON" \
        '{status: "exists", worktree_path: $worktree_path, branch: $branch, env_mode: $env_mode, env_sync: $env_sync}'
    exit 0
fi

# Check if branch exists locally
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
    # Branch exists, use it
    git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
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

# Sync environment files via sync-env skill (--force for new worktrees)
ENV_RESULT=$(run_sync_env "$WORKTREE_PATH" "$REPO_ROOT" "$ENV_MODE" "--force")

# Extract env_files array from sync-env result using jq
ENV_FILES_JSON=$(echo "$ENV_RESULT" | jq -c '.files_synced' 2>/dev/null || echo '[]')

# Output JSON result
jq -n \
    --arg worktree_path "$WORKTREE_PATH" \
    --arg branch "$BRANCH_NAME" \
    --arg base "origin/$BASE_BRANCH" \
    --arg env_mode "$ENV_MODE" \
    --argjson env_files "$ENV_FILES_JSON" \
    '{status: "created", worktree_path: $worktree_path, branch: $branch, base: $base, env_mode: $env_mode, env_files: $env_files}'
