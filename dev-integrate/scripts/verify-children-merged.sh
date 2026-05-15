#!/usr/bin/env bash
# verify-children-merged.sh - Verify all child issues are completed in flow.json v2
#
# Reads v2 flow.json and checks that every child has status == "completed".
# Used by dev-integrate Step 2 (post-child-merge verification).
#
# Usage: verify-children-merged.sh --flow-state PATH
# Returns JSON: {status, total, completed, incomplete: [...]}
# Exit codes: 0 = all complete, 1 = any incomplete or error

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

FLOW_STATE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: verify-children-merged.sh --flow-state PATH"
            exit 0
            ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

[[ -n "$FLOW_STATE" ]] || die_json "--flow-state is required" 1
[[ -f "$FLOW_STATE" ]] || die_json "flow.json not found: $FLOW_STATE" 1

VERSION=$(jq -r '.version // empty' "$FLOW_STATE")
if [[ "$VERSION" != "2.0.0" ]]; then
    die_json "flow.json schema version must be 2.0.0 (got: \"$VERSION\"). v1 is not supported (no-backcompat)." 1
fi

TOTAL=$(jq '.children | length' "$FLOW_STATE")
COMPLETED=$(jq '[.children[] | select(.status == "completed")] | length' "$FLOW_STATE")
INCOMPLETE_JSON=$(jq -c '[.children[] | select(.status != "completed") | {issue, slug, status, error: (.error // null)}]' "$FLOW_STATE")
INCOMPLETE_COUNT=$(echo "$INCOMPLETE_JSON" | jq 'length')

if [[ "$INCOMPLETE_COUNT" -eq 0 ]]; then
    STATUS="all_complete"
    EXIT=0
else
    STATUS="incomplete"
    EXIT=1
fi

jq -n \
    --arg status "$STATUS" \
    --argjson total "$TOTAL" \
    --argjson completed "$COMPLETED" \
    --argjson incomplete "$INCOMPLETE_JSON" \
    '{
        status: $status,
        total: $total,
        completed: $completed,
        incomplete_count: ($incomplete | length),
        incomplete: $incomplete
    }'

exit $EXIT
