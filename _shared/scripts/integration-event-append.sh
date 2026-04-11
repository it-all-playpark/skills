#!/usr/bin/env bash
# integration-event-append.sh - Append an integration feedback event.
#
# Cross-run knowledge base for dev-integrate conflicts. Consumed by
# dev-decompose --dry-run and dev-flow-doctor. See
# _shared/references/integration-feedback.md for the full pattern.
#
# Concurrent-safe via mkdir-based file lock (same strategy as
# _shared/scripts/flow-append-finding.sh).
#
# Usage:
#   integration-event-append.sh --source-issue N --event-type TYPE \
#                               --files F1,F2 \
#                               [--feedback-file PATH] \
#                               [--subtask-pair A,B] \
#                               [--resolution RES] \
#                               [--lesson TEXT] \
#                               [--max-events N]
#
# event-type: conflict | integration_failure | cross_subtask_dependency
# resolution: manual_merge | auto_resolved | re_decompose | restart | unresolved
#
# Defaults:
#   --feedback-file = $SKILLS_DIR/_shared/integration-feedback.json
#   --max-events    = 500 (override with $INTEGRATION_FEEDBACK_MAX_EVENTS env or config)
#
# On success prints: {"status":"appended","event_id":"ev_NNN"}
# On any failure this script exits non-zero but callers should treat append
# as best-effort: the caller must not abort its own pipeline on failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

FEEDBACK_FILE=""
SOURCE_ISSUE=""
EVENT_TYPE=""
FILES_CSV=""
SUBTASK_PAIR_CSV=""
RESOLUTION=""
LESSON=""
MAX_EVENTS=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --feedback-file) FEEDBACK_FILE="$2"; shift 2 ;;
        --source-issue) SOURCE_ISSUE="$2"; shift 2 ;;
        --event-type) EVENT_TYPE="$2"; shift 2 ;;
        --files) FILES_CSV="$2"; shift 2 ;;
        --subtask-pair) SUBTASK_PAIR_CSV="$2"; shift 2 ;;
        --resolution) RESOLUTION="$2"; shift 2 ;;
        --lesson) LESSON="$2"; shift 2 ;;
        --max-events) MAX_EVENTS="$2"; shift 2 ;;
        -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

# Resolve defaults
if [[ -z "$FEEDBACK_FILE" ]]; then
    FEEDBACK_FILE="$SKILLS_DIR/_shared/integration-feedback.json"
fi

if [[ -z "$MAX_EVENTS" ]]; then
    MAX_EVENTS="${INTEGRATION_FEEDBACK_MAX_EVENTS:-500}"
fi

[[ -n "$SOURCE_ISSUE" ]] || die_json "--source-issue required" 1
[[ -n "$EVENT_TYPE" ]]   || die_json "--event-type required" 1
[[ -n "$FILES_CSV" ]]    || die_json "--files required" 1

# Validate source_issue is numeric
[[ "$SOURCE_ISSUE" =~ ^[0-9]+$ ]] || die_json "--source-issue must be a positive integer" 1

# Validate enums
VALID_TYPES="conflict integration_failure cross_subtask_dependency"
if ! echo "$VALID_TYPES" | grep -qw "$EVENT_TYPE"; then
    die_json "Invalid --event-type: $EVENT_TYPE. Valid: $VALID_TYPES" 1
fi

if [[ -n "$RESOLUTION" ]]; then
    VALID_RESOLUTIONS="manual_merge auto_resolved re_decompose restart unresolved"
    if ! echo "$VALID_RESOLUTIONS" | grep -qw "$RESOLUTION"; then
        die_json "Invalid --resolution: $RESOLUTION. Valid: $VALID_RESOLUTIONS" 1
    fi
fi

# Validate max_events
[[ "$MAX_EVENTS" =~ ^[0-9]+$ ]] || die_json "--max-events must be a non-negative integer" 1

# Convert CSVs to JSON arrays (empty input -> [])
csv_to_json_array() {
    local csv="$1"
    if [[ -z "$csv" ]]; then
        printf '[]'
    else
        printf '%s' "$csv" | tr ',' '\n' | jq -R 'select(length > 0)' | jq -s '.'
    fi
}

FILES_JSON=$(csv_to_json_array "$FILES_CSV")
if [[ "$(echo "$FILES_JSON" | jq 'length')" -eq 0 ]]; then
    die_json "--files must contain at least one non-empty entry" 1
fi

SUBTASK_PAIR_JSON=$(csv_to_json_array "$SUBTASK_PAIR_CSV")

# Initialize feedback file if missing or invalid
mkdir -p "$(dirname "$FEEDBACK_FILE")"
if [[ ! -f "$FEEDBACK_FILE" ]] || ! jq empty "$FEEDBACK_FILE" >/dev/null 2>&1; then
    echo '{"version":"1.0.0","events":[]}' > "$FEEDBACK_FILE"
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOCK_DIR="${FEEDBACK_FILE}.lockdir"

# Acquire lock (mkdir-based, portable across mac/linux without flock)
LOCK_ACQUIRED=0
for _ in $(seq 1 60); do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        LOCK_ACQUIRED=1
        break
    fi
    sleep 0.1
done
[[ "$LOCK_ACQUIRED" -eq 1 ]] || die_json "Could not acquire lock on $FEEDBACK_FILE (timeout)" 2
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# Compute next id under the lock
NEXT_NUM=$(jq '
  (.events // [])
  | map(.id // "ev_000" | ltrimstr("ev_") | tonumber? // 0)
  | (max // 0) + 1
' "$FEEDBACK_FILE")
EVENT_ID=$(printf 'ev_%03d' "$NEXT_NUM")

TMP=$(mktemp)
trap 'rm -f "$TMP"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

jq \
    --arg id "$EVENT_ID" \
    --arg ts "$NOW" \
    --argjson src "$SOURCE_ISSUE" \
    --arg etype "$EVENT_TYPE" \
    --argjson files "$FILES_JSON" \
    --argjson pair "$SUBTASK_PAIR_JSON" \
    --arg resolution "$RESOLUTION" \
    --arg lesson "$LESSON" \
    --argjson max "$MAX_EVENTS" \
    '
    # Ensure top-level shape
    .version = (.version // "1.0.0")
    | .events = (.events // [])
    | .events += [
        ({
            id: $id,
            timestamp: $ts,
            source_issue: $src,
            event_type: $etype,
            files: $files,
            subtask_pair: $pair
        }
        + (if $resolution == "" then {} else {resolution: $resolution} end)
        + (if $lesson == "" then {} else {lesson: $lesson} end))
      ]
    # Trim: keep only the most recent $max events
    | .events = (if ($max > 0 and ((.events | length) > $max))
                 then .events[-($max):]
                 else .events end)
    ' "$FEEDBACK_FILE" > "$TMP"

mv "$TMP" "$FEEDBACK_FILE"

printf '{"status":"appended","event_id":"%s"}\n' "$EVENT_ID"
