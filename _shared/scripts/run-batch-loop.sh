#!/usr/bin/env bash
# run-batch-loop.sh - Generic batch loop runner for issue/task lists
#
# Consumes a batch array (serial/parallel groups) and dispatches each issue
# through a caller-supplied runner command. Used by night-patrol Phase 3 and
# dev-flow child-split mode to share the same orchestration.
#
# Usage:
#   run-batch-loop.sh --batches-json PATH --issue-runner "CMD {issue}" \
#     [--batch-from N] [--batch-to N] \
#     [--on-success "CMD {issue}"] [--on-failure "CMD {issue}"] \
#     [--max-parallel N] [--state-file PATH]
#
# Batch JSON schema (array of batches):
#   [
#     {"batch": 1, "mode": "serial",   "children": [101, 102]},
#     {"batch": 2, "mode": "parallel", "children": [103, 104, 105]},
#     {"batch": 3, "mode": "serial",   "children": [106]}
#   ]
#
# The runner command uses `{issue}` as placeholder for the issue/child number
# (substituted before each invocation).
#
# Returns JSON:
#   {
#     "status": "ok|partial|failed",
#     "batches_processed": N,
#     "issues_succeeded": M,
#     "issues_failed": K,
#     "results": [
#       {"batch": 1, "issue": 101, "status": "success|failed", "exit_code": 0, "duration_sec": 3}
#     ]
#   }

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

# ============================================================================
# Argument parsing
# ============================================================================

BATCHES_JSON_PATH=""
ISSUE_RUNNER=""
ON_SUCCESS=""
ON_FAILURE=""
BATCH_FROM=""
BATCH_TO=""
MAX_PARALLEL="0"  # 0 = unlimited
STATE_FILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --batches-json) BATCHES_JSON_PATH="$2"; shift 2 ;;
        --issue-runner) ISSUE_RUNNER="$2"; shift 2 ;;
        --on-success) ON_SUCCESS="$2"; shift 2 ;;
        --on-failure) ON_FAILURE="$2"; shift 2 ;;
        --batch-from) BATCH_FROM="$2"; shift 2 ;;
        --batch-to) BATCH_TO="$2"; shift 2 ;;
        --max-parallel) MAX_PARALLEL="$2"; shift 2 ;;
        --state-file) STATE_FILE="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,40p' "$0"
            exit 0
            ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

[[ -n "$BATCHES_JSON_PATH" ]] || die_json "--batches-json is required" 1
[[ -n "$ISSUE_RUNNER" ]] || die_json "--issue-runner is required" 1
[[ -f "$BATCHES_JSON_PATH" ]] || die_json "Batches JSON not found: $BATCHES_JSON_PATH" 1

# Validate batches JSON
if ! jq -e 'type == "array"' "$BATCHES_JSON_PATH" >/dev/null 2>&1; then
    die_json "Batches JSON must be an array of batch objects" 1
fi

# ============================================================================
# Range filtering
# ============================================================================

BATCH_COUNT=$(jq 'length' "$BATCHES_JSON_PATH")
[[ "$BATCH_COUNT" -gt 0 ]] || die_json "Batches array is empty" 1

# Determine min/max batch numbers
MIN_BATCH=$(jq '[.[].batch] | min' "$BATCHES_JSON_PATH")
MAX_BATCH=$(jq '[.[].batch] | max' "$BATCHES_JSON_PATH")

FROM_BATCH="${BATCH_FROM:-$MIN_BATCH}"
TO_BATCH="${BATCH_TO:-$MAX_BATCH}"

if [[ "$FROM_BATCH" -gt "$TO_BATCH" ]]; then
    die_json "--batch-from ($FROM_BATCH) must be <= --batch-to ($TO_BATCH)" 1
fi

# Filter batches in range and sort by batch number
FILTERED_BATCHES=$(jq --argjson from "$FROM_BATCH" --argjson to "$TO_BATCH" \
    '[.[] | select(.batch >= $from and .batch <= $to)] | sort_by(.batch)' \
    "$BATCHES_JSON_PATH")

FILTERED_COUNT=$(echo "$FILTERED_BATCHES" | jq 'length')
if [[ "$FILTERED_COUNT" -eq 0 ]]; then
    die_json "No batches in range [$FROM_BATCH, $TO_BATCH]" 1
fi

# ============================================================================
# Helpers
# ============================================================================

substitute_cmd() {
    # Replace {issue} placeholder with actual issue number
    local template="$1"
    local issue="$2"
    echo "${template//\{issue\}/$issue}"
}

# Per-batch state directory for parallel result collection
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

write_state() {
    [[ -n "$STATE_FILE" ]] || return 0
    mkdir -p "$(dirname "$STATE_FILE")"
    cat > "$STATE_FILE"
}

# ============================================================================
# Run a single issue and emit a result JSON to TMP_DIR/result-N.json
# ============================================================================

run_one_issue() {
    local batch_num="$1"
    local issue="$2"
    local out_file="$3"

    local cmd
    cmd=$(substitute_cmd "$ISSUE_RUNNER" "$issue")

    local start_ts end_ts duration exit_code
    start_ts=$(date +%s)
    bash -c "$cmd"
    exit_code=$?
    end_ts=$(date +%s)
    duration=$((end_ts - start_ts))

    local status
    if [[ "$exit_code" -eq 0 ]]; then
        status="success"
        if [[ -n "$ON_SUCCESS" ]]; then
            local cb
            cb=$(substitute_cmd "$ON_SUCCESS" "$issue")
            bash -c "$cb" || true
        fi
    else
        status="failed"
        if [[ -n "$ON_FAILURE" ]]; then
            local cb
            cb=$(substitute_cmd "$ON_FAILURE" "$issue")
            bash -c "$cb" || true
        fi
    fi

    jq -n \
        --argjson batch "$batch_num" \
        --argjson issue "$issue" \
        --arg status "$status" \
        --argjson exit_code "$exit_code" \
        --argjson duration_sec "$duration" \
        '{batch: $batch, issue: $issue, status: $status, exit_code: $exit_code, duration_sec: $duration_sec}' \
        > "$out_file"
}

# ============================================================================
# Main loop
# ============================================================================

RESULTS="[]"
BATCHES_PROCESSED=0
ISSUES_SUCCEEDED=0
ISSUES_FAILED=0

for i in $(seq 0 $((FILTERED_COUNT - 1))); do
    BATCH_OBJ=$(echo "$FILTERED_BATCHES" | jq ".[$i]")
    BATCH_NUM=$(echo "$BATCH_OBJ" | jq -r '.batch')
    BATCH_MODE=$(echo "$BATCH_OBJ" | jq -r '.mode')
    CHILDREN=$(echo "$BATCH_OBJ" | jq -r '.children[]')

    BATCHES_PROCESSED=$((BATCHES_PROCESSED + 1))

    if [[ "$BATCH_MODE" == "serial" ]]; then
        while IFS= read -r issue; do
            [[ -z "$issue" ]] && continue
            out_file="$TMP_DIR/result-${BATCH_NUM}-${issue}.json"
            run_one_issue "$BATCH_NUM" "$issue" "$out_file"
            RESULT=$(cat "$out_file")
            RESULTS=$(echo "$RESULTS" | jq --argjson r "$RESULT" '. += [$r]')
            STATUS=$(echo "$RESULT" | jq -r '.status')
            if [[ "$STATUS" == "success" ]]; then
                ISSUES_SUCCEEDED=$((ISSUES_SUCCEEDED + 1))
            else
                ISSUES_FAILED=$((ISSUES_FAILED + 1))
            fi
        done <<< "$CHILDREN"

    elif [[ "$BATCH_MODE" == "parallel" ]]; then
        # Spawn parallel children, optionally throttled by MAX_PARALLEL
        PIDS=()
        ACTIVE=0
        while IFS= read -r issue; do
            [[ -z "$issue" ]] && continue
            out_file="$TMP_DIR/result-${BATCH_NUM}-${issue}.json"
            run_one_issue "$BATCH_NUM" "$issue" "$out_file" &
            PIDS+=($!)
            ACTIVE=$((ACTIVE + 1))
            if [[ "$MAX_PARALLEL" -gt 0 && "$ACTIVE" -ge "$MAX_PARALLEL" ]]; then
                wait "${PIDS[0]}" || true
                PIDS=("${PIDS[@]:1}")
                ACTIVE=$((ACTIVE - 1))
            fi
        done <<< "$CHILDREN"
        # Wait for remaining
        for pid in "${PIDS[@]}"; do
            wait "$pid" || true
        done
        # Collect results from this batch
        while IFS= read -r issue; do
            [[ -z "$issue" ]] && continue
            out_file="$TMP_DIR/result-${BATCH_NUM}-${issue}.json"
            [[ -f "$out_file" ]] || continue
            RESULT=$(cat "$out_file")
            RESULTS=$(echo "$RESULTS" | jq --argjson r "$RESULT" '. += [$r]')
            STATUS=$(echo "$RESULT" | jq -r '.status')
            if [[ "$STATUS" == "success" ]]; then
                ISSUES_SUCCEEDED=$((ISSUES_SUCCEEDED + 1))
            else
                ISSUES_FAILED=$((ISSUES_FAILED + 1))
            fi
        done <<< "$CHILDREN"

    else
        die_json "Unknown batch mode '$BATCH_MODE' (must be 'serial' or 'parallel')" 1
    fi

    # Persist state after each batch (best-effort)
    if [[ -n "$STATE_FILE" ]]; then
        jq -n \
            --argjson processed "$BATCHES_PROCESSED" \
            --argjson succeeded "$ISSUES_SUCCEEDED" \
            --argjson failed "$ISSUES_FAILED" \
            --argjson results "$RESULTS" \
            '{batches_processed: $processed, issues_succeeded: $succeeded, issues_failed: $failed, results: $results}' \
            | write_state
    fi
done

# ============================================================================
# Final result
# ============================================================================

if [[ "$ISSUES_FAILED" -eq 0 ]]; then
    OVERALL="ok"
elif [[ "$ISSUES_SUCCEEDED" -eq 0 ]]; then
    OVERALL="failed"
else
    OVERALL="partial"
fi

jq -n \
    --arg status "$OVERALL" \
    --argjson processed "$BATCHES_PROCESSED" \
    --argjson succeeded "$ISSUES_SUCCEEDED" \
    --argjson failed "$ISSUES_FAILED" \
    --argjson results "$RESULTS" \
    '{
        status: $status,
        batches_processed: $processed,
        issues_succeeded: $succeeded,
        issues_failed: $failed,
        results: $results
    }'
