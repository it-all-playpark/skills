#!/usr/bin/env bash
# check-resume.sh - Check if iterate state needs re-initialization
# Detects new commits pushed after LGTM completion.
# Usage: check-resume.sh [--worktree PATH]
# Exit: 0 = safe to resume, 1 = needs re-init (new commits after LGTM)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq
require_cmd git

WORKTREE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree) WORKTREE="$2"; shift 2 ;;
        *) shift ;;
    esac
done

# Find state file (same priority as record-iteration.sh)
if [[ -n "$WORKTREE" ]]; then
    [[ -d "$WORKTREE" ]] || die_json "Worktree path does not exist: $WORKTREE" 1
    WORKTREE=$(cd "$WORKTREE" && pwd)
    STATE_FILE="$WORKTREE/.claude/iterate.json"
else
    GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    if [[ -n "$GIT_ROOT" && -f "$GIT_ROOT/.claude/iterate.json" ]]; then
        STATE_FILE="$GIT_ROOT/.claude/iterate.json"
        WORKTREE="$GIT_ROOT"
    elif [[ -n "$GIT_ROOT" && -f "$GIT_ROOT/.claude/kickoff.json" ]]; then
        DETECTED_WORKTREE=$(jq -r '.worktree // empty' "$GIT_ROOT/.claude/kickoff.json" 2>/dev/null || echo "")
        if [[ -n "$DETECTED_WORKTREE" && -f "$DETECTED_WORKTREE/.claude/iterate.json" ]]; then
            STATE_FILE="$DETECTED_WORKTREE/.claude/iterate.json"
            WORKTREE="$DETECTED_WORKTREE"
        else
            echo '{"status":"no_state","message":"No iterate.json found"}'
            exit 0
        fi
    else
        echo '{"status":"no_state","message":"No iterate.json found"}'
        exit 0
    fi
fi

[[ -f "$STATE_FILE" ]] || { echo '{"status":"no_state","message":"No iterate.json found"}'; exit 0; }

STATUS=$(jq -r '.status' "$STATE_FILE")
UPDATED_AT=$(jq -r '.updated_at' "$STATE_FILE")
BRANCH=$(jq -r '.branch' "$STATE_FILE")
PR_NUMBER=$(jq -r '.pr_number' "$STATE_FILE")

# Only check for post-LGTM commits if status is terminal
if [[ "$STATUS" != "lgtm" && "$STATUS" != "max_reached" && "$STATUS" != "failed" ]]; then
    echo "{\"status\":\"in_progress\",\"action\":\"resume\",\"current_iteration\":$(jq -r '.current_iteration' "$STATE_FILE")}"
    exit 0
fi

# Check for commits after LGTM timestamp
cd "$WORKTREE"
NEW_COMMITS=$(git log --oneline --after="$UPDATED_AT" "$BRANCH" 2>/dev/null | wc -l | tr -d ' ')

if [[ "$NEW_COMMITS" -gt 0 ]]; then
    COMMIT_LIST=$(git log --oneline --after="$UPDATED_AT" "$BRANCH" 2>/dev/null | head -5)
    jq -n \
        --arg status "stale_lgtm" \
        --arg prev_status "$STATUS" \
        --arg updated_at "$UPDATED_AT" \
        --argjson new_commits "$NEW_COMMITS" \
        --argjson pr_number "$PR_NUMBER" \
        --arg commits "$COMMIT_LIST" \
        --arg message "LGTM state is stale: $NEW_COMMITS new commit(s) found after $UPDATED_AT. Re-initialize with init-iterate.sh." \
        '{status: $status, prev_status: $prev_status, updated_at: $updated_at, new_commits: $new_commits, pr_number: $pr_number, recent_commits: $commits, message: $message}'
    exit 1
else
    jq -n \
        --arg status "$STATUS" \
        --argjson pr_number "$PR_NUMBER" \
        --arg message "No new commits since $STATUS. State is current." \
        '{status: $status, pr_number: $pr_number, message: $message}'
    exit 0
fi
