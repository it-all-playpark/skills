#!/usr/bin/env bash
# update-feature.sh - Update feature_list[i].status in kickoff.json.
# id and desc are immutable — this script only modifies status.
# Usage: update-feature.sh --worktree PATH --id F1 --status done

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

WORKTREE=""
FEATURE_ID=""
NEW_STATUS=""

VALID_STATUSES="todo in_progress done skipped"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree) WORKTREE="$2"; shift 2 ;;
        --id) FEATURE_ID="$2"; shift 2 ;;
        --status) NEW_STATUS="$2"; shift 2 ;;
        -*) die_json "Unknown option: $1" 1 ;;
        *) die_json "Unexpected positional arg: $1" 1 ;;
    esac
done

[[ -n "$WORKTREE" ]]   || die_json "--worktree required" 1
[[ -n "$FEATURE_ID" ]] || die_json "--id required" 1
[[ -n "$NEW_STATUS" ]] || die_json "--status required" 1

if ! echo "$VALID_STATUSES" | grep -qw "$NEW_STATUS"; then
    die_json "Invalid status: $NEW_STATUS. Must be one of: $VALID_STATUSES" 1
fi

[[ -d "$WORKTREE" ]] || die_json "Worktree path does not exist: $WORKTREE" 1
WORKTREE=$(cd "$WORKTREE" && pwd) || die_json "Cannot resolve worktree path" 1

STATE_FILE="$WORKTREE/.claude/kickoff.json"
[[ -f "$STATE_FILE" ]] || die_json "kickoff.json not found: $STATE_FILE" 1

# Verify feature id exists
if ! jq -e --arg id "$FEATURE_ID" '(.feature_list // []) | map(select(.id == $id)) | length > 0' "$STATE_FILE" > /dev/null; then
    die_json "Feature id not found: $FEATURE_ID" 1
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

TMP_FILE=$(mktemp)
if jq \
    --arg id "$FEATURE_ID" \
    --arg status "$NEW_STATUS" \
    --arg now "$NOW" \
    '.feature_list = ((.feature_list // []) | map(
        if .id == $id then .status = $status else . end
     ))
     | .updated_at = $now' \
    "$STATE_FILE" > "$TMP_FILE"; then
    mv "$TMP_FILE" "$STATE_FILE"
    echo "{\"status\":\"updated\",\"id\":\"$FEATURE_ID\",\"new_status\":\"$NEW_STATUS\"}"
else
    rm -f "$TMP_FILE"
    die_json "Failed to update feature" 1
fi
