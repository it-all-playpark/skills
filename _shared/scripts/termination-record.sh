#!/usr/bin/env bash
# termination-record.sh - Record termination block for Generator-Verifier loops
#
# Unified interface for recording the termination state of the two
# evaluator-optimizer loops inside dev-kickoff:
#   - phases.3b_plan_review (Phase 3 ⇄ 3b: dev-plan-impl ⇄ dev-plan-review)
#   - phases.6_evaluate     (Phase 4-5 ⇄ 6: dev-implement/validate ⇄ dev-evaluate)
#
# Writes `phases[<phase>].termination` using the unified schema.
# See: dev-kickoff/references/kickoff-schema.md `termination` block.
#
# Usage:
#   termination-record.sh <phase> <reason> \
#     --worktree PATH \
#     [--final-iteration N] \
#     [--final-verdict VERDICT] \
#     [--verdict-history JSON]        # replace whole array
#     [--append-verdict JSON]         # push single verdict object
#
# <phase>  : 3b_plan_review | 6_evaluate
# <reason> : converged | max_iterations | stuck | fork_failure
#
# Output: {"status":"recorded","phase":"<phase>","reason":"<reason>","final_iteration":N}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

VALID_PHASES="3b_plan_review 6_evaluate"
VALID_REASONS="converged max_iterations stuck fork_failure"

PHASE=""
REASON=""
WORKTREE=""
FINAL_ITERATION=""
FINAL_VERDICT=""
VERDICT_HISTORY=""
APPEND_VERDICT=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree) WORKTREE="$2"; shift 2 ;;
        --final-iteration) FINAL_ITERATION="$2"; shift 2 ;;
        --final-verdict) FINAL_VERDICT="$2"; shift 2 ;;
        --verdict-history) VERDICT_HISTORY="$2"; shift 2 ;;
        --append-verdict) APPEND_VERDICT="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,27p' "$0"
            exit 0
            ;;
        -*)
            die_json "Unknown option: $1" 1
            ;;
        *)
            if [[ -z "$PHASE" ]]; then
                PHASE="$1"
            elif [[ -z "$REASON" ]]; then
                REASON="$1"
            else
                die_json "Unexpected positional argument: $1" 1
            fi
            shift
            ;;
    esac
done

[[ -n "$PHASE" ]] || die_json "Phase required ($VALID_PHASES)" 1
[[ -n "$REASON" ]] || die_json "Reason required ($VALID_REASONS)" 1

# Validate enums
if ! echo "$VALID_PHASES" | grep -qw "$PHASE"; then
    die_json "Invalid phase: $PHASE. Must be one of: $VALID_PHASES" 1
fi
if ! echo "$VALID_REASONS" | grep -qw "$REASON"; then
    die_json "Invalid reason: $REASON. Must be one of: $VALID_REASONS" 1
fi

# Find state file
if [[ -n "$WORKTREE" ]]; then
    [[ -d "$WORKTREE" ]] || die_json "Worktree path does not exist: $WORKTREE" 1
    WORKTREE=$(cd "$WORKTREE" && pwd) || die_json "Cannot resolve worktree path" 1
    STATE_FILE="$WORKTREE/.claude/kickoff.json"
else
    GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    if [[ -n "$GIT_ROOT" && -f "$GIT_ROOT/.claude/kickoff.json" ]]; then
        STATE_FILE="$GIT_ROOT/.claude/kickoff.json"
    else
        die_json "State file not found. Use --worktree or run from worktree directory." 1
    fi
fi

[[ -f "$STATE_FILE" ]] || die_json "State file not found: $STATE_FILE" 1

# Validate JSON payloads if provided
if [[ -n "$VERDICT_HISTORY" ]]; then
    if ! echo "$VERDICT_HISTORY" | jq -e 'type == "array"' >/dev/null 2>&1; then
        die_json "--verdict-history must be a JSON array" 1
    fi
fi
if [[ -n "$APPEND_VERDICT" ]]; then
    if ! echo "$APPEND_VERDICT" | jq -e 'type == "object"' >/dev/null 2>&1; then
        die_json "--append-verdict must be a JSON object" 1
    fi
fi

if [[ -n "$FINAL_ITERATION" ]]; then
    if ! [[ "$FINAL_ITERATION" =~ ^[0-9]+$ ]]; then
        die_json "--final-iteration must be a non-negative integer" 1
    fi
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build jq filter
JQ_ARGS=(
    --arg now "$NOW"
    --arg phase "$PHASE"
    --arg reason "$REASON"
)

# Ensure phase object exists, then ensure termination object exists
JQ_FILTER='
  .updated_at = $now
  | .phases[$phase] = (.phases[$phase] // {})
  | .phases[$phase].termination = (.phases[$phase].termination // {"verdict_history": []})
  | .phases[$phase].termination.reason = $reason
  | .phases[$phase].termination.recorded_at = $now
'

# verdict_history: replace takes priority over append
if [[ -n "$VERDICT_HISTORY" ]]; then
    JQ_ARGS+=(--argjson history "$VERDICT_HISTORY")
    JQ_FILTER+='
      | .phases[$phase].termination.verdict_history = $history
    '
elif [[ -n "$APPEND_VERDICT" ]]; then
    JQ_ARGS+=(--argjson verdict "$APPEND_VERDICT")
    JQ_FILTER+='
      | .phases[$phase].termination.verdict_history =
          ((.phases[$phase].termination.verdict_history // []) + [$verdict])
    '
fi

# final_iteration: explicit value OR derived from history length
if [[ -n "$FINAL_ITERATION" ]]; then
    JQ_ARGS+=(--argjson final_iteration "$FINAL_ITERATION")
    JQ_FILTER+='
      | .phases[$phase].termination.final_iteration = $final_iteration
    '
else
    JQ_FILTER+='
      | .phases[$phase].termination.final_iteration =
          (.phases[$phase].termination.verdict_history | length)
    '
fi

if [[ -n "$FINAL_VERDICT" ]]; then
    JQ_ARGS+=(--arg final_verdict "$FINAL_VERDICT")
    JQ_FILTER+='
      | .phases[$phase].termination.final_verdict = $final_verdict
    '
fi

# Apply update atomically
TMP_FILE=$(mktemp)
if jq "${JQ_ARGS[@]}" "$JQ_FILTER" "$STATE_FILE" > "$TMP_FILE"; then
    mv "$TMP_FILE" "$STATE_FILE"
    # Read final_iteration back for the response
    FI=$(jq -r ".phases[\"$PHASE\"].termination.final_iteration // 0" "$STATE_FILE")
    printf '{"status":"recorded","phase":"%s","reason":"%s","final_iteration":%s}\n' "$PHASE" "$REASON" "$FI"
else
    rm -f "$TMP_FILE"
    die_json "Failed to record termination state" 1
fi
