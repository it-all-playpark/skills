#!/usr/bin/env bash
# append-progress.sh - Append entry to kickoff.json progress_log (append-only).
# Usage: append-progress.sh --worktree PATH --phase PHASE --note TEXT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

WORKTREE=""
PHASE=""
NOTE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree) WORKTREE="$2"; shift 2 ;;
        --phase) PHASE="$2"; shift 2 ;;
        --note) NOTE="$2"; shift 2 ;;
        -*) die_json "Unknown option: $1" 1 ;;
        *) die_json "Unexpected positional arg: $1" 1 ;;
    esac
done

[[ -n "$WORKTREE" ]] || die_json "--worktree required" 1
[[ -n "$PHASE" ]]    || die_json "--phase required" 1
[[ -n "$NOTE" ]]     || die_json "--note required" 1

[[ -d "$WORKTREE" ]] || die_json "Worktree path does not exist: $WORKTREE" 1
WORKTREE=$(cd "$WORKTREE" && pwd) || die_json "Cannot resolve worktree path" 1

STATE_FILE="$WORKTREE/.claude/kickoff.json"
[[ -f "$STATE_FILE" ]] || die_json "kickoff.json not found: $STATE_FILE" 1

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

TMP_FILE=$(mktemp)
if jq \
    --arg ts "$NOW" \
    --arg phase "$PHASE" \
    --arg note "$NOTE" \
    '.progress_log = ((.progress_log // []) + [{ts: $ts, phase: $phase, note: $note}])
     | .updated_at = $ts' \
    "$STATE_FILE" > "$TMP_FILE"; then
    mv "$TMP_FILE" "$STATE_FILE"
    echo "{\"status\":\"appended\",\"phase\":\"$PHASE\"}"
else
    rm -f "$TMP_FILE"
    die_json "Failed to append progress" 1
fi
