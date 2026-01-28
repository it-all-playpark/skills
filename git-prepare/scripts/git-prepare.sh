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

# Create worktrees directory
mkdir -p "$WORKTREE_BASE"

# Fetch latest
git fetch origin "$BASE_BRANCH" 2>/dev/null || true

# Check if worktree already exists
if [[ -d "$WORKTREE_PATH" ]]; then
    echo "{\"status\":\"exists\",\"worktree_path\":\"$WORKTREE_PATH\",\"branch\":\"$BRANCH_NAME\"}"
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

# Setup environment files
setup_env_files() {
    local mode="$1"
    local env_files=()

    if [[ "$mode" == "none" ]]; then
        return
    fi

    # Find all .env* files, excluding node_modules, .git, and worktrees
    while IFS= read -r -d '' env_file; do
        env_files+=("$env_file")
    done < <(find "$REPO_ROOT" -name ".env*" -type f \
        -not -path "*/node_modules/*" \
        -not -path "*/.git/*" \
        -not -path "*-worktrees/*" \
        -print0 2>/dev/null)

    for env_file in "${env_files[@]}"; do
        relative_path="${env_file#$REPO_ROOT/}"
        target_path="$WORKTREE_PATH/$relative_path"
        target_dir=$(dirname "$target_path")

        mkdir -p "$target_dir"

        case "$mode" in
            hardlink)
                if ln "$env_file" "$target_path" 2>/dev/null; then
                    echo "hardlink:$relative_path"
                else
                    cp "$env_file" "$target_path"
                    echo "copy:$relative_path"
                fi
                ;;
            symlink)
                ln -sf "$env_file" "$target_path"
                echo "symlink:$relative_path"
                ;;
            copy)
                cp "$env_file" "$target_path"
                echo "copy:$relative_path"
                ;;
        esac
    done
}

# Capture env setup output
ENV_RESULTS=$(setup_env_files "$ENV_MODE")

# Output JSON result
cat <<EOF
{
  "status": "created",
  "worktree_path": "$WORKTREE_PATH",
  "branch": "$BRANCH_NAME",
  "base": "origin/$BASE_BRANCH",
  "env_mode": "$ENV_MODE",
  "env_files": [$(echo "$ENV_RESULTS" | sed 's/^/"/;s/$/"/' | paste -sd, - 2>/dev/null || echo "")]
}
EOF
