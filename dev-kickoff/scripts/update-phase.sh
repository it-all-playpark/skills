#!/usr/bin/env bash
# update-phase.sh - Update phase status in kickoff state
# Usage: update-phase.sh <phase> <status> [--result "..."] [--error "..."] [--worktree PATH] [--reset-to PHASE] [--eval-result JSON]
#        [--termination-reason converged|max_iterations|stuck|fork_failure]
#        [--termination-final-verdict V] [--termination-verdict-history JSON] [--append-verdict JSON]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

PHASE=""
STATUS=""
RESULT=""
ERROR=""
WORKTREE=""
NEXT_ACTIONS=""
PR_URL=""
PR_NUMBER=""
RESET_TO=""
EVAL_RESULT=""
TERMINATION_REASON=""
TERMINATION_FINAL_VERDICT=""
TERMINATION_VERDICT_HISTORY=""
APPEND_VERDICT=""

# Valid phases and statuses for validation
VALID_PHASES="1_prepare 2_analyze 3_plan_impl 3b_plan_review 4_implement 5_validate 6_evaluate 7_commit 8_pr"
VALID_STATUSES="pending in_progress done failed skipped"

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --result) RESULT="$2"; shift 2 ;;
        --error) ERROR="$2"; shift 2 ;;
        --worktree) WORKTREE="$2"; shift 2 ;;
        --next) NEXT_ACTIONS="$2"; shift 2 ;;
        --pr-url) PR_URL="$2"; shift 2 ;;
        --pr-number) PR_NUMBER="$2"; shift 2 ;;
        --reset-to) RESET_TO="$2"; shift 2 ;;
        --eval-result) EVAL_RESULT="$2"; shift 2 ;;
        --termination-reason) TERMINATION_REASON="$2"; shift 2 ;;
        --termination-final-verdict) TERMINATION_FINAL_VERDICT="$2"; shift 2 ;;
        --termination-verdict-history) TERMINATION_VERDICT_HISTORY="$2"; shift 2 ;;
        --append-verdict) APPEND_VERDICT="$2"; shift 2 ;;
        -*)
            die_json "Unknown option: $1" 1
            ;;
        *)
            if [[ -z "$PHASE" ]]; then
                PHASE="$1"
            elif [[ -z "$STATUS" ]]; then
                STATUS="$1"
            fi
            shift
            ;;
    esac
done

[[ -n "$PHASE" ]] || die_json "Phase required (1_prepare|2_analyze|3_plan_impl|3b_plan_review|4_implement|5_validate|6_evaluate|7_commit|8_pr)" 1
[[ -n "$STATUS" ]] || die_json "Status required (pending|in_progress|done|failed|skipped)" 1

# Validate PHASE enum
if ! echo "$VALID_PHASES" | grep -qw "$PHASE"; then
    die_json "Invalid phase: $PHASE. Must be one of: $VALID_PHASES" 1
fi

# Validate STATUS enum
if ! echo "$VALID_STATUSES" | grep -qw "$STATUS"; then
    die_json "Invalid status: $STATUS. Must be one of: $VALID_STATUSES" 1
fi

# Find state file
if [[ -n "$WORKTREE" ]]; then
    # Validate worktree is a directory and within a git repo
    [[ -d "$WORKTREE" ]] || die_json "Worktree path does not exist: $WORKTREE" 1
    # Prevent path traversal - resolve to absolute path
    WORKTREE=$(cd "$WORKTREE" && pwd) || die_json "Cannot resolve worktree path" 1
    STATE_FILE="$WORKTREE/.claude/kickoff.json"
else
    # Try to find in current git root
    GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    if [[ -n "$GIT_ROOT" && -f "$GIT_ROOT/.claude/kickoff.json" ]]; then
        STATE_FILE="$GIT_ROOT/.claude/kickoff.json"
    else
        die_json "State file not found. Use --worktree or run from worktree directory." 1
    fi
fi

[[ -f "$STATE_FILE" ]] || die_json "State file not found: $STATE_FILE" 1

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build jq update using --arg to prevent injection
# Base update: set updated_at and phase status
JQ_ARGS=(--arg now "$NOW" --arg phase "$PHASE" --arg status "$STATUS")
JQ_FILTER='.updated_at = $now | .phases[$phase].status = $status'

case "$STATUS" in
    in_progress)
        JQ_FILTER="$JQ_FILTER | .phases[\$phase].started_at = \$now | .current_phase = \$phase"
        ;;
    done)
        JQ_FILTER="$JQ_FILTER | .phases[\$phase].completed_at = \$now"
        # Advance current_phase to next
        case "$PHASE" in
            1_prepare)  JQ_ARGS+=(--arg next "2_analyze"); JQ_FILTER="$JQ_FILTER | .current_phase = \$next" ;;
            2_analyze)  JQ_ARGS+=(--arg next "3_plan_impl"); JQ_FILTER="$JQ_FILTER | .current_phase = \$next" ;;
            3_plan_impl) JQ_ARGS+=(--arg next "3b_plan_review"); JQ_FILTER="$JQ_FILTER | .current_phase = \$next" ;;
            3b_plan_review) JQ_ARGS+=(--arg next "4_implement"); JQ_FILTER="$JQ_FILTER | .current_phase = \$next" ;;
            4_implement) JQ_ARGS+=(--arg next "5_validate"); JQ_FILTER="$JQ_FILTER | .current_phase = \$next" ;;
            5_validate) JQ_ARGS+=(--arg next "6_evaluate"); JQ_FILTER="$JQ_FILTER | .current_phase = \$next" ;;
            6_evaluate) JQ_ARGS+=(--arg next "7_commit"); JQ_FILTER="$JQ_FILTER | .current_phase = \$next" ;;
            7_commit)   JQ_ARGS+=(--arg next "8_pr"); JQ_FILTER="$JQ_FILTER | .current_phase = \$next" ;;
            8_pr)       JQ_ARGS+=(--arg next "completed"); JQ_FILTER="$JQ_FILTER | .current_phase = \$next" ;;
        esac
        ;;
    failed)
        JQ_FILTER="$JQ_FILTER | .phases[\$phase].completed_at = \$now"
        ;;
esac

if [[ -n "$RESULT" ]]; then
    JQ_ARGS+=(--arg result "$RESULT")
    JQ_FILTER="$JQ_FILTER | .phases[\$phase].result = \$result"
fi

if [[ -n "$ERROR" ]]; then
    JQ_ARGS+=(--arg error "$ERROR")
    JQ_FILTER="$JQ_FILTER | .phases[\$phase].error = \$error"
fi

if [[ -n "$NEXT_ACTIONS" ]]; then
    # Parse comma-separated actions into array safely
    JQ_ARGS+=(--arg actions "$NEXT_ACTIONS")
    JQ_FILTER="$JQ_FILTER | .next_actions = (\$actions | split(\",\") | map(. | gsub(\"^\\\\s+|\\\\s+$\"; \"\")))"
fi

# Handle PR info (for phase 6_pr completion)
if [[ -n "$PR_URL" || -n "$PR_NUMBER" ]]; then
    # Validate PR_NUMBER is numeric if provided
    if [[ -n "$PR_NUMBER" ]] && ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
        die_json "PR number must be a positive integer" 1
    fi

    JQ_FILTER="$JQ_FILTER | .pr = (.pr // {})"

    if [[ -n "$PR_NUMBER" ]]; then
        JQ_ARGS+=(--argjson pr_number "$PR_NUMBER")
        JQ_FILTER="$JQ_FILTER | .pr.number = \$pr_number"
    fi

    if [[ -n "$PR_URL" ]]; then
        JQ_ARGS+=(--arg pr_url "$PR_URL")
        JQ_FILTER="$JQ_FILTER | .pr.url = \$pr_url"
    fi

    JQ_FILTER="$JQ_FILTER | .pr.created_at = \$now"

    # Set next_action for pr-iterate handoff
    JQ_FILTER="$JQ_FILTER | .next_action = \"pr-iterate\""
fi

if [[ -n "$EVAL_RESULT" ]]; then
    JQ_ARGS+=(--argjson eval_result "$EVAL_RESULT")
    JQ_FILTER="$JQ_FILTER | .phases[\"6_evaluate\"].iterations += [\$eval_result]"
    JQ_FILTER="$JQ_FILTER | .phases[\"6_evaluate\"].current_iteration += 1"
    # Also mirror into termination.verdict_history (issue #53)
    # Construct a verdict entry from eval_result: {iteration, verdict, feedback_target?}
    JQ_FILTER="$JQ_FILTER | .phases[\"6_evaluate\"].termination = (.phases[\"6_evaluate\"].termination // {\"verdict_history\": []})"
    JQ_FILTER="$JQ_FILTER | .phases[\"6_evaluate\"].termination.verdict_history += [{"
    JQ_FILTER="$JQ_FILTER \"iteration\": .phases[\"6_evaluate\"].current_iteration,"
    JQ_FILTER="$JQ_FILTER \"verdict\": (\$eval_result.verdict // null),"
    JQ_FILTER="$JQ_FILTER \"feedback_target\": (\$eval_result.feedback_level // \$eval_result.feedback_target // null)"
    JQ_FILTER="$JQ_FILTER }]"
    JQ_FILTER="$JQ_FILTER | .phases[\"6_evaluate\"].termination.final_iteration = .phases[\"6_evaluate\"].current_iteration"
fi

# ----------------------------------------------------------------------------
# Termination block (issue #53) — unified Generator-Verifier loop state
# Only applies to 3b_plan_review and 6_evaluate phases.
# ----------------------------------------------------------------------------
if [[ -n "$TERMINATION_REASON" ]]; then
    case "$TERMINATION_REASON" in
        converged|max_iterations|stuck|fork_failure) ;;
        *) die_json "--termination-reason must be one of: converged, max_iterations, stuck, fork_failure" 1 ;;
    esac
    case "$PHASE" in
        3b_plan_review|6_evaluate) ;;
        *) die_json "--termination-reason only valid for 3b_plan_review or 6_evaluate (got: $PHASE)" 1 ;;
    esac

    if [[ -n "$TERMINATION_VERDICT_HISTORY" ]]; then
        if ! echo "$TERMINATION_VERDICT_HISTORY" | jq -e 'type == "array"' >/dev/null 2>&1; then
            die_json "--termination-verdict-history must be a JSON array" 1
        fi
    fi
    if [[ -n "$APPEND_VERDICT" ]]; then
        if ! echo "$APPEND_VERDICT" | jq -e 'type == "object"' >/dev/null 2>&1; then
            die_json "--append-verdict must be a JSON object" 1
        fi
    fi

    JQ_ARGS+=(--arg termination_reason "$TERMINATION_REASON")
    JQ_FILTER="$JQ_FILTER | .phases[\$phase].termination = (.phases[\$phase].termination // {\"verdict_history\": []})"
    JQ_FILTER="$JQ_FILTER | .phases[\$phase].termination.reason = \$termination_reason"
    JQ_FILTER="$JQ_FILTER | .phases[\$phase].termination.recorded_at = \$now"

    if [[ -n "$TERMINATION_VERDICT_HISTORY" ]]; then
        JQ_ARGS+=(--argjson termination_history "$TERMINATION_VERDICT_HISTORY")
        JQ_FILTER="$JQ_FILTER | .phases[\$phase].termination.verdict_history = \$termination_history"
    elif [[ -n "$APPEND_VERDICT" ]]; then
        JQ_ARGS+=(--argjson append_verdict "$APPEND_VERDICT")
        JQ_FILTER="$JQ_FILTER | .phases[\$phase].termination.verdict_history = ((.phases[\$phase].termination.verdict_history // []) + [\$append_verdict])"
    fi

    if [[ -n "$TERMINATION_FINAL_VERDICT" ]]; then
        JQ_ARGS+=(--arg termination_final_verdict "$TERMINATION_FINAL_VERDICT")
        JQ_FILTER="$JQ_FILTER | .phases[\$phase].termination.final_verdict = \$termination_final_verdict"
    fi

    # Sync final_iteration from verdict_history length
    JQ_FILTER="$JQ_FILTER | .phases[\$phase].termination.final_iteration = (.phases[\$phase].termination.verdict_history | length)"
fi

if [[ -n "$RESET_TO" ]]; then
    # Reset phases from RESET_TO onwards to pending
    # --reset-to must be used with "done" status. The normal done transition
    # is applied first, then this override resets phases and current_phase.
    PHASE_ORDER=("3_plan_impl" "3b_plan_review" "4_implement" "5_validate" "6_evaluate")
    resetting=false
    for p in "${PHASE_ORDER[@]}"; do
        if [[ "$p" == "$RESET_TO" ]]; then
            resetting=true
        fi
        if [[ "$resetting" == true ]]; then
            JQ_FILTER="$JQ_FILTER | .phases[\"$p\"].status = \"pending\""
        fi
    done
    JQ_FILTER="$JQ_FILTER | .current_phase = \"$RESET_TO\""
fi

# Apply update
TMP_FILE=$(mktemp)
if jq "${JQ_ARGS[@]}" "$JQ_FILTER" "$STATE_FILE" > "$TMP_FILE"; then
    mv "$TMP_FILE" "$STATE_FILE"
    echo "{\"status\":\"updated\",\"phase\":\"$PHASE\",\"new_status\":\"$STATUS\"}"
else
    rm -f "$TMP_FILE"
    die_json "Failed to update state" 1
fi