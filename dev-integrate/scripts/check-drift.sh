#!/usr/bin/env bash
# check-drift.sh - Detect planned vs actual file changes
# Usage: check-drift.sh --flow-state PATH

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

FLOW_STATE=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: check-drift.sh --flow-state PATH"
            exit 0
            ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

[[ -n "$FLOW_STATE" ]] || die_json "flow.json path required (--flow-state)" 1
[[ -f "$FLOW_STATE" ]] || die_json "flow.json not found at: $FLOW_STATE" 1

# ============================================================================
# Compare planned vs actual files for each subtask
# ============================================================================

DRIFT_RESULTS=$(jq -c '
  [.subtasks[] | {
    id: .id,
    scope: (.scope // ""),
    planned: (.files // []),
    actual: (.actual_files_changed // []),
    has_actual: ((.actual_files_changed // null) != null)
  } | . + {
    # Files in actual but not in planned (unexpected changes)
    additions: ([.actual[] | select(. as $f | (.planned | index($f)) == null)] // []),
    # Files in planned but not in actual (missing changes)
    missing: ([.planned[] | select(. as $f | (.actual | index($f)) == null)] // []),
    # Files in both (expected changes)
    matched: ([.actual[] | select(. as $f | (.planned | index($f)) != null)] // [])
  } | {
    id: .id,
    scope: .scope,
    has_actual: .has_actual,
    planned_count: (.planned | length),
    actual_count: (.actual | length),
    additions: .additions,
    missing: .missing,
    matched: .matched,
    has_drift: ((.additions | length) > 0 or (.missing | length) > 0)
  }]
' "$FLOW_STATE")

# ============================================================================
# Compute summary
# ============================================================================

TOTAL_SUBTASKS=$(echo "$DRIFT_RESULTS" | jq 'length')
SUBTASKS_WITH_DRIFT=$(echo "$DRIFT_RESULTS" | jq '[.[] | select(.has_drift)] | length')
SUBTASKS_NO_ACTUAL=$(echo "$DRIFT_RESULTS" | jq '[.[] | select(.has_actual | not)] | length')
TOTAL_ADDITIONS=$(echo "$DRIFT_RESULTS" | jq '[.[].additions | length] | add // 0')
TOTAL_MISSING=$(echo "$DRIFT_RESULTS" | jq '[.[].missing | length] | add // 0')

# Determine overall drift status
if [[ "$SUBTASKS_WITH_DRIFT" -gt 0 ]]; then
    DRIFT_STATUS="drift_detected"
elif [[ "$SUBTASKS_NO_ACTUAL" -gt 0 ]]; then
    DRIFT_STATUS="incomplete_data"
else
    DRIFT_STATUS="no_drift"
fi

# ============================================================================
# Output drift report
# ============================================================================

jq -n \
    --arg status "$DRIFT_STATUS" \
    --argjson total "$TOTAL_SUBTASKS" \
    --argjson with_drift "$SUBTASKS_WITH_DRIFT" \
    --argjson no_actual "$SUBTASKS_NO_ACTUAL" \
    --argjson total_additions "$TOTAL_ADDITIONS" \
    --argjson total_missing "$TOTAL_MISSING" \
    --argjson subtasks "$DRIFT_RESULTS" \
    '{
        status: $status,
        summary: {
            total_subtasks: $total,
            subtasks_with_drift: $with_drift,
            subtasks_missing_actual_data: $no_actual,
            total_unexpected_files: $total_additions,
            total_missing_files: $total_missing
        },
        subtasks: $subtasks
    }'
