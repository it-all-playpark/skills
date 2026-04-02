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
    local project="" worktree="" mode=""

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
            --mode) mode="$2"; shift 2 ;;
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
    if [[ -n "$mode" ]]; then
        context=$(echo "$context" | jq --arg v "$mode" '. + {mode: $v}')
        has_context=true
    fi
    if [[ -n "$context_extra" ]]; then
        context=$(echo "$context" | jq --argjson v "$context_extra" '. * $v')
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
# Hook Capture Subcommand
# ============================================================================

# Error classification patterns (from error-categories.md)
classify_error() {
    local msg="$1"
    if echo "$msg" | grep -qiE 'eslint|prettier|biome|stylelint|lint.*error'; then
        echo "lint"
    elif echo "$msg" | grep -qiE 'test.*fail|assert|expect.*to|FAIL.*test'; then
        echo "test"
    elif echo "$msg" | grep -qiE 'build.*fail|compile.*error|esbuild|webpack.*error|vite.*error'; then
        echo "build"
    elif echo "$msg" | grep -qiE 'CONFLICT|merge.*fail|rebase.*conflict|cannot.*merge'; then
        echo "merge"
    elif echo "$msg" | grep -qiE 'TS[0-9]+:|type.*error|mypy.*error|no.*overload'; then
        echo "type-check"
    elif echo "$msg" | grep -qiE 'node_modules|ENOENT.*package|pip.*not found|command not found|version.*mismatch'; then
        echo "env"
    elif echo "$msg" | grep -qiE 'config.*not found|invalid.*config|missing.*setting'; then
        echo "config"
    else
        echo "runtime"
    fi
}

# Called from PostToolUseFailure hook — only fires on actual tool failures
cmd_hook_capture() {
    local input
    input=$(cat)

    # Parse PostToolUseFailure JSON from stdin
    local tool_name tool_input tool_result session_id
    tool_name=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null) || return 0
    tool_input=$(echo "$input" | jq -c '.tool_input // {}' 2>/dev/null) || return 0
    tool_result=$(echo "$input" | jq -r '.tool_response // .tool_result // empty' 2>/dev/null) || return 0
    session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)

    [[ -z "$tool_name" ]] && return 0

    # Extract error snippet (first 3 lines with error context, max 300 chars)
    local error_snippet
    error_snippet=$(echo "$tool_result" | grep -iE 'error|fail|exception|fatal|panic|denied|not found' | head -3 | cut -c1-300)
    [[ -z "$error_snippet" ]] && error_snippet=$(echo "$tool_result" | head -3 | cut -c1-300)

    # Classify error
    local category
    category=$(classify_error "$error_snippet")

    # Extract command for Bash tool (useful context)
    local input_summary
    if [[ "$tool_name" == "Bash" ]]; then
        input_summary=$(echo "$tool_input" | jq -r '.command // empty' 2>/dev/null | cut -c1-200)
    elif [[ "$tool_name" == "Skill" ]]; then
        input_summary=$(echo "$tool_input" | jq -r '.skill // empty' 2>/dev/null)
    else
        input_summary=$(echo "$tool_input" | jq -c '.' 2>/dev/null | cut -c1-200)
    fi

    # Read active skill context from state file (written by PreToolUse Skill hook)
    local active_skill=""
    local state_file="/tmp/claude-skill-ctx-${session_id}"
    if [[ -n "$session_id" && -f "$state_file" ]]; then
        active_skill=$(cat "$state_file" 2>/dev/null)
    fi

    # Build skill name: prefer active skill context, fallback to tool name
    local skill_label
    if [[ -n "$active_skill" ]]; then
        skill_label="$active_skill"
    else
        skill_label="hook-$tool_name"
    fi

    ensure_journal_dir

    local now
    now=$(iso_now)
    local id
    id=$(entry_id "$now" "$skill_label")

    # Build context object
    local context
    context=$(jq -n \
        --arg tool_name "$tool_name" \
        --arg input_summary "$input_summary" \
        --arg session_id "$session_id" \
        --arg active_skill "$active_skill" \
        '{tool_name: $tool_name, input_summary: $input_summary, session_id: $session_id}
         | if $active_skill != "" then . + {active_skill: $active_skill} else . end
         | with_entries(select(.value != ""))')

    local entry
    entry=$(jq -n \
        --arg version "1.0.0" \
        --arg id "$id" \
        --arg timestamp "$now" \
        --arg skill "$skill_label" \
        --arg outcome "failure" \
        --arg err_category "$category" \
        --arg err_message "$error_snippet" \
        --argjson context "$context" \
        '{
            version: $version,
            id: $id,
            timestamp: $timestamp,
            skill: $skill,
            outcome: "failure",
            source: "hook-capture",
            context: $context,
            error: {
                category: $err_category,
                message: $err_message
            }
        }')

    local filename="${now//:/-}"
    filename="${filename//T/-}"
    filename="${filename%Z}-${skill_label}.json"
    echo "$entry" > "$JOURNAL_DIR/$filename"
}

# Track active skill: called by PreToolUse Skill hook to write state file
cmd_track_skill() {
    local input
    input=$(cat)

    local skill_name session_id
    skill_name=$(echo "$input" | jq -r '.tool_input.skill // empty' 2>/dev/null) || return 0
    session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null) || return 0

    [[ -z "$skill_name" || -z "$session_id" ]] && return 0

    echo "$skill_name" > "/tmp/claude-skill-ctx-${session_id}"
}

# ============================================================================
# Main
# ============================================================================

SUBCMD="${1:-}"
shift || true

case "$SUBCMD" in
    log) cmd_log "$@" ;;
    hook-capture) cmd_hook_capture ;;
    track-skill) cmd_track_skill ;;
    query) cmd_query "$@" ;;
    stats) cmd_stats "$@" ;;
    *)
        cat <<'USAGE'
Usage: journal.sh <subcommand> [options]

Subcommands:
  log <skill> <outcome>  Record skill execution
  hook-capture           Capture failures from PostToolUse hook (reads stdin)
  track-skill            Track active skill from PreToolUse Skill hook (reads stdin)
  query [--since] [--skill] [--outcome]  Query entries
  stats [--since]  Show summary statistics

Examples:
  journal.sh log dev-kickoff success --issue 42 --duration-turns 15
  journal.sh log dev-kickoff failure --error-category env --error-msg "node_modules not found"
  journal.sh hook-capture < posttooluse.json
  journal.sh query --since 7d --skill dev-kickoff
  journal.sh stats --since 30d
USAGE
        exit 1
        ;;
esac
