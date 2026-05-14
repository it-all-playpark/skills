#!/usr/bin/env bash
# next-action.sh - Determine next action based on current phase
# Usage: next-action.sh [--worktree PATH]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

WORKTREE=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree) WORKTREE="$2"; shift 2 ;;
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

# Find state file
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
        die_json "State file not found. Use --worktree or run from worktree directory." 1
    fi
fi

[[ -f "$STATE_FILE" ]] || die_json "State file not found: $STATE_FILE" 1

# Read state
CURRENT_PHASE=$(jq -r '.current_phase // "unknown"' "$STATE_FILE")
ISSUE=$(jq -r '.issue // "unknown"' "$STATE_FILE")
BASE_BRANCH=$(jq -r '.base_branch // "main"' "$STATE_FILE")
TESTING=$(jq -r '.config.testing // "tdd"' "$STATE_FILE")
DESIGN=$(jq -r '.config.design // null | select(. != null)' "$STATE_FILE")
DEPTH=$(jq -r '.config.depth // "standard"' "$STATE_FILE")
LANG=$(jq -r '.config.lang // "ja"' "$STATE_FILE")
PR_NUMBER=$(jq -r '.pr.number // ""' "$STATE_FILE")
PR_URL=$(jq -r '.pr.url // ""' "$STATE_FILE")

# Get phase status
get_phase_status() {
    local phase="$1"
    jq -r ".phases[\"$phase\"].status // \"pending\"" "$STATE_FILE"
}

# Determine next action
determine_next_action() {
    case "$CURRENT_PHASE" in
        1_prepare)
            local status=$(get_phase_status "1_prepare")
            if [[ "$status" == "done" ]]; then
                echo "2_analyze"
                echo "Skill: dev-issue-analyze $ISSUE --depth $DEPTH"
            else
                echo "1_prepare"
                echo "Agent(subagent_type: dev-kickoff-worker, issue_number: $ISSUE, branch_name: feature/issue-${ISSUE}-m, base_ref: $BASE_BRANCH, mode: single)"
            fi
            ;;
        2_analyze)
            local status=$(get_phase_status "2_analyze")
            if [[ "$status" == "done" ]]; then
                echo "3_plan_impl"
                echo "Skill: dev-plan-impl $ISSUE --worktree $WORKTREE"
            else
                echo "2_analyze"
                echo "Skill: dev-issue-analyze $ISSUE --depth $DEPTH"
            fi
            ;;
        3_plan_impl)
            local status=$(get_phase_status "3_plan_impl")
            if [[ "$status" == "done" ]]; then
                echo "4_implement"
                echo "Skill: dev-implement --testing $TESTING${DESIGN:+ --design $DESIGN} --worktree $WORKTREE"
            else
                echo "3_plan_impl"
                echo "Skill: dev-plan-impl $ISSUE --worktree $WORKTREE"
            fi
            ;;
        4_implement)
            local status=$(get_phase_status "4_implement")
            if [[ "$status" == "done" ]]; then
                echo "5_validate"
                echo "Skill: dev-validate --fix --worktree $WORKTREE"
            else
                echo "4_implement"
                echo "Skill: dev-implement --testing $TESTING${DESIGN:+ --design $DESIGN} --worktree $WORKTREE"
            fi
            ;;
        5_validate)
            local status=$(get_phase_status "5_validate")
            if [[ "$status" == "done" ]]; then
                echo "6_evaluate"
                echo "Skill: dev-evaluate $ISSUE --worktree $WORKTREE"
            else
                echo "5_validate"
                echo "Skill: dev-validate --fix --worktree $WORKTREE"
            fi
            ;;
        6_evaluate)
            local status=$(get_phase_status "6_evaluate")
            if [[ "$status" == "done" ]]; then
                echo "7_commit"
                echo "Skill: git-commit --all --worktree $WORKTREE"
            else
                echo "6_evaluate"
                echo "Skill: dev-evaluate $ISSUE --worktree $WORKTREE"
            fi
            ;;
        7_commit)
            local status=$(get_phase_status "7_commit")
            if [[ "$status" == "done" ]]; then
                echo "8_pr"
                echo "Skill: git-pr $ISSUE --base $BASE_BRANCH --lang $LANG --worktree $WORKTREE"
            else
                echo "7_commit"
                echo "Skill: git-commit --all --worktree $WORKTREE"
            fi
            ;;
        8_pr)
            local status=$(get_phase_status "8_pr")
            if [[ "$status" == "done" ]]; then
                echo "pr-iterate"
                if [[ -n "$PR_URL" ]]; then
                    echo "Skill: pr-iterate $PR_URL"
                else
                    echo "Skill: pr-iterate $PR_NUMBER"
                fi
            else
                echo "8_pr"
                echo "Skill: git-pr $ISSUE --base $BASE_BRANCH --lang $LANG --worktree $WORKTREE"
            fi
            ;;
        completed)
            if [[ -n "$PR_URL" ]]; then
                echo "pr-iterate"
                echo "Skill: pr-iterate $PR_URL"
            else
                echo "completed"
                echo "Workflow complete"
            fi
            ;;
        *)
            echo "unknown"
            echo "Unknown state - check kickoff.json"
            ;;
    esac
}

# Get next action
read -r NEXT_PHASE NEXT_CMD <<< "$(determine_next_action | paste - -)"

# Output JSON
jq -n \
    --arg current_phase "$CURRENT_PHASE" \
    --arg next_phase "$NEXT_PHASE" \
    --arg next_cmd "$NEXT_CMD" \
    --argjson issue "$ISSUE" \
    --arg worktree "$WORKTREE" \
    --arg pr_number "${PR_NUMBER:-null}" \
    --arg pr_url "${PR_URL:-null}" \
    '{
        current_phase: $current_phase,
        next_phase: $next_phase,
        next_action: $next_cmd,
        issue: $issue,
        worktree: $worktree,
        pr: (if $pr_number != "null" and $pr_number != "" then { number: ($pr_number | tonumber), url: $pr_url } else null end)
    }'
