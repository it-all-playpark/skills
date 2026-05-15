#!/usr/bin/env bash
# flow-status.sh - Check dev-flow state and determine next action
# Supports single mode (kickoff.json) and child-split mode (flow.json v2).
# v1 flow.json is rejected (no-backcompat).
#
# Usage: flow-status.sh [--worktree PATH] [--flow-state PATH]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

WORKTREE=""
FLOW_STATE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree) WORKTREE="$2"; shift 2 ;;
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        -*) die_json "Unknown option: $1" 1 ;;
        *)
            if [[ -z "$WORKTREE" ]]; then WORKTREE="$1"
            fi
            shift
            ;;
    esac
done

# ============================================================================
# Child-Split Mode: flow.json takes precedence
# ============================================================================

if [[ -n "$FLOW_STATE" && -f "$FLOW_STATE" ]]; then
    VERSION=$(jq -r '.version // empty' "$FLOW_STATE")
    if [[ "$VERSION" != "2.0.0" ]]; then
        die_json "flow.json schema version must be 2.0.0 (got: \"$VERSION\"). v1 is not supported (no-backcompat)." 1
    fi

    STATUS=$(jq -r '.status // "unknown"' "$FLOW_STATE")
    ISSUE=$(jq -r '.issue // "unknown"' "$FLOW_STATE")
    INTEGRATION_BRANCH=$(jq -r '.integration_branch.name // ""' "$FLOW_STATE")
    BASE_BRANCH=$(jq -r '.config.base_branch // "dev"' "$FLOW_STATE")

    CHILD_COUNT=$(jq '.children | length' "$FLOW_STATE")
    COMPLETED=$(jq '[.children[] | select(.status == "completed")] | length' "$FLOW_STATE")
    FAILED=$(jq '[.children[] | select(.status == "failed")] | length' "$FLOW_STATE")
    RUNNING=$(jq '[.children[] | select(.status == "running")] | length' "$FLOW_STATE")
    PR_NUMBER=$(jq -r '.final_pr.number // ""' "$FLOW_STATE")
    PR_URL=$(jq -r '.final_pr.url // ""' "$FLOW_STATE")

    case "$STATUS" in
        decomposing)
            NEXT_CMD="Skill: dev-decompose $ISSUE --child-split --base $BASE_BRANCH"
            FLOW_STEP="step_2_decompose"
            ;;
        running)
            if [[ "$COMPLETED" -lt "$CHILD_COUNT" ]]; then
                NEXT_CMD="Continue run-batch-loop.sh (resume from last incomplete batch)"
                FLOW_STEP="step_3_batch_loop"
            else
                NEXT_CMD="Skill: dev-integrate --flow-state $FLOW_STATE"
                FLOW_STEP="step_4_integrate"
            fi
            ;;
        integrated)
            if [[ -n "$PR_NUMBER" ]]; then
                NEXT_CMD="Task: pr-iterate ${PR_URL:-$PR_NUMBER}"
                FLOW_STEP="step_6_iterate"
            else
                NEXT_CMD="Skill: git-pr $ISSUE --base $BASE_BRANCH"
                FLOW_STEP="step_5_final_pr"
            fi
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
        --arg mode "child-split" \
        --arg status "$STATUS" \
        --arg flow_step "$FLOW_STEP" \
        --arg issue "$ISSUE" \
        --arg integration_branch "$INTEGRATION_BRANCH" \
        --argjson child_count "$CHILD_COUNT" \
        --argjson completed "$COMPLETED" \
        --argjson failed "$FAILED" \
        --argjson running "$RUNNING" \
        --arg flow_state "$FLOW_STATE" \
        --arg pr_number "${PR_NUMBER:-}" \
        --arg pr_url "${PR_URL:-}" \
        --arg next_cmd "$NEXT_CMD" \
        '{
            mode: $mode,
            status: $status,
            flow_step: $flow_step,
            issue: ($issue | tonumber? // $issue),
            integration_branch: $integration_branch,
            children: {total: $child_count, completed: $completed, running: $running, failed: $failed},
            flow_state: $flow_state,
            final_pr: (if $pr_number != "" then { number: ($pr_number | tonumber), url: $pr_url } else null end),
            next_action: $next_cmd
        }'
    exit 0
fi

# ============================================================================
# Single Mode: kickoff.json
# ============================================================================

if [[ -n "$WORKTREE" ]]; then
    [[ -d "$WORKTREE" ]] || die_json "Worktree path does not exist: $WORKTREE" 1
    WORKTREE=$(cd "$WORKTREE" && pwd) || die_json "Cannot resolve worktree path" 1
    STATE_FILE="$WORKTREE/.claude/kickoff.json"
else
    GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    if [[ -n "$GIT_ROOT" && -f "$GIT_ROOT/.claude/kickoff.json" ]]; then
        STATE_FILE="$GIT_ROOT/.claude/kickoff.json"
        WORKTREE="$GIT_ROOT"
    else
        die_json "State file not found. Use --worktree or --flow-state." 1
    fi
fi

[[ -f "$STATE_FILE" ]] || die_json "State file not found: $STATE_FILE" 1

CURRENT_PHASE=$(jq -r '.current_phase // "unknown"' "$STATE_FILE")
ISSUE=$(jq -r '.issue // "unknown"' "$STATE_FILE")
PR_NUMBER=$(jq -r '.pr.number // ""' "$STATE_FILE")
PR_URL=$(jq -r '.pr.url // ""' "$STATE_FILE")
BASE_BRANCH=$(jq -r '.base_branch // "main"' "$STATE_FILE")
STRATEGY=$(jq -r '.config.testing // .config.strategy // "tdd"' "$STATE_FILE")
DEPTH=$(jq -r '.config.depth // "standard"' "$STATE_FILE")

determine_flow_step() {
    case "$CURRENT_PHASE" in
        1_prepare|2_analyze|3_plan_impl|3b_plan_review|4_implement|5_validate|6_evaluate|7_commit)
            echo "step_2_kickoff"
            ;;
        8_pr|completed)
            if [[ -n "$PR_NUMBER" ]]; then echo "step_4_iterate"
            else echo "step_2_kickoff"
            fi
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

FLOW_STEP=$(determine_flow_step)

case "$FLOW_STEP" in
    step_2_kickoff)
        NEXT_CMD="Task subagent: Skill: dev-kickoff $ISSUE --testing $STRATEGY --depth $DEPTH --base $BASE_BRANCH"
        STATUS="kickoff_in_progress"
        ;;
    step_4_iterate)
        if [[ -n "$PR_URL" ]]; then
            NEXT_CMD="Task subagent: Skill: pr-iterate $PR_URL"
        else
            NEXT_CMD="Task subagent: Skill: pr-iterate $PR_NUMBER"
        fi
        STATUS="ready_for_iterate"
        ;;
    *)
        NEXT_CMD=""
        STATUS="unknown_state"
        ;;
esac

jq -n \
    --arg mode "single" \
    --arg status "$STATUS" \
    --arg flow_step "$FLOW_STEP" \
    --arg current_phase "$CURRENT_PHASE" \
    --arg issue "$ISSUE" \
    --arg worktree "$WORKTREE" \
    --arg pr_number "${PR_NUMBER:-null}" \
    --arg pr_url "${PR_URL:-null}" \
    --arg next_cmd "$NEXT_CMD" \
    '{
        mode: $mode,
        status: $status,
        flow_step: $flow_step,
        kickoff_phase: $current_phase,
        issue: ($issue | tonumber? // $issue),
        worktree: $worktree,
        pr: (if $pr_number != "null" and $pr_number != "" then { number: ($pr_number | tonumber), url: $pr_url } else null end),
        next_action: $next_cmd
    }'
