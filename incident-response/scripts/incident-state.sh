#!/usr/bin/env bash
# incident-state.sh - Incident investigation state management
# Usage:
#   incident-state.sh init "<symptom>" [--since <datetime>]
#   incident-state.sh add-timeline "<time>" "<event>" "<source>" "<severity>"
#   incident-state.sh update-line <line> <status> [--findings <count>]
#   incident-state.sh set-root-cause "<description>" "<confidence>"
#   incident-state.sh check-budget
#   incident-state.sh read

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

STATE_DIR="${PWD}/.claude"
STATE_FILE="${STATE_DIR}/incident-state.json"

# ============================================================================
# Helpers
# ============================================================================

ensure_state_dir() {
    mkdir -p "$STATE_DIR"
}

state_exists() {
    [[ -f "$STATE_FILE" ]]
}

require_state() {
    state_exists || die_json "No incident state found. Run 'init' first." 1
}

read_state() {
    require_state
    cat "$STATE_FILE"
}

write_state() {
    echo "$1" > "$STATE_FILE"
}

# ============================================================================
# Init
# ============================================================================

cmd_init() {
    local symptom="" since="" max_turns=25

    if [[ $# -lt 1 ]]; then
        die_json "Usage: incident-state.sh init \"<symptom>\" [--since <datetime>] [--max-turns N]" 1
    fi
    symptom="$1"; shift

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --since) since="$2"; shift 2 ;;
            --max-turns) max_turns="$2"; shift 2 ;;
            *) die_json "Unknown option: $1" 1 ;;
        esac
    done

    ensure_state_dir

    local state
    state=$(jq -n \
        --arg version "1.0.0" \
        --arg symptom "$symptom" \
        --arg since "$since" \
        --arg status "investigating" \
        --argjson max_turns "$max_turns" \
        --argjson turns_used 0 \
        '{
            version: $version,
            symptom: $symptom,
            since: (if $since == "" then null else $since end),
            status: $status,
            max_turns: $max_turns,
            turns_used: $turns_used,
            timeline: [],
            investigation_lines: {
                code: { status: "pending", analyst: "code-analyst", findings_count: 0 },
                log: { status: "pending", analyst: "log-analyst", findings_count: 0 },
                config: { status: "pending", analyst: "config-analyst", findings_count: 0 }
            },
            root_cause: null,
            resolution: null
        }')

    write_state "$state"
    echo "{\"status\":\"initialized\",\"state_file\":\"$STATE_FILE\"}"
}

# ============================================================================
# Add Timeline Event
# ============================================================================

cmd_add_timeline() {
    if [[ $# -lt 4 ]]; then
        die_json "Usage: incident-state.sh add-timeline \"<time>\" \"<event>\" \"<source>\" \"<severity>\"" 1
    fi

    require_state

    local time="$1" event="$2" source="$3" severity="$4"

    # Validate severity
    case "$severity" in
        critical|high|medium|low) ;;
        *) die_json "Invalid severity: $severity. Must be critical|high|medium|low" 1 ;;
    esac

    local state
    state=$(read_state)

    # Add event and sort by time
    state=$(echo "$state" | jq \
        --arg time "$time" \
        --arg event "$event" \
        --arg source "$source" \
        --arg severity "$severity" \
        '.timeline += [{time: $time, event: $event, source: $source, severity: $severity}]
         | .timeline |= sort_by(.time)')

    write_state "$state"
    echo "{\"status\":\"added\",\"timeline_count\":$(echo "$state" | jq '.timeline | length')}"
}

# ============================================================================
# Update Investigation Line
# ============================================================================

cmd_update_line() {
    if [[ $# -lt 2 ]]; then
        die_json "Usage: incident-state.sh update-line <line> <status> [--findings <count>]" 1
    fi

    require_state

    local line="$1" status="$2"
    shift 2
    local findings=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --findings) findings="$2"; shift 2 ;;
            *) die_json "Unknown option: $1" 1 ;;
        esac
    done

    # Validate line
    case "$line" in
        code|log|config) ;;
        *) die_json "Invalid line: $line. Must be code|log|config" 1 ;;
    esac

    # Validate status
    case "$status" in
        pending|active|completed|shutdown) ;;
        *) die_json "Invalid status: $status. Must be pending|active|completed|shutdown" 1 ;;
    esac

    local state
    state=$(read_state)

    state=$(echo "$state" | jq \
        --arg line "$line" \
        --arg status "$status" \
        '.investigation_lines[$line].status = $status')

    if [[ -n "$findings" ]]; then
        state=$(echo "$state" | jq \
            --arg line "$line" \
            --argjson count "$findings" \
            '.investigation_lines[$line].findings_count = $count')
    fi

    write_state "$state"
    echo "{\"status\":\"updated\",\"line\":\"$line\",\"new_status\":\"$status\"}"
}

# ============================================================================
# Set Root Cause
# ============================================================================

cmd_set_root_cause() {
    if [[ $# -lt 2 ]]; then
        die_json "Usage: incident-state.sh set-root-cause \"<description>\" \"<confidence>\"" 1
    fi

    require_state

    local description="$1" confidence="$2"

    # Validate confidence
    case "$confidence" in
        high|medium|low) ;;
        *) die_json "Invalid confidence: $confidence. Must be high|medium|low" 1 ;;
    esac

    local state
    state=$(read_state)

    state=$(echo "$state" | jq \
        --arg desc "$description" \
        --arg conf "$confidence" \
        '.root_cause = {description: $desc, confidence: $conf}
         | .status = "root_cause_identified"')

    write_state "$state"
    echo "{\"status\":\"updated\",\"root_cause_set\":true,\"confidence\":\"$confidence\"}"
}

# ============================================================================
# Check Budget
# ============================================================================

cmd_check_budget() {
    require_state

    local state
    state=$(read_state)

    local max_turns turns_used remaining pct
    max_turns=$(echo "$state" | jq -r '.max_turns')
    turns_used=$(echo "$state" | jq -r '.turns_used')
    remaining=$((max_turns - turns_used))
    if [[ "$max_turns" -gt 0 ]]; then
        pct=$(( (turns_used * 100) / max_turns ))
    else
        pct=0
    fi

    local warning="false"
    if [[ "$pct" -ge 80 ]]; then
        warning="true"
    fi

    echo "{\"max_turns\":$max_turns,\"turns_used\":$turns_used,\"remaining\":$remaining,\"percent_used\":$pct,\"budget_warning\":$warning}"
}

# ============================================================================
# Increment Turns
# ============================================================================

cmd_increment_turns() {
    local count="${1:-1}"
    require_state

    local state
    state=$(read_state)
    state=$(echo "$state" | jq --argjson n "$count" '.turns_used += $n')
    write_state "$state"

    cmd_check_budget
}

# ============================================================================
# Read
# ============================================================================

cmd_read() {
    require_state
    read_state | jq .
}

# ============================================================================
# Main
# ============================================================================

SUBCMD="${1:-}"
shift || true

case "$SUBCMD" in
    init) cmd_init "$@" ;;
    add-timeline) cmd_add_timeline "$@" ;;
    update-line) cmd_update_line "$@" ;;
    set-root-cause) cmd_set_root_cause "$@" ;;
    check-budget) cmd_check_budget ;;
    increment-turns) cmd_increment_turns "$@" ;;
    read) cmd_read ;;
    *)
        cat <<'USAGE'
Usage: incident-state.sh <subcommand> [options]

Subcommands:
  init "<symptom>" [--since <datetime>] [--max-turns N]
  add-timeline "<time>" "<event>" "<source>" "<severity>"
  update-line <line> <status> [--findings <count>]
  set-root-cause "<description>" "<confidence>"
  check-budget
  increment-turns [count]
  read

Examples:
  incident-state.sh init "API response suddenly slow" --since "2026-02-18T15:30:00+09:00"
  incident-state.sh add-timeline "15:28" "index deletion commit" "code-analyst" "high"
  incident-state.sh update-line config completed --findings 0
  incident-state.sh set-root-cause "Composite index removal caused full table scan" "high"
  incident-state.sh check-budget
USAGE
        exit 1
        ;;
esac
