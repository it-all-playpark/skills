#!/usr/bin/env bash
# flow-read-findings.sh - Read shared findings from flow.json.
#
# Usage:
#   flow-read-findings.sh --flow-state PATH
#   flow-read-findings.sh --flow-state PATH --task-id ID --unacked-only
#   flow-read-findings.sh --flow-state PATH --task-id ID --unacked-only --ack
#
# --unacked-only filters out findings where either:
#   - the given task_id already appears in acknowledged_by, OR
#   - the finding was authored by the given task_id itself.
#
# --ack (requires --task-id) atomically appends task_id to acknowledged_by for
# every finding returned by the query. Useful for "read-and-consume" flow in
# dev-plan-impl.
#
# Output: JSON array of finding objects (possibly empty).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

FLOW_STATE=""
TASK_ID=""
UNACKED_ONLY=0
DO_ACK=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        --task-id) TASK_ID="$2"; shift 2 ;;
        --unacked-only) UNACKED_ONLY=1; shift ;;
        --ack) DO_ACK=1; shift ;;
        -h|--help) sed -n '1,20p' "$0"; exit 0 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

[[ -n "$FLOW_STATE" ]] || die_json "--flow-state required" 1
[[ -f "$FLOW_STATE" ]] || die_json "flow.json not found at: $FLOW_STATE" 1

if [[ "$DO_ACK" -eq 1 ]]; then
    [[ -n "$TASK_ID" ]] || die_json "--ack requires --task-id" 1
fi

# Query: filter findings according to flags.
QUERY='(.shared_findings // [])'
if [[ "$UNACKED_ONLY" -eq 1 ]]; then
    [[ -n "$TASK_ID" ]] || die_json "--unacked-only requires --task-id" 1
    QUERY="$QUERY | map(select(
        (.task_id != \$tid) and
        ((.acknowledged_by // []) | index(\$tid) | not)
    ))"
fi

RESULT=$(jq --arg tid "$TASK_ID" "$QUERY" "$FLOW_STATE")

if [[ "$DO_ACK" -eq 1 ]]; then
    # Acquire lock, append task_id to acknowledged_by for each finding we just
    # returned, then write back.
    LOCK_DIR="${FLOW_STATE}.lockdir"
    LOCK_ACQUIRED=0
    for _ in $(seq 1 60); do
        if mkdir "$LOCK_DIR" 2>/dev/null; then
            LOCK_ACQUIRED=1
            break
        fi
        sleep 0.1
    done
    [[ "$LOCK_ACQUIRED" -eq 1 ]] || die_json "Could not acquire lock on $FLOW_STATE" 2
    trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

    IDS_JSON=$(echo "$RESULT" | jq '[.[].id]')
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    TMP=$(mktemp)
    trap 'rm -f "$TMP"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

    jq \
        --arg tid "$TASK_ID" \
        --argjson ids "$IDS_JSON" \
        --arg now "$NOW" \
        '
        .shared_findings = ((.shared_findings // []) | map(
            if (.id as $id | $ids | index($id)) then
                .acknowledged_by = (((.acknowledged_by // []) + [$tid]) | unique)
            else
                .
            end
        ))
        | .updated_at = $now
        ' "$FLOW_STATE" > "$TMP"

    mv "$TMP" "$FLOW_STATE"
fi

echo "$RESULT"
