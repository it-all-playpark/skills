#!/usr/bin/env bash
# journal.sh - Skill execution journal logger and query tool
# Usage:
#   journal.sh log <skill> <outcome> [options]
#   journal.sh query [options]
#   journal.sh stats [options]
#
# Subcommands:
#   log   - Record a skill execution entry
#   query - Query journal entries with filters
#   stats - Show summary statistics

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

JOURNAL_DIR="${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}"

# ============================================================================
# Helpers
# ============================================================================

ensure_journal_dir() {
    mkdir -p "$JOURNAL_DIR"
}

iso_now() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Generate entry ID from timestamp and skill name
# Format: YYYYMMDDTHHMMSS-skillname
entry_id() {
    local ts="$1" skill="$2"
    local compact="${ts//:/-}"
    compact="${compact%Z}"
    compact="${compact//-/}"
    printf '%s-%s' "${compact:0:15}" "$skill"
}

# Parse relative date (7d, 2w, 1m) to ISO date
parse_since() {
    local since="$1"
    case "$since" in
        *d) date -u -v-"${since%d}"d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
             date -u -d "${since%d} days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
        *w) date -u -v-"${since%w}"w +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
             date -u -d "${since%w} weeks ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
        *m) date -u -v-"${since%m}"m +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
             date -u -d "${since%m} months ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
        *) echo "$since" ;;  # Assume ISO date
    esac
}

# ============================================================================
# Log Subcommand
# ============================================================================

cmd_log() {
    local skill="" outcome="" args=""
    local error_category="" error_msg="" error_phase=""
    local recovery="" recovery_turns=""
    local issue="" duration_turns="" context_extra=""
    local project="" worktree=""

    # Parse positional args
    if [[ $# -lt 2 ]]; then
        die_json "Usage: journal.sh log <skill> <outcome> [options]" 1
    fi
    skill="$1"; shift
    outcome="$1"; shift

    # Validate outcome
    case "$outcome" in
        success|failure|partial) ;;
        *) die_json "Invalid outcome: $outcome. Must be success|failure|partial" 1 ;;
    esac

    # Parse options
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --args) args="$2"; shift 2 ;;
            --error-category) error_category="$2"; shift 2 ;;
            --error-msg) error_msg="$2"; shift 2 ;;
            --error-phase) error_phase="$2"; shift 2 ;;
            --recovery) recovery="$2"; shift 2 ;;
            --recovery-turns) recovery_turns="$2"; shift 2 ;;
            --issue) issue="$2"; shift 2 ;;
            --duration-turns) duration_turns="$2"; shift 2 ;;
            --project) project="$2"; shift 2 ;;
            --worktree) worktree="$2"; shift 2 ;;
            --context) context_extra="$2"; shift 2 ;;
            *) die_json "Unknown option: $1" 1 ;;
        esac
    done

    # Validate error fields for failure/partial outcomes
    if [[ "$outcome" != "success" && -z "$error_category" ]]; then
        die_json "Error category required for $outcome outcome. Use --error-category" 1
    fi
    if [[ "$outcome" != "success" && -z "$error_msg" ]]; then
        die_json "Error message required for $outcome outcome. Use --error-msg" 1
    fi

    # Validate error category
    if [[ -n "$error_category" ]]; then
        case "$error_category" in
            lint|test|build|runtime|config|env|merge|type-check) ;;
            *) die_json "Invalid error category: $error_category" 1 ;;
        esac
    fi

    ensure_journal_dir

    local now
    now=$(iso_now)
    local id
    id=$(entry_id "$now" "$skill")

    # Build JSON using jq for safety
    local entry
    entry=$(jq -n \
        --arg version "1.0.0" \
        --arg id "$id" \
        --arg timestamp "$now" \
        --arg skill "$skill" \
        --arg outcome "$outcome" \
        '{version: $version, id: $id, timestamp: $timestamp, skill: $skill, outcome: $outcome}')

    # Add optional fields
    if [[ -n "$args" ]]; then
        entry=$(echo "$entry" | jq --arg v "$args" '. + {args: $v}')
    fi

    if [[ -n "$duration_turns" ]]; then
        entry=$(echo "$entry" | jq --argjson v "$duration_turns" '. + {duration_turns: $v}')
    fi

    # Context object
    local has_context=false
    local context='{}'
    if [[ -n "$project" ]]; then
        context=$(echo "$context" | jq --arg v "$project" '. + {project: $v}')
        has_context=true
    fi
    if [[ -n "$issue" ]]; then
        context=$(echo "$context" | jq --argjson v "$issue" '. + {issue: $v}')
        has_context=true
    fi
    if [[ -n "$worktree" ]]; then
        context=$(echo "$context" | jq --arg v "$worktree" '. + {worktree: $v}')
        has_context=true
    fi
    if [[ "$has_context" == true ]]; then
        entry=$(echo "$entry" | jq --argjson ctx "$context" '. + {context: $ctx}')
    fi

    # Error object
    if [[ -n "$error_category" ]]; then
        local error_obj
        error_obj=$(jq -n --arg cat "$error_category" --arg msg "$error_msg" \
            '{category: $cat, message: $msg}')
        if [[ -n "$error_phase" ]]; then
            error_obj=$(echo "$error_obj" | jq --arg v "$error_phase" '. + {phase: $v}')
        fi
        entry=$(echo "$entry" | jq --argjson err "$error_obj" '. + {error: $err}')
    fi

    # Recovery object
    if [[ -n "$recovery" ]]; then
        local recovery_obj
        recovery_obj=$(jq -n --arg action "$recovery" '{action: $action, successful: true}')
        if [[ -n "$recovery_turns" ]]; then
            recovery_obj=$(echo "$recovery_obj" | jq --argjson v "$recovery_turns" '. + {turns_spent: $v}')
        fi
        entry=$(echo "$entry" | jq --argjson rec "$recovery_obj" '. + {recovery: $rec}')
    fi

    # Write entry to file
    local filename="${now//:/-}"
    filename="${filename//T/-}"
    filename="${filename%Z}-${skill}.json"
    echo "$entry" > "$JOURNAL_DIR/$filename"

    echo "{\"status\":\"logged\",\"id\":\"$id\",\"file\":\"$filename\"}"
}

# ============================================================================
# Query Subcommand
# ============================================================================

cmd_query() {
    local since="" skill="" outcome="" limit="50"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --since) since="$2"; shift 2 ;;
            --skill) skill="$2"; shift 2 ;;
            --outcome) outcome="$2"; shift 2 ;;
            --limit) limit="$2"; shift 2 ;;
            *) die_json "Unknown option: $1" 1 ;;
        esac
    done

    ensure_journal_dir

    # Parse since date
    local since_iso=""
    if [[ -n "$since" ]]; then
        since_iso=$(parse_since "$since")
    fi

    # Collect all JSON files - handle empty directory
    local files=()
    for f in "$JOURNAL_DIR"/*.json; do
        [[ -f "$f" ]] && files+=("$f")
    done

    if [[ ${#files[@]} -eq 0 ]]; then
        echo "[]"
        return 0
    fi

    # Build jq filter for all conditions in one pass
    local jq_filter='.'
    if [[ -n "$skill" ]]; then
        jq_filter="$jq_filter | select(.skill == \$skill)"
    fi
    if [[ -n "$outcome" ]]; then
        jq_filter="$jq_filter | select(.outcome == \$outcome)"
    fi
    if [[ -n "$since_iso" ]]; then
        jq_filter="$jq_filter | select(.timestamp >= \$since_iso)"
    fi

    # Slurp all files and filter/sort in a single jq call
    jq -s \
        --arg skill "$skill" \
        --arg outcome "$outcome" \
        --arg since_iso "$since_iso" \
        --argjson lim "$limit" \
        "[.[] | $jq_filter] | sort_by(.timestamp) | reverse | .[:(\$lim)]" \
        "${files[@]}"
}

# ============================================================================
# Stats Subcommand
# ============================================================================

cmd_stats() {
    local since=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --since) since="$2"; shift 2 ;;
            *) die_json "Unknown option: $1" 1 ;;
        esac
    done

    local entries
    if [[ -n "$since" ]]; then
        entries=$(cmd_query --since "$since" --limit 9999)
    else
        entries=$(cmd_query --limit 9999)
    fi

    echo "$entries" | jq '{
        total: length,
        success: [.[] | select(.outcome == "success")] | length,
        failure: [.[] | select(.outcome == "failure")] | length,
        partial: [.[] | select(.outcome == "partial")] | length,
        by_skill: (group_by(.skill) | map({
            skill: .[0].skill,
            total: length,
            failures: [.[] | select(.outcome != "success")] | length
        }) | sort_by(-.failures)),
        by_category: ([.[] | select(.error != null) | .error.category] | group_by(.) | map({
            category: .[0],
            count: length
        }) | sort_by(-.count)),
        avg_recovery_turns: (
            [.[] | select(.recovery != null and .recovery.turns_spent != null) | .recovery.turns_spent]
            | if length > 0 then (add / length | . * 10 | round / 10) else 0 end
        )
    }'
}

# ============================================================================
# Main
# ============================================================================

SUBCMD="${1:-}"
shift || true

case "$SUBCMD" in
    log) cmd_log "$@" ;;
    query) cmd_query "$@" ;;
    stats) cmd_stats "$@" ;;
    *)
        cat <<'USAGE'
Usage: journal.sh <subcommand> [options]

Subcommands:
  log <skill> <outcome>  Record skill execution
  query [--since] [--skill] [--outcome]  Query entries
  stats [--since]  Show summary statistics

Examples:
  journal.sh log dev-kickoff success --issue 42 --duration-turns 15
  journal.sh log dev-kickoff failure --error-category env --error-msg "node_modules not found"
  journal.sh query --since 7d --skill dev-kickoff
  journal.sh stats --since 30d
USAGE
        exit 1
        ;;
esac
