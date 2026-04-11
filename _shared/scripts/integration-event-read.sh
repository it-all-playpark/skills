#!/usr/bin/env bash
# integration-event-read.sh - Read integration feedback events with optional filters.
#
# Companion to integration-event-append.sh. Used by dev-decompose --dry-run
# (to incorporate past-conflict hints) and dev-flow-doctor (to detect
# recurring conflict patterns).
#
# Usage:
#   integration-event-read.sh [--feedback-file PATH] [--limit N] \
#                             [--event-type TYPE] [--source-issue N] \
#                             [--file-prefix PREFIX]
#
# Defaults:
#   --feedback-file = $SKILLS_DIR/_shared/integration-feedback.json
#   --limit         = 20  (most recent N events)
#   no filters      = return all events (up to --limit)
#
# Output: JSON array of event objects, ordered most-recent-first.
# A missing/invalid/empty feedback file always yields [] (never errors).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

FEEDBACK_FILE=""
LIMIT=20
EVENT_TYPE=""
SOURCE_ISSUE=""
FILE_PREFIX=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --feedback-file) FEEDBACK_FILE="$2"; shift 2 ;;
        --limit) LIMIT="$2"; shift 2 ;;
        --event-type) EVENT_TYPE="$2"; shift 2 ;;
        --source-issue) SOURCE_ISSUE="$2"; shift 2 ;;
        --file-prefix) FILE_PREFIX="$2"; shift 2 ;;
        -h|--help) sed -n '1,25p' "$0"; exit 0 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

if [[ -z "$FEEDBACK_FILE" ]]; then
    FEEDBACK_FILE="$SKILLS_DIR/_shared/integration-feedback.json"
fi

[[ "$LIMIT" =~ ^[0-9]+$ ]] || die_json "--limit must be a non-negative integer" 1

# Missing/invalid file -> empty array (best-effort read)
if [[ ! -f "$FEEDBACK_FILE" ]] || ! jq empty "$FEEDBACK_FILE" >/dev/null 2>&1; then
    echo '[]'
    exit 0
fi

# Apply filters, take most-recent-first, cap at LIMIT
jq \
    --arg etype "$EVENT_TYPE" \
    --arg src "$SOURCE_ISSUE" \
    --arg prefix "$FILE_PREFIX" \
    --argjson limit "$LIMIT" \
    '
    (.events // [])
    | reverse
    | map(select(
        ($etype == "" or .event_type == $etype)
        and ($src == "" or (.source_issue | tostring) == $src)
        and ($prefix == "" or ((.files // []) | any(startswith($prefix))))
      ))
    | .[0:$limit]
    ' "$FEEDBACK_FILE"
