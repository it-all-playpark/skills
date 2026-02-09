#!/usr/bin/env bash
# flow-update.sh - Update flow.json state
# IMPORTANT: Single-writer design. Must only be called sequentially from the
# dev-flow orchestrator, never from parallel subtask processes directly.
# Usage: flow-update.sh --flow-state PATH <action> [options]
#
# Actions:
#   status <new-status>                    Update overall flow status
#   subtask <task-id> --status <status>    Update subtask status
#   subtask <task-id> --files-changed FILE1,FILE2  Record actual files changed
#   integration --field <key> --value <val> Update integration section
#   pr --number N --url URL                Record PR info

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common.sh"

require_cmd jq

FLOW_STATE=""
ACTION=""
TMP_FILES=()
cleanup_tmp() { for f in "${TMP_FILES[@]}"; do rm -f "$f" 2>/dev/null; done; }
trap cleanup_tmp EXIT

# Parse leading options
ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: flow-update.sh --flow-state PATH <action> [options]"
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

ACTION="${1:-}"
shift || true

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

case "$ACTION" in
    status)
        NEW_STATUS="${1:-}"
        [[ -n "$NEW_STATUS" ]] || die_json "Status value required" 1
        VALID_STATUSES="analyzing decomposing implementing integrating pr iterating completed failed"
        if ! echo "$VALID_STATUSES" | grep -qw "$NEW_STATUS"; then
            die_json "Invalid status: $NEW_STATUS. Valid: $VALID_STATUSES" 1
        fi
        TMP=$(mktemp); TMP_FILES+=("$TMP")
        jq --arg s "$NEW_STATUS" --arg now "$NOW" \
            '.status = $s | .updated_at = $now' "$FLOW_STATE" > "$TMP" && mv "$TMP" "$FLOW_STATE"
        echo "{\"status\":\"updated\",\"field\":\"status\",\"value\":\"$NEW_STATUS\"}"
        ;;

    subtask)
        TASK_ID="${1:-}"
        shift || true
        [[ -n "$TASK_ID" ]] || die_json "Subtask ID required" 1

        SUB_STATUS=""
        FILES_CHANGED=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --status) SUB_STATUS="$2"; shift 2 ;;
                --files-changed) FILES_CHANGED="$2"; shift 2 ;;
                *) die_json "Unknown subtask option: $1" 1 ;;
            esac
        done

        if [[ -n "$SUB_STATUS" ]]; then
            VALID_SUB_STATUSES="pending in_progress completed failed"
            if ! echo "$VALID_SUB_STATUSES" | grep -qw "$SUB_STATUS"; then
                die_json "Invalid subtask status: $SUB_STATUS. Valid: $VALID_SUB_STATUSES" 1
            fi
        fi

        TMP=$(mktemp); TMP_FILES+=("$TMP")
        if [[ -n "$SUB_STATUS" ]]; then
            jq --arg id "$TASK_ID" --arg s "$SUB_STATUS" --arg now "$NOW" \
                '(.subtasks[] | select(.id == $id)).status = $s | .updated_at = $now' \
                "$FLOW_STATE" > "$TMP" && mv "$TMP" "$FLOW_STATE"
            echo "{\"status\":\"updated\",\"subtask\":\"$TASK_ID\",\"field\":\"status\",\"value\":\"$SUB_STATUS\"}"
        fi

        if [[ -n "$FILES_CHANGED" ]]; then
            # Convert comma-separated to JSON array
            FILES_JSON=$(echo "$FILES_CHANGED" | tr ',' '\n' | jq -R . | jq -s '.')
            TMP=$(mktemp); TMP_FILES+=("$TMP")
            jq --arg id "$TASK_ID" --argjson files "$FILES_JSON" --arg now "$NOW" \
                '(.subtasks[] | select(.id == $id)).actual_files_changed = $files | .updated_at = $now' \
                "$FLOW_STATE" > "$TMP" && mv "$TMP" "$FLOW_STATE"
            echo "{\"status\":\"updated\",\"subtask\":\"$TASK_ID\",\"field\":\"actual_files_changed\"}"
        fi
        ;;

    integration)
        FIELD=""
        VALUE=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --field) FIELD="$2"; shift 2 ;;
                --value) VALUE="$2"; shift 2 ;;
                *) die_json "Unknown integration option: $1" 1 ;;
            esac
        done
        [[ -n "$FIELD" ]] || die_json "Integration field required (--field)" 1
        [[ -n "$VALUE" ]] || die_json "Integration value required (--value)" 1

        TMP=$(mktemp); TMP_FILES+=("$TMP")
        jq --arg f "$FIELD" --arg v "$VALUE" --arg now "$NOW" \
            '.integration[$f] = $v | .updated_at = $now' "$FLOW_STATE" > "$TMP" && mv "$TMP" "$FLOW_STATE"
        echo "{\"status\":\"updated\",\"field\":\"integration.$FIELD\",\"value\":\"$VALUE\"}"
        ;;

    pr)
        PR_NUMBER=""
        PR_URL=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --number) PR_NUMBER="$2"; shift 2 ;;
                --url) PR_URL="$2"; shift 2 ;;
                *) die_json "Unknown pr option: $1" 1 ;;
            esac
        done
        [[ -n "$PR_NUMBER" ]] || die_json "PR number required (--number)" 1
        [[ -n "$PR_URL" ]] || die_json "PR URL required (--url)" 1

        TMP=$(mktemp); TMP_FILES+=("$TMP")
        jq --argjson num "$PR_NUMBER" --arg url "$PR_URL" --arg now "$NOW" \
            '.pr = {number: $num, url: $url, created_at: $now} | .updated_at = $now' \
            "$FLOW_STATE" > "$TMP" && mv "$TMP" "$FLOW_STATE"
        echo "{\"status\":\"updated\",\"field\":\"pr\",\"number\":$PR_NUMBER,\"url\":\"$PR_URL\"}"
        ;;

    *)
        die_json "Unknown action: $ACTION. Valid: status, subtask, integration, pr" 1
        ;;
esac
