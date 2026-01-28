#!/usr/bin/env bash
# merge-subagent-result.sh - Merge subagent results into state
# Usage: merge-subagent-result.sh <phase> --result "..." [--worktree PATH]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common.sh"

require_cmd jq

PHASE=""
RESULT=""
WORKTREE=""
SUBAGENT_TYPE=""
SUBAGENT_ID=""

# Valid phases for validation
VALID_PHASES="1_prepare 2_analyze 3_implement 4_validate 5_commit 6_pr"

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --result) RESULT="$2"; shift 2 ;;
        --worktree) WORKTREE="$2"; shift 2 ;;
        --subagent-type) SUBAGENT_TYPE="$2"; shift 2 ;;
        --subagent-id) SUBAGENT_ID="$2"; shift 2 ;;
        -*)
            die_json "Unknown option: $1" 1
            ;;
        *)
            if [[ -z "$PHASE" ]]; then
                PHASE="$1"
            fi
            shift
            ;;
    esac
done

[[ -n "$PHASE" ]] || die_json "Phase required" 1
[[ -n "$RESULT" ]] || die_json "Result required (--result)" 1

# Validate PHASE enum
if ! echo "$VALID_PHASES" | grep -qw "$PHASE"; then
    die_json "Invalid phase: $PHASE. Must be one of: $VALID_PHASES" 1
fi

# Find state file
if [[ -n "$WORKTREE" ]]; then
    # Validate worktree is a directory
    [[ -d "$WORKTREE" ]] || die_json "Worktree path does not exist: $WORKTREE" 1
    # Prevent path traversal - resolve to absolute path
    WORKTREE=$(cd "$WORKTREE" && pwd) || die_json "Cannot resolve worktree path" 1
    STATE_FILE="$WORKTREE/.claude/kickoff.json"
else
    GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    if [[ -n "$GIT_ROOT" && -f "$GIT_ROOT/.claude/kickoff.json" ]]; then
        STATE_FILE="$GIT_ROOT/.claude/kickoff.json"
    else
        die_json "State file not found" 1
    fi
fi

[[ -f "$STATE_FILE" ]] || die_json "State file not found: $STATE_FILE" 1

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TIMESTAMP_KEY=$(date +%s)

# Build jq args and filter using --arg to prevent injection
JQ_ARGS=(--arg now "$NOW" --arg phase "$PHASE" --arg result "$RESULT" --arg ts_key "$TIMESTAMP_KEY")
JQ_FILTER='.updated_at = $now | .phases[$phase].subagent_results = (.phases[$phase].subagent_results // {}) + {($ts_key): {timestamp: $now, result: $result}}'

if [[ -n "$SUBAGENT_TYPE" ]]; then
    JQ_ARGS+=(--arg subagent_type "$SUBAGENT_TYPE")
    JQ_FILTER='.updated_at = $now | .phases[$phase].subagent_results = (.phases[$phase].subagent_results // {}) + {($ts_key): {timestamp: $now, result: $result, type: $subagent_type}}'
fi

if [[ -n "$SUBAGENT_ID" ]]; then
    JQ_ARGS+=(--arg subagent_id "$SUBAGENT_ID")
    # Rebuild filter with id included
    if [[ -n "$SUBAGENT_TYPE" ]]; then
        JQ_FILTER='.updated_at = $now | .phases[$phase].subagent_results = (.phases[$phase].subagent_results // {}) + {($ts_key): {timestamp: $now, result: $result, type: $subagent_type, id: $subagent_id}}'
    else
        JQ_FILTER='.updated_at = $now | .phases[$phase].subagent_results = (.phases[$phase].subagent_results // {}) + {($ts_key): {timestamp: $now, result: $result, id: $subagent_id}}'
    fi
fi

# Update state
TMP_FILE=$(mktemp)
if jq "${JQ_ARGS[@]}" "$JQ_FILTER" "$STATE_FILE" > "$TMP_FILE"; then
    mv "$TMP_FILE" "$STATE_FILE"
    echo "{\"status\":\"merged\",\"phase\":\"$PHASE\",\"timestamp\":\"$NOW\"}"
else
    rm -f "$TMP_FILE"
    die_json "Failed to merge subagent result" 1
fi