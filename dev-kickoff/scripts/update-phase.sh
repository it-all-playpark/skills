#!/usr/bin/env bash
# update-phase.sh - Update phase status in kickoff state
# Usage: update-phase.sh <phase> <status> [--result "..."] [--error "..."] [--worktree PATH] [--reset-to PHASE] [--eval-result JSON]
#        [--escalated true|false] [--escalation-reason max_iterations|stuck|fork_failure]
#        [--stuck-findings JSON] [--review-iteration N] [--review-verdict pass|revise|block] [--review-score N]

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
ESCALATED=""
ESCALATION_REASON=""
STUCK_FINDINGS=""
REVIEW_ITERATION=""
REVIEW_VERDICT=""
REVIEW_SCORE=""

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
        --escalated) ESCALATED="$2"; shift 2 ;;
        --escalation-reason) ESCALATION_REASON="$2"; shift 2 ;;
        --stuck-findings) STUCK_FINDINGS="$2"; shift 2 ;;
        --review-iteration) REVIEW_ITERATION="$2"; shift 2 ;;
        --review-verdict) REVIEW_VERDICT="$2"; shift 2 ;;
        --review-score) REVIEW_SCORE="$2"; shift 2 ;;
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
fi

# Plan-Review Loop (Phase 3b) escalation / state fields
if [[ -n "$ESCALATED" ]]; then
    if [[ "$ESCALATED" != "true" && "$ESCALATED" != "false" ]]; then
        die_json "--escalated must be 'true' or 'false'" 1
    fi
    JQ_ARGS+=(--argjson escalated "$ESCALATED")
    JQ_FILTER="$JQ_FILTER | .phases[\"3b_plan_review\"].escalated = \$escalated"
fi

if [[ -n "$ESCALATION_REASON" ]]; then
    case "$ESCALATION_REASON" in
        max_iterations|stuck|fork_failure) ;;
        *) die_json "--escalation-reason must be one of: max_iterations, stuck, fork_failure" 1 ;;
    esac
    JQ_ARGS+=(--arg escalation_reason "$ESCALATION_REASON")
    JQ_FILTER="$JQ_FILTER | .phases[\"3b_plan_review\"].escalation_reason = \$escalation_reason"
fi

if [[ -n "$STUCK_FINDINGS" ]]; then
    # Must be a JSON array
    if ! echo "$STUCK_FINDINGS" | jq -e 'type == "array"' >/dev/null 2>&1; then
        die_json "--stuck-findings must be a JSON array" 1
    fi
    JQ_ARGS+=(--argjson stuck_findings "$STUCK_FINDINGS")
    JQ_FILTER="$JQ_FILTER | .phases[\"3b_plan_review\"].stuck_findings = \$stuck_findings"
fi

if [[ -n "$REVIEW_ITERATION" ]]; then
    if ! [[ "$REVIEW_ITERATION" =~ ^[0-9]+$ ]]; then
        die_json "--review-iteration must be a non-negative integer" 1
    fi
    JQ_ARGS+=(--argjson review_iteration "$REVIEW_ITERATION")
    JQ_FILTER="$JQ_FILTER | .phases[\"3b_plan_review\"].current_iteration = \$review_iteration"
fi

if [[ -n "$REVIEW_VERDICT" ]]; then
    case "$REVIEW_VERDICT" in
        pass|revise|block) ;;
        *) die_json "--review-verdict must be one of: pass, revise, block" 1 ;;
    esac
    JQ_ARGS+=(--arg review_verdict "$REVIEW_VERDICT")
    JQ_FILTER="$JQ_FILTER | .phases[\"3b_plan_review\"].last_verdict = \$review_verdict"
fi

if [[ -n "$REVIEW_SCORE" ]]; then
    if ! [[ "$REVIEW_SCORE" =~ ^[0-9]+$ ]]; then
        die_json "--review-score must be a non-negative integer" 1
    fi
    JQ_ARGS+=(--argjson review_score "$REVIEW_SCORE")
    JQ_FILTER="$JQ_FILTER | .phases[\"3b_plan_review\"].last_score = \$review_score"
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