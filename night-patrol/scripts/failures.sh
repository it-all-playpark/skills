#!/usr/bin/env bash
# failures.sh - Night patrol failure counter with escalation detection
#
# Purpose:
#   Track consecutive execute-phase failures per issue so that the night-patrol
#   loop can escalate a stuck issue (label `patrol-stuck`) and avoid infinite
#   retry loops. Backing store: JSON file, default ~/.claude/night-patrol/failures.json.
#
# Usage:
#   failures.sh get <issue-number>
#   failures.sh incr <issue-number> --reason "<msg>"
#   failures.sh reset <issue-number>
#   failures.sh list
#
# Config resolution (highest wins):
#   Path:
#     $NIGHT_PATROL_FAILURES_PATH > skill-config.json[night-patrol].failures_path > ~/.claude/night-patrol/failures.json
#   Max failures threshold:
#     $NIGHT_PATROL_MAX_FAILURES > skill-config.json[night-patrol].max_failures > 2
#
# Output: JSON on stdout for all commands.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../_lib/common.sh
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

resolve_failures_path() {
    if [[ -n "${NIGHT_PATROL_FAILURES_PATH:-}" ]]; then
        echo "$NIGHT_PATROL_FAILURES_PATH"
        return
    fi
    local cfg_path
    cfg_path=$(load_skill_config "night-patrol" | jq -r '.failures_path // empty' 2>/dev/null || true)
    if [[ -n "$cfg_path" && "$cfg_path" != "null" ]]; then
        # Expand leading ~
        echo "${cfg_path/#\~/$HOME}"
        return
    fi
    echo "$HOME/.claude/night-patrol/failures.json"
}

resolve_max_failures() {
    if [[ -n "${NIGHT_PATROL_MAX_FAILURES:-}" ]]; then
        echo "$NIGHT_PATROL_MAX_FAILURES"
        return
    fi
    local cfg_val
    cfg_val=$(load_skill_config "night-patrol" | jq -r '.max_failures // empty' 2>/dev/null || true)
    if [[ -n "$cfg_val" && "$cfg_val" != "null" ]]; then
        echo "$cfg_val"
        return
    fi
    echo "2"
}

FAILURES_PATH=$(resolve_failures_path)
MAX_FAILURES=$(resolve_max_failures)

# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------

# Ensure the failures file exists with a valid empty skeleton.
ensure_state() {
    if [[ ! -f "$FAILURES_PATH" ]]; then
        mkdir -p "$(dirname "$FAILURES_PATH")"
        printf '{"version":"1.0.0","issues":{}}\n' > "$FAILURES_PATH"
    fi
}

read_state() {
    ensure_state
    cat "$FAILURES_PATH"
}

# Atomic write: tmp + mv.
write_state() {
    local content="$1"
    mkdir -p "$(dirname "$FAILURES_PATH")"
    local tmp
    tmp=$(mktemp "${FAILURES_PATH}.tmp.XXXXXX")
    printf '%s\n' "$content" > "$tmp"
    mv "$tmp" "$FAILURES_PATH"
}

validate_issue() {
    local issue="$1"
    if [[ -z "$issue" ]]; then
        die_json "Issue number required" 1
    fi
    if ! [[ "$issue" =~ ^[0-9]+$ ]]; then
        die_json "Issue must be a positive integer: $issue" 1
    fi
}

now_utc() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_get() {
    local issue="$1"
    validate_issue "$issue"
    local state
    state=$(read_state)
    echo "$state" | jq -c --arg i "$issue" '
        .issues[$i] // { count: 0, last_failure_at: null, last_reason: null }
        | { count: .count, last_failure_at: .last_failure_at, last_reason: .last_reason }
    '
}

cmd_incr() {
    local issue="$1"; shift
    local reason=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --reason) reason="${2:-}"; shift 2 ;;
            *) die_json "Unknown option: $1" 1 ;;
        esac
    done
    validate_issue "$issue"
    local state
    state=$(read_state)
    local now
    now=$(now_utc)
    local new_state
    new_state=$(echo "$state" | jq \
        --arg i "$issue" \
        --arg r "$reason" \
        --arg t "$now" \
        '
        .issues[$i] = {
            count: ((.issues[$i].count // 0) + 1),
            last_failure_at: $t,
            last_reason: $r
        }
        ')
    write_state "$new_state"
    local count
    count=$(echo "$new_state" | jq -r --arg i "$issue" '.issues[$i].count')
    local escalated="false"
    if (( count >= MAX_FAILURES )); then
        escalated="true"
    fi
    jq -nc \
        --argjson count "$count" \
        --arg reason "$reason" \
        --argjson escalated "$escalated" \
        --argjson max "$MAX_FAILURES" \
        '{count: $count, last_reason: $reason, escalated: $escalated, max_failures: $max}'
}

cmd_reset() {
    local issue="$1"
    validate_issue "$issue"
    local state
    state=$(read_state)
    local new_state
    new_state=$(echo "$state" | jq --arg i "$issue" 'del(.issues[$i])')
    write_state "$new_state"
    jq -nc --arg i "$issue" '{status: "reset", issue: ($i | tonumber)}'
}

cmd_list() {
    local state
    state=$(read_state)
    echo "$state" | jq -c '{version: .version, issues: .issues}'
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

if [[ $# -lt 1 ]]; then
    die_json "Usage: failures.sh {get|incr|reset|list} [args]" 1
fi

CMD="$1"; shift
case "$CMD" in
    get)   cmd_get "${1:-}" ;;
    incr)  cmd_incr "$@" ;;
    reset) cmd_reset "${1:-}" ;;
    list)  cmd_list ;;
    *)     die_json "Unknown command: $CMD" 1 ;;
esac
