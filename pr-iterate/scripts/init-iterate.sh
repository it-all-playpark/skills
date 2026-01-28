#!/usr/bin/env bash
# init-iterate.sh - Initialize iterate state file
# Usage: init-iterate.sh <pr-number-or-url> [--max-iterations N] [--worktree PATH]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq
require_gh_auth

PR_INPUT=""
MAX_ITERATIONS=10
WORKTREE=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --max-iterations) MAX_ITERATIONS="$2"; shift 2 ;;
        --worktree) WORKTREE="$2"; shift 2 ;;
        -*)
            die_json "Unknown option: $1" 1
            ;;
        *)
            if [[ -z "$PR_INPUT" ]]; then
                PR_INPUT="$1"
            fi
            shift
            ;;
    esac
done

[[ -n "$PR_INPUT" ]] || die_json "PR number or URL required" 1

# Validate MAX_ITERATIONS is numeric
if ! [[ "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
    die_json "Max iterations must be a positive integer" 1
fi

# Extract PR number from URL if needed
if [[ "$PR_INPUT" =~ ^https?:// ]]; then
    PR_NUMBER=$(echo "$PR_INPUT" | grep -oE '[0-9]+$')
    PR_URL="$PR_INPUT"
else
    PR_NUMBER="$PR_INPUT"
    PR_URL=""
fi

# Validate PR_NUMBER is numeric
if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
    die_json "PR number must be a positive integer" 1
fi

# Get PR info from GitHub
PR_INFO=$(gh pr view "$PR_NUMBER" --json number,headRefName,baseRefName,url 2>/dev/null) || \
    die_json "Failed to fetch PR #$PR_NUMBER info" 1

PR_NUMBER=$(echo "$PR_INFO" | jq -r '.number')
BRANCH=$(echo "$PR_INFO" | jq -r '.headRefName')
BASE_BRANCH=$(echo "$PR_INFO" | jq -r '.baseRefName')
[[ -z "$PR_URL" ]] && PR_URL=$(echo "$PR_INFO" | jq -r '.url')

# Determine state file location (Priority: --worktree > kickoff.json auto-detect > current dir)
WORKTREE_PATH=""
if [[ -n "$WORKTREE" ]]; then
    # Explicit --worktree provided
    [[ -d "$WORKTREE" ]] || die_json "Worktree path does not exist: $WORKTREE" 1
    WORKTREE_PATH=$(cd "$WORKTREE" && pwd) || die_json "Cannot resolve worktree path" 1
else
    # Try to auto-detect from kickoff.json
    GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    if [[ -n "$GIT_ROOT" && -f "$GIT_ROOT/.claude/kickoff.json" ]]; then
        # Extract worktree path from kickoff.json
        DETECTED_WORKTREE=$(jq -r '.worktree // empty' "$GIT_ROOT/.claude/kickoff.json" 2>/dev/null || echo "")
        if [[ -n "$DETECTED_WORKTREE" && -d "$DETECTED_WORKTREE" ]]; then
            WORKTREE_PATH="$DETECTED_WORKTREE"
        fi
    fi

    # Fallback to current git root
    if [[ -z "$WORKTREE_PATH" ]]; then
        [[ -n "$GIT_ROOT" ]] || die_json "Not in a git repository and no worktree specified" 1
        WORKTREE_PATH="$GIT_ROOT"
    fi
fi

STATE_DIR="$WORKTREE_PATH/.claude"

mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/iterate.json"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Create initial state using jq to prevent JSON injection
jq -n \
    --argjson pr_number "$PR_NUMBER" \
    --arg pr_url "$PR_URL" \
    --arg branch "$BRANCH" \
    --arg base_branch "$BASE_BRANCH" \
    --arg worktree_path "$WORKTREE_PATH" \
    --arg now "$NOW" \
    --argjson max_iterations "$MAX_ITERATIONS" \
    '{
        version: "1.0",
        pr_number: $pr_number,
        pr_url: $pr_url,
        branch: $branch,
        base_branch: $base_branch,
        worktree_path: $worktree_path,
        started_at: $now,
        updated_at: $now,
        current_iteration: 1,
        max_iterations: $max_iterations,
        status: "in_progress",
        iterations: [
            {
                number: 1,
                started_at: $now,
                review: { decision: "pending" },
                ci_status: "pending"
            }
        ],
        next_actions: ["Run pr-review"]
    }' > "$STATE_FILE"

echo "{\"status\":\"initialized\",\"state_file\":\"$STATE_FILE\",\"pr_number\":$PR_NUMBER}"