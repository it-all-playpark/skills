#!/usr/bin/env bash
# flow-append-finding.sh - Append a shared finding to flow.json (Shared State pattern).
#
# Concurrent-safe: uses `flock` when available, falls back to a `mkdir` lockdir.
# Worker processes (parallel dev-kickoff instances) may call this directly
# without going through the dev-flow orchestrator.
#
# Usage:
#   flow-append-finding.sh --flow-state PATH --task-id ID \
#                          --category CAT --title TEXT \
#                          [--description TEXT] [--scope F1,F2] \
#                          [--action-required TEXT]
#
# Categories: breaking_change | api_contract | design_decision | dependency
#
# Output: {"status":"appended","finding_id":"sf_NNN"}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

FLOW_STATE=""
TASK_ID=""
CATEGORY=""
TITLE=""
DESCRIPTION=""
SCOPE_CSV=""
ACTION_REQUIRED=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        --task-id) TASK_ID="$2"; shift 2 ;;
        --category) CATEGORY="$2"; shift 2 ;;
        --title) TITLE="$2"; shift 2 ;;
        --description) DESCRIPTION="$2"; shift 2 ;;
        --scope) SCOPE_CSV="$2"; shift 2 ;;
        --action-required) ACTION_REQUIRED="$2"; shift 2 ;;
        -h|--help)
            sed -n '1,20p' "$0"; exit 0 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

[[ -n "$FLOW_STATE" ]] || die_json "--flow-state required" 1
[[ -f "$FLOW_STATE" ]] || die_json "flow.json not found at: $FLOW_STATE" 1
[[ -n "$TASK_ID"    ]] || die_json "--task-id required" 1
[[ -n "$CATEGORY"   ]] || die_json "--category required" 1
[[ -n "$TITLE"      ]] || die_json "--title required" 1

VALID_CATS="breaking_change api_contract design_decision dependency"
if ! echo "$VALID_CATS" | grep -qw "$CATEGORY"; then
    die_json "Invalid category: $CATEGORY. Valid: $VALID_CATS" 1
fi

# Convert comma-separated scope to JSON array (empty string -> []).
if [[ -n "$SCOPE_CSV" ]]; then
    SCOPE_JSON=$(printf '%s' "$SCOPE_CSV" | tr ',' '\n' | jq -R . | jq -s '.')
else
    SCOPE_JSON='[]'
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOCK_DIR="${FLOW_STATE}.lockdir"

# Acquire lock (mkdir-based, portable across mac/linux without flock).
LOCK_ACQUIRED=0
for _ in $(seq 1 60); do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        LOCK_ACQUIRED=1
        break
    fi
    sleep 0.1
done
[[ "$LOCK_ACQUIRED" -eq 1 ]] || die_json "Could not acquire lock on $FLOW_STATE (timeout)" 2
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# Compute next id under the lock.
NEXT_NUM=$(jq '
  (.shared_findings // [])
  | map(.id // "sf_000" | ltrimstr("sf_") | tonumber? // 0)
  | (max // 0) + 1
' "$FLOW_STATE")
FINDING_ID=$(printf 'sf_%03d' "$NEXT_NUM")

TMP=$(mktemp)
trap 'rm -f "$TMP"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

jq \
    --arg id "$FINDING_ID" \
    --arg task "$TASK_ID" \
    --arg ts "$NOW" \
    --arg cat "$CATEGORY" \
    --arg title "$TITLE" \
    --arg desc "$DESCRIPTION" \
    --arg action "$ACTION_REQUIRED" \
    --argjson scope "$SCOPE_JSON" \
    --arg now "$NOW" \
    '
    .shared_findings = (.shared_findings // [])
    | .shared_findings += [{
        id: $id,
        task_id: $task,
        timestamp: $ts,
        category: $cat,
        scope: $scope,
        title: $title,
        description: $desc,
        action_required: $action,
        acknowledged_by: []
      }]
    | .updated_at = $now
    ' "$FLOW_STATE" > "$TMP"

mv "$TMP" "$FLOW_STATE"

printf '{"status":"appended","finding_id":"%s"}\n' "$FINDING_ID"
