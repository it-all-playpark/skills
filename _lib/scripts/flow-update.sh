#!/usr/bin/env bash
# flow-update.sh - Update v2 flow.json state
# IMPORTANT: Single-writer design. Must only be called sequentially from the
# dev-flow orchestrator. v2 schema (child-split) only.
#
# Usage: flow-update.sh --flow-state PATH <action> [options]
#
# Actions:
#   status <new-status>
#       Update overall flow status (decomposing | running | integrated | failed)
#   child <issue> --status <status>
#       Update child status (pending | running | completed | failed)
#   child <issue> --pr <number> --pr-url <url>
#       Record child PR info
#   child <issue> --merged-at <iso>
#       Mark child as merged into integration branch
#   child <issue> --error <message>
#       Record per-child error
#   final-pr --number N --url URL
#       Record final integration PR info

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common.sh"

require_cmd jq

FLOW_STATE=""
TMP_FILES=()
cleanup_tmp() { for f in "${TMP_FILES[@]}"; do rm -f "$f" 2>/dev/null; done; }
trap cleanup_tmp EXIT

# Parse leading options
ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,22p' "$0"
            exit 0
            ;;
        *) ARGS+=("$1"); shift ;;
    esac
done

if [[ ${#ARGS[@]} -gt 0 ]]; then
    set -- "${ARGS[@]}"
else
    set --
fi

[[ -n "$FLOW_STATE" ]] || die_json "flow.json path required (--flow-state)" 1
[[ -f "$FLOW_STATE" ]] || die_json "flow.json not found at: $FLOW_STATE" 1

# Reject v1 / legacy schema explicitly (no-backcompat)
VERSION=$(jq -r '.version // empty' "$FLOW_STATE")
if [[ "$VERSION" != "2.0.0" ]]; then
    die_json "flow.json schema version must be 2.0.0 (got: \"$VERSION\"). v1 is not supported (no-backcompat)." 1
fi

ACTION="${1:-}"
shift || true

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

write_flow() {
    local jq_filter="$1"
    shift
    local TMP
    TMP=$(mktemp); TMP_FILES+=("$TMP")
    jq "$@" --arg now "$NOW" "$jq_filter | .updated_at = \$now" "$FLOW_STATE" > "$TMP"
    mv "$TMP" "$FLOW_STATE"
}

case "$ACTION" in
    status)
        NEW_STATUS="${1:-}"
        [[ -n "$NEW_STATUS" ]] || die_json "Status value required" 1
        VALID_STATUSES="decomposing running integrated failed"
        if ! echo "$VALID_STATUSES" | grep -qw "$NEW_STATUS"; then
            die_json "Invalid status: $NEW_STATUS. Valid: $VALID_STATUSES" 1
        fi
        write_flow ".status = \$s" --arg s "$NEW_STATUS"
        echo "{\"status\":\"updated\",\"field\":\"status\",\"value\":\"$NEW_STATUS\"}"
        ;;

    child)
        CHILD_ISSUE="${1:-}"
        shift || true
        [[ -n "$CHILD_ISSUE" ]] || die_json "Child issue number required" 1

        CHILD_STATUS=""
        CHILD_PR=""
        CHILD_PR_URL=""
        CHILD_MERGED_AT=""
        CHILD_ERROR=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --status) CHILD_STATUS="$2"; shift 2 ;;
                --pr) CHILD_PR="$2"; shift 2 ;;
                --pr-url) CHILD_PR_URL="$2"; shift 2 ;;
                --merged-at) CHILD_MERGED_AT="$2"; shift 2 ;;
                --error) CHILD_ERROR="$2"; shift 2 ;;
                *) die_json "Unknown child option: $1" 1 ;;
            esac
        done

        # Verify child exists
        if ! jq -e --argjson i "$CHILD_ISSUE" '.children[] | select(.issue == $i)' "$FLOW_STATE" >/dev/null 2>&1; then
            die_json "Child issue #$CHILD_ISSUE not in flow.json children[]" 1
        fi

        if [[ -n "$CHILD_STATUS" ]]; then
            VALID_CHILD_STATUSES="pending running completed failed"
            if ! echo "$VALID_CHILD_STATUSES" | grep -qw "$CHILD_STATUS"; then
                die_json "Invalid child status: $CHILD_STATUS. Valid: $VALID_CHILD_STATUSES" 1
            fi
            write_flow '(.children[] | select(.issue == $i)).status = $s' \
                --argjson i "$CHILD_ISSUE" --arg s "$CHILD_STATUS"
        fi

        if [[ -n "$CHILD_PR" ]]; then
            write_flow '(.children[] | select(.issue == $i)).pr_number = $n' \
                --argjson i "$CHILD_ISSUE" --argjson n "$CHILD_PR"
        fi

        if [[ -n "$CHILD_PR_URL" ]]; then
            write_flow '(.children[] | select(.issue == $i)).pr_url = $u' \
                --argjson i "$CHILD_ISSUE" --arg u "$CHILD_PR_URL"
        fi

        if [[ -n "$CHILD_MERGED_AT" ]]; then
            write_flow '(.children[] | select(.issue == $i)).merged_at = $m' \
                --argjson i "$CHILD_ISSUE" --arg m "$CHILD_MERGED_AT"
        fi

        if [[ -n "$CHILD_ERROR" ]]; then
            write_flow '(.children[] | select(.issue == $i)).error = $e' \
                --argjson i "$CHILD_ISSUE" --arg e "$CHILD_ERROR"
        fi

        echo "{\"status\":\"updated\",\"child\":$CHILD_ISSUE}"
        ;;

    final-pr)
        PR_NUMBER=""
        PR_URL=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --number) PR_NUMBER="$2"; shift 2 ;;
                --url) PR_URL="$2"; shift 2 ;;
                *) die_json "Unknown final-pr option: $1" 1 ;;
            esac
        done
        [[ -n "$PR_NUMBER" ]] || die_json "PR number required (--number)" 1
        [[ -n "$PR_URL" ]] || die_json "PR URL required (--url)" 1

        write_flow '.final_pr = {number: $num, url: $url, created_at: $now}' \
            --argjson num "$PR_NUMBER" --arg url "$PR_URL"
        echo "{\"status\":\"updated\",\"field\":\"final_pr\",\"number\":$PR_NUMBER,\"url\":\"$PR_URL\"}"
        ;;

    *)
        die_json "Unknown action: $ACTION. Valid: status, child, final-pr" 1
        ;;
esac
