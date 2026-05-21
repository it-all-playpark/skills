#!/usr/bin/env bash
# flow-update.sh - Update v2.1 flow.json state
# IMPORTANT: write_flow() acquires `flock -x` on a per-flow lockfile so the
# script is safe under parallel invocation. Lock fallback: Python fcntl when
# `flock` binary is absent (macOS default). v2.1 schema (child-split + phases[])
# only.
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
#   phase <name> <new-status> [--retry-target NAME|abort] [--score N] [--attempts +1]
#       Update top-level phases[] entry. <name> ∈
#       {decompose, batch_loop, integrate, final_pr, pr_iterate}.
#       <new-status> ∈ {pending, running, done, blocked, failed}.
#       When status==failed, failed_at is auto-set to "now".

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

# Reject v2.0 / v1 / legacy schema explicitly (no-backcompat)
VERSION=$(jq -r '.version // empty' "$FLOW_STATE")
if [[ "$VERSION" != "2.1.0" ]]; then
    die_json "flow.json schema version must be 2.1.0 (got: \"$VERSION\"). v2.0 / v1 は schema error (no-backcompat)." 1
fi

ACTION="${1:-}"
shift || true

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

FLOW_LOCKFILE="${FLOW_STATE}.lock"

# Helper python script (POSIX fcntl) for systems without flock binary.
# Takes lockfile path as $1 and the command (argv) to run while the lock is held.
_python_flock_runner='
import fcntl, os, subprocess, sys
lockfile = sys.argv[1]
cmd = sys.argv[2:]
fd = os.open(lockfile, os.O_RDWR | os.O_CREAT, 0o644)
try:
    fcntl.flock(fd, fcntl.LOCK_EX)
    rc = subprocess.call(cmd)
finally:
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)
sys.exit(rc)
'

# Atomic jq + mv on $FLOW_STATE. Runs ALWAYS under flock (acquired by the caller).
# Reads filter from $1 and additional jq args from $2..$n.
_locked_jq_mv() {
    local jq_filter="$1"
    shift
    local TMP
    TMP=$(mktemp); TMP_FILES+=("$TMP")
    jq "$@" --arg now "$NOW" "$jq_filter | .updated_at = \$now" "$FLOW_STATE" > "$TMP"
    mv "$TMP" "$FLOW_STATE"
}

# write_flow: acquires exclusive lock on $FLOW_STATE.lock before performing
# an atomic jq + mv. flock is the only line of defense against concurrent
# writers (Q5). Falls back to Python fcntl on systems without flock (macOS).
#
# Args:
#   $1     - jq filter (without |.updated_at=$now; appended automatically)
#   $2..$n - additional jq args (e.g. --arg s "$NEW_STATUS")
write_flow() {
    local jq_filter="$1"
    shift
    local lockdir
    lockdir="$(dirname "$FLOW_LOCKFILE")"
    [[ -d "$lockdir" ]] || mkdir -p "$lockdir"
    [[ -e "$FLOW_LOCKFILE" ]] || : > "$FLOW_LOCKFILE"

    if command -v flock >/dev/null 2>&1; then
        (
            exec 9>"$FLOW_LOCKFILE"
            flock -x 9
            _locked_jq_mv "$jq_filter" "$@"
        )
    elif command -v python3 >/dev/null 2>&1; then
        # POSIX fallback. Use `flow-update.sh --flow-state X __locked_jq_mv FILTER ARGS...`
        # under the python flock wrapper so the write occurs while we hold the lock.
        python3 -c "$_python_flock_runner" "$FLOW_LOCKFILE" \
            "$BASH" "${BASH_SOURCE[0]}" \
            --flow-state "$FLOW_STATE" \
            __locked_jq_mv "$jq_filter" "$@"
    else
        die_json "Neither 'flock' nor 'python3' available; cannot acquire lock for $FLOW_STATE" 127
    fi
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

    phase)
        PHASE_NAME="${1:-}"
        shift || true
        [[ -n "$PHASE_NAME" ]] || die_json "Phase name required (e.g. decompose, batch_loop, integrate, final_pr, pr_iterate)" 1

        VALID_PHASE_NAMES="decompose batch_loop integrate final_pr pr_iterate"
        if ! echo "$VALID_PHASE_NAMES" | grep -qw "$PHASE_NAME"; then
            die_json "Invalid phase name: $PHASE_NAME. Valid: $VALID_PHASE_NAMES" 1
        fi

        NEW_PHASE_STATUS="${1:-}"
        shift || true
        [[ -n "$NEW_PHASE_STATUS" ]] || die_json "Phase status required (pending|running|done|blocked|failed)" 1

        VALID_PHASE_STATUSES="pending running done blocked failed"
        if ! echo "$VALID_PHASE_STATUSES" | grep -qw "$NEW_PHASE_STATUS"; then
            die_json "Invalid phase status: $NEW_PHASE_STATUS. Valid: $VALID_PHASE_STATUSES" 1
        fi

        PHASE_RETRY_TARGET=""
        PHASE_SCORE=""
        PHASE_ATTEMPTS_INC="0"
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --retry-target) PHASE_RETRY_TARGET="$2"; shift 2 ;;
                --score) PHASE_SCORE="$2"; shift 2 ;;
                --attempts)
                    if [[ "$2" != "+1" ]]; then
                        die_json "Only --attempts +1 is supported (got: $2)" 1
                    fi
                    PHASE_ATTEMPTS_INC="1"; shift 2 ;;
                *) die_json "Unknown phase option: $1" 1 ;;
            esac
        done

        # Validate retry-target if provided
        if [[ -n "$PHASE_RETRY_TARGET" ]]; then
            if [[ "$PHASE_RETRY_TARGET" != "abort" ]]; then
                if ! echo "$VALID_PHASE_NAMES" | grep -qw "$PHASE_RETRY_TARGET"; then
                    die_json "Invalid --retry-target: $PHASE_RETRY_TARGET. Valid: $VALID_PHASE_NAMES, abort" 1
                fi
            fi
        fi

        # Validate score range
        if [[ -n "$PHASE_SCORE" ]]; then
            if ! [[ "$PHASE_SCORE" =~ ^[0-9]+$ ]]; then
                die_json "--score must be integer (got: $PHASE_SCORE)" 1
            fi
            if (( PHASE_SCORE < 0 || PHASE_SCORE > 100 )); then
                die_json "--score out of range 0-100 (got: $PHASE_SCORE)" 1
            fi
        fi

        # Ensure phase exists in phases[]
        if ! jq -e --arg n "$PHASE_NAME" '.phases[] | select(.name == $n)' "$FLOW_STATE" >/dev/null 2>&1; then
            die_json "Phase '$PHASE_NAME' not present in flow.json phases[] (was dev-decompose seed run?)" 1
        fi

        # Build jq filter incrementally
        # 1. status
        write_flow '(.phases[] | select(.name == $n)).status = $s' \
            --arg n "$PHASE_NAME" --arg s "$NEW_PHASE_STATUS"

        # 2. failed_at when status==failed
        if [[ "$NEW_PHASE_STATUS" == "failed" ]]; then
            write_flow '(.phases[] | select(.name == $n)).failed_at = $now' \
                --arg n "$PHASE_NAME"
        fi

        # 3. retry_target (if provided)
        if [[ -n "$PHASE_RETRY_TARGET" ]]; then
            write_flow '(.phases[] | select(.name == $n)).retry_target = $t' \
                --arg n "$PHASE_NAME" --arg t "$PHASE_RETRY_TARGET"
        fi

        # 4. score (if provided)
        if [[ -n "$PHASE_SCORE" ]]; then
            write_flow '(.phases[] | select(.name == $n)).score = ($v | tonumber)' \
                --arg n "$PHASE_NAME" --arg v "$PHASE_SCORE"
        fi

        # 5. attempts increment
        if [[ "$PHASE_ATTEMPTS_INC" == "1" ]]; then
            write_flow '(.phases[] | select(.name == $n)).attempts = ((.phases[] | select(.name == $n).attempts) // 0) + 1' \
                --arg n "$PHASE_NAME"
        fi

        echo "{\"status\":\"updated\",\"phase\":\"$PHASE_NAME\",\"new_status\":\"$NEW_PHASE_STATUS\"}"
        ;;

    __locked_jq_mv)
        # Internal action used by write_flow's python fcntl fallback.
        # Caller is responsible for already holding the lock.
        INNER_FILTER="${1:-}"; shift || true
        [[ -n "$INNER_FILTER" ]] || die_json "__locked_jq_mv: filter required" 1
        TMP=$(mktemp); TMP_FILES+=("$TMP")
        jq "$@" --arg now "$NOW" "$INNER_FILTER | .updated_at = \$now" "$FLOW_STATE" > "$TMP"
        mv "$TMP" "$FLOW_STATE"
        ;;

    *)
        die_json "Unknown action: $ACTION. Valid: status, child, final-pr, phase" 1
        ;;
esac
