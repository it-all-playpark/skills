#!/usr/bin/env bash
# hunt-state.sh - State management helper for bug-hunt skill
# Usage: hunt-state.sh <command> [options]
#
# Commands:
#   init              Initialize bug-hunt-state.json
#   add-hypothesis    Add a new hypothesis
#   update-hypothesis Update hypothesis status
#   check-budget      Check remaining turn budget
#   read              Read current state

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

# ============================================================================
# Defaults
# ============================================================================
COMMAND=""
REPO_PATH="."
TARGET=""
MAX_HYPOTHESES=8
MAX_TURNS=30

# Hypothesis fields
HYP_ID=""
HYP_DESC=""
HYP_CATEGORY=""
HYP_STATUS=""
HYP_ASSIGNED=""
HYP_REASON=""
HYP_EVIDENCE=""

# ============================================================================
# Parse arguments
# ============================================================================
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            init|add-hypothesis|update-hypothesis|check-budget|read)
                COMMAND="$1"; shift ;;
            --target) TARGET="$2"; shift 2 ;;
            --max-hypotheses) MAX_HYPOTHESES="$2"; shift 2 ;;
            --max-turns) MAX_TURNS="$2"; shift 2 ;;
            --repo-path) REPO_PATH="$2"; shift 2 ;;
            --id) HYP_ID="$2"; shift 2 ;;
            --description) HYP_DESC="$2"; shift 2 ;;
            --category) HYP_CATEGORY="$2"; shift 2 ;;
            --status) HYP_STATUS="$2"; shift 2 ;;
            --assigned-to) HYP_ASSIGNED="$2"; shift 2 ;;
            --reason) HYP_REASON="$2"; shift 2 ;;
            --evidence) HYP_EVIDENCE="$2"; shift 2 ;;
            -h|--help) usage; exit 0 ;;
            *) die_json "Unknown argument: $1" 1 ;;
        esac
    done

    [[ -n "$COMMAND" ]] || die_json "Command required: init|add-hypothesis|update-hypothesis|check-budget|read" 1
}

usage() {
    cat <<'EOF'
Usage: hunt-state.sh <command> [options]

Commands:
  init                Initialize state file
  add-hypothesis      Add a hypothesis
  update-hypothesis   Update hypothesis status
  check-budget        Check turn budget
  read                Read current state

Options:
  --target <text>         Issue or description (init)
  --max-hypotheses <N>    Max hypotheses (init, default: 8)
  --max-turns <N>         Max turns (init, default: 30)
  --repo-path <path>      Repository path (default: .)
  --id <id>               Hypothesis ID
  --description <text>    Hypothesis description
  --category <cat>        Category: logic|state|external|environment
  --status <status>       Status: pending|investigating|confirmed|rejected
  --assigned-to <name>    Investigator name
  --reason <text>         Rejection/confirmation reason
  --evidence <text>       Evidence (comma-separated)
EOF
}

# ============================================================================
# State file path resolution
# ============================================================================
resolve_state_file() {
    local repo
    repo=$(cd "$REPO_PATH" && pwd) || die_json "Cannot resolve repo path: $REPO_PATH" 1
    echo "$repo/.claude/bug-hunt-state.json"
}

ensure_state_exists() {
    local state_file
    state_file=$(resolve_state_file)
    [[ -f "$state_file" ]] || die_json "State file not found: $state_file. Run 'init' first." 1
    echo "$state_file"
}

# ============================================================================
# Commands
# ============================================================================

cmd_init() {
    [[ -n "$TARGET" ]] || die_json "--target required for init" 1

    local state_file
    state_file=$(resolve_state_file)
    local state_dir
    state_dir=$(dirname "$state_file")
    mkdir -p "$state_dir"

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    jq -n \
        --arg version "1.0.0" \
        --arg target "$TARGET" \
        --arg status "triaging" \
        --argjson max_hypotheses "$MAX_HYPOTHESES" \
        --argjson max_turns "$MAX_TURNS" \
        --argjson turns_used 0 \
        --arg created_at "$now" \
        --arg updated_at "$now" \
        '{
            version: $version,
            target: $target,
            status: $status,
            config: {
                max_hypotheses: $max_hypotheses,
                max_turns: $max_turns
            },
            turns_used: $turns_used,
            hypotheses: [],
            findings: [],
            root_cause: null,
            fix_proposal: null,
            created_at: $created_at,
            updated_at: $updated_at
        }' > "$state_file"

    echo "{\"status\":\"initialized\",\"state_file\":\"$state_file\"}"
}

cmd_add_hypothesis() {
    [[ -n "$HYP_ID" ]] || die_json "--id required" 1
    [[ -n "$HYP_DESC" ]] || die_json "--description required" 1

    local state_file
    state_file=$(ensure_state_exists)

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Check max hypotheses limit
    local current_count
    current_count=$(jq '.hypotheses | length' "$state_file")
    local max
    max=$(jq '.config.max_hypotheses' "$state_file")

    if [[ "$current_count" -ge "$max" ]]; then
        die_json "Max hypotheses limit reached ($max). Reject or remove a hypothesis first." 1
    fi

    # Check for duplicate ID
    local exists
    exists=$(jq --arg id "$HYP_ID" '.hypotheses | map(select(.id == $id)) | length' "$state_file")
    if [[ "$exists" -gt 0 ]]; then
        die_json "Hypothesis with id '$HYP_ID' already exists" 1
    fi

    local tmp
    tmp=$(mktemp)

    jq --arg id "$HYP_ID" \
       --arg desc "$HYP_DESC" \
       --arg cat "${HYP_CATEGORY:-unknown}" \
       --arg status "${HYP_STATUS:-pending}" \
       --arg assigned "${HYP_ASSIGNED:-}" \
       --arg now "$now" \
       '.hypotheses += [{
            id: $id,
            description: $desc,
            category: $cat,
            status: $status,
            assigned_to: (if $assigned == "" then null else $assigned end),
            evidence: [],
            rejected_reason: null,
            created_at: $now
        }] | .updated_at = $now' "$state_file" > "$tmp" && mv "$tmp" "$state_file"

    echo "{\"status\":\"added\",\"hypothesis_id\":\"$HYP_ID\"}"
}

cmd_update_hypothesis() {
    [[ -n "$HYP_ID" ]] || die_json "--id required" 1

    local state_file
    state_file=$(ensure_state_exists)

    # Verify hypothesis exists
    local exists
    exists=$(jq --arg id "$HYP_ID" '.hypotheses | map(select(.id == $id)) | length' "$state_file")
    if [[ "$exists" -eq 0 ]]; then
        die_json "Hypothesis '$HYP_ID' not found" 1
    fi

    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Build update filter
    local jq_filter='.updated_at = $now'
    local -a jq_args=(--arg id "$HYP_ID" --arg now "$now")

    if [[ -n "$HYP_STATUS" ]]; then
        # Validate status
        case "$HYP_STATUS" in
            pending|investigating|confirmed|rejected) ;;
            *) die_json "Invalid hypothesis status: $HYP_STATUS. Use: pending|investigating|confirmed|rejected" 1 ;;
        esac
        jq_args+=(--arg new_status "$HYP_STATUS")
        jq_filter="$jq_filter | .hypotheses = [.hypotheses[] | if .id == \$id then .status = \$new_status else . end]"
    fi

    if [[ -n "$HYP_ASSIGNED" ]]; then
        jq_args+=(--arg assigned "$HYP_ASSIGNED")
        jq_filter="$jq_filter | .hypotheses = [.hypotheses[] | if .id == \$id then .assigned_to = \$assigned else . end]"
    fi

    if [[ -n "$HYP_REASON" ]]; then
        jq_args+=(--arg reason "$HYP_REASON")
        jq_filter="$jq_filter | .hypotheses = [.hypotheses[] | if .id == \$id then .rejected_reason = \$reason else . end]"
    fi

    if [[ -n "$HYP_EVIDENCE" ]]; then
        jq_args+=(--arg evidence "$HYP_EVIDENCE")
        jq_filter="$jq_filter | .hypotheses = [.hypotheses[] | if .id == \$id then .evidence += [\$evidence] else . end]"
    fi

    # Update overall status if a hypothesis is confirmed
    if [[ "$HYP_STATUS" == "confirmed" ]]; then
        jq_filter="$jq_filter | .status = \"converging\""
    fi

    local tmp
    tmp=$(mktemp)

    if jq "${jq_args[@]}" "$jq_filter" "$state_file" > "$tmp"; then
        mv "$tmp" "$state_file"
        echo "{\"status\":\"updated\",\"hypothesis_id\":\"$HYP_ID\"}"
    else
        rm -f "$tmp"
        die_json "Failed to update hypothesis" 1
    fi
}

cmd_check_budget() {
    local state_file
    state_file=$(ensure_state_exists)

    local turns_used max_turns remaining pct
    turns_used=$(jq '.turns_used' "$state_file")
    max_turns=$(jq '.config.max_turns' "$state_file")
    remaining=$((max_turns - turns_used))
    if [[ "$max_turns" -gt 0 ]]; then
        pct=$(( (turns_used * 100) / max_turns ))
    else
        pct=0
    fi

    local warning=""
    if [[ "$pct" -ge 80 ]]; then
        warning="CRITICAL: Budget nearly exhausted. Consider converging."
    elif [[ "$pct" -ge 60 ]]; then
        warning="WARNING: Over 60% budget used. Prioritize strongest hypotheses."
    fi

    jq -n \
        --argjson used "$turns_used" \
        --argjson max "$max_turns" \
        --argjson remaining "$remaining" \
        --argjson pct "$pct" \
        --arg warning "$warning" \
        '{
            turns_used: $used,
            max_turns: $max,
            remaining: $remaining,
            percent_used: $pct,
            warning: (if $warning == "" then null else $warning end),
            within_budget: ($remaining > 0)
        }'
}

cmd_read() {
    local state_file
    state_file=$(ensure_state_exists)
    jq '.' "$state_file"
}

# ============================================================================
# Main
# ============================================================================
parse_args "$@"

case "$COMMAND" in
    init) cmd_init ;;
    add-hypothesis) cmd_add_hypothesis ;;
    update-hypothesis) cmd_update_hypothesis ;;
    check-budget) cmd_check_budget ;;
    read) cmd_read ;;
    *) die_json "Unknown command: $COMMAND" 1 ;;
esac
