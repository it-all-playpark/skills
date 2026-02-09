#!/usr/bin/env bash
# flow-status.sh - Check dev-flow state and determine next action
# Supports both single mode (kickoff.json) and parallel mode (flow.json)
# Usage: flow-status.sh [--worktree PATH] [--flow-state PATH]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

WORKTREE=""
FLOW_STATE=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree) WORKTREE="$2"; shift 2 ;;
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        -*)
            die_json "Unknown option: $1" 1
            ;;
        *)
            if [[ -z "$WORKTREE" ]]; then
                WORKTREE="$1"
            fi
            shift
            ;;
    esac
done

# ============================================================================
# Parallel mode: flow.json takes precedence
# ============================================================================
if [[ -n "$FLOW_STATE" && -f "$FLOW_STATE" ]]; then
    STATUS=$(jq -r '.status // "unknown"' "$FLOW_STATE")
    ISSUE=$(jq -r '.issue // "unknown"' "$FLOW_STATE")
    SUBTASK_COUNT=$(jq '.subtasks | length' "$FLOW_STATE")
    COMPLETED_COUNT=$(jq '[.subtasks[] | select(.status == "completed")] | length' "$FLOW_STATE")
    FAILED_COUNT=$(jq '[.subtasks[] | select(.status == "failed")] | length' "$FLOW_STATE")
    PR_NUMBER=$(jq -r '.pr.number // ""' "$FLOW_STATE")
    PR_URL=$(jq -r '.pr.url // ""' "$FLOW_STATE")
    BASE_BRANCH=$(jq -r '.config.base_branch // "main"' "$FLOW_STATE")
    STRATEGY=$(jq -r '.config.strategy // "tdd"' "$FLOW_STATE")
    MERGE_WORKTREE=$(jq -r '.integration.worktree // ""' "$FLOW_STATE")

    # Determine next action based on status
    case "$STATUS" in
        analyzing)
            NEXT_CMD="Skill: dev-issue-analyze $ISSUE --depth comprehensive"
            FLOW_STEP="step_1_analyze"
            ;;
        decomposing)
            NEXT_CMD="Skill: dev-decompose $ISSUE --base $BASE_BRANCH"
            FLOW_STEP="step_2_decompose"
            ;;
        implementing)
            if [[ "$FAILED_COUNT" -gt 0 ]]; then
                NEXT_CMD="Check failed subtasks in flow.json"
                FLOW_STEP="step_4_subtask_failed"
            elif [[ "$COMPLETED_COUNT" -lt "$SUBTASK_COUNT" ]]; then
                NEXT_CMD="Continue launching remaining subtask batches"
                FLOW_STEP="step_4_implementing"
            else
                NEXT_CMD="Skill: dev-integrate --flow-state $FLOW_STATE"
                FLOW_STEP="step_5_aggregate"
            fi
            ;;
        integrating)
            NEXT_CMD="Skill: dev-integrate --flow-state $FLOW_STATE"
            FLOW_STEP="step_6_integrate"
            ;;
        pr)
            if [[ -n "$PR_NUMBER" ]]; then
                NEXT_CMD="Skill: pr-iterate ${PR_URL:-$PR_NUMBER}"
                FLOW_STEP="step_8_iterate"
            else
                NEXT_CMD="Skill: git-pr $ISSUE --base $BASE_BRANCH --worktree $MERGE_WORKTREE"
                FLOW_STEP="step_7_pr"
            fi
            ;;
        iterating)
            NEXT_CMD="Skill: pr-iterate ${PR_URL:-$PR_NUMBER}"
            FLOW_STEP="step_8_iterate"
            ;;
        completed)
            NEXT_CMD=""
            FLOW_STEP="completed"
            ;;
        failed)
            NEXT_CMD="Check flow.json for failure details"
            FLOW_STEP="failed"
            ;;
        *)
            NEXT_CMD=""
            FLOW_STEP="unknown"
            ;;
    esac

    jq -n \
        --arg mode "parallel" \
        --arg status "$STATUS" \
        --arg flow_step "$FLOW_STEP" \
        --argjson issue "$ISSUE" \
        --argjson subtask_count "$SUBTASK_COUNT" \
        --argjson completed "$COMPLETED_COUNT" \
        --argjson failed "$FAILED_COUNT" \
        --arg flow_state "$FLOW_STATE" \
        --arg pr_number "${PR_NUMBER:-}" \
        --arg pr_url "${PR_URL:-}" \
        --arg next_cmd "$NEXT_CMD" \
        '{
            mode: $mode,
            status: $status,
            flow_step: $flow_step,
            issue: $issue,
            subtasks: {total: $subtask_count, completed: $completed, failed: $failed},
            flow_state: $flow_state,
            pr: (if $pr_number != "" then { number: ($pr_number | tonumber), url: $pr_url } else null end),
            next_action: $next_cmd
        }'
    exit 0
fi

# ============================================================================
# Single mode: kickoff.json
# ============================================================================

# Find state file
if [[ -n "$WORKTREE" ]]; then
    [[ -d "$WORKTREE" ]] || die_json "Worktree path does not exist: $WORKTREE" 1
    WORKTREE=$(cd "$WORKTREE" && pwd) || die_json "Cannot resolve worktree path" 1
    STATE_FILE="$WORKTREE/.claude/kickoff.json"
else
    # Try current git root
    GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    if [[ -n "$GIT_ROOT" && -f "$GIT_ROOT/.claude/kickoff.json" ]]; then
        STATE_FILE="$GIT_ROOT/.claude/kickoff.json"
        WORKTREE="$GIT_ROOT"
    else
        die_json "State file not found. Use --worktree or --flow-state." 1
    fi
fi

[[ -f "$STATE_FILE" ]] || die_json "State file not found: $STATE_FILE" 1

# Read state
CURRENT_PHASE=$(jq -r '.current_phase // "unknown"' "$STATE_FILE")
ISSUE=$(jq -r '.issue // "unknown"' "$STATE_FILE")
PR_NUMBER=$(jq -r '.pr.number // ""' "$STATE_FILE")
PR_URL=$(jq -r '.pr.url // ""' "$STATE_FILE")
NEXT_ACTION=$(jq -r '.next_action // ""' "$STATE_FILE")
BASE_BRANCH=$(jq -r '.base_branch // "main"' "$STATE_FILE")
STRATEGY=$(jq -r '.config.strategy // "tdd"' "$STATE_FILE")
DEPTH=$(jq -r '.config.depth // "standard"' "$STATE_FILE")
LANG=$(jq -r '.config.lang // "ja"' "$STATE_FILE")

# Determine dev-flow step based on kickoff state
determine_flow_step() {
    case "$CURRENT_PHASE" in
        1_prepare|2_analyze|3_implement|4_validate|5_commit)
            echo "step_1_kickoff"
            ;;
        6_pr)
            # Check if PR was created
            if [[ -n "$PR_NUMBER" ]]; then
                echo "step_3_iterate"
            else
                echo "step_1_kickoff"
            fi
            ;;
        completed)
            if [[ -n "$PR_NUMBER" ]]; then
                echo "step_3_iterate"
            else
                echo "completed"
            fi
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

FLOW_STEP=$(determine_flow_step)

# Determine next action command
case "$FLOW_STEP" in
    step_1_kickoff)
        NEXT_CMD="Skill: dev-kickoff $ISSUE --strategy $STRATEGY --depth $DEPTH --base $BASE_BRANCH"
        STATUS="kickoff_in_progress"
        ;;
    step_3_iterate)
        if [[ -n "$PR_URL" ]]; then
            NEXT_CMD="Skill: pr-iterate $PR_URL"
        else
            NEXT_CMD="Skill: pr-iterate $PR_NUMBER"
        fi
        STATUS="ready_for_iterate"
        ;;
    completed)
        NEXT_CMD=""
        STATUS="workflow_complete"
        ;;
    *)
        NEXT_CMD=""
        STATUS="unknown_state"
        ;;
esac

# Output JSON
jq -n \
    --arg mode "single" \
    --arg status "$STATUS" \
    --arg flow_step "$FLOW_STEP" \
    --arg current_phase "$CURRENT_PHASE" \
    --argjson issue "$ISSUE" \
    --arg worktree "$WORKTREE" \
    --arg pr_number "${PR_NUMBER:-null}" \
    --arg pr_url "${PR_URL:-null}" \
    --arg next_cmd "$NEXT_CMD" \
    '{
        mode: $mode,
        status: $status,
        flow_step: $flow_step,
        kickoff_phase: $current_phase,
        issue: $issue,
        worktree: $worktree,
        pr: (if $pr_number != "null" and $pr_number != "" then { number: ($pr_number | tonumber), url: $pr_url } else null end),
        next_action: $next_cmd
    }'
