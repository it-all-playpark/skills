#!/usr/bin/env bash
# record-iteration.sh - Record iteration results
# Usage: record-iteration.sh <action> [options] [--worktree PATH]
#   Actions:
#     review --decision <approved|request-changes|comment> [--issues "issue1,issue2"] [--summary "..."]
#     ci --status <passed|failed|pending>
#     fix --applied "fix1,fix2"
#     next - Start next iteration
#     complete --status <lgtm|failed|max_reached>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

ACTION=""
DECISION=""
CI_STATUS=""
ISSUES=""
SUMMARY=""
FIXES=""
COMPLETE_STATUS=""
WORKTREE=""
NO_SUMMARY=false

# Valid enum values for validation
VALID_ACTIONS="review ci fix next complete"
VALID_DECISIONS="approved request-changes comment pending"
VALID_CI_STATUSES="passed failed pending"
VALID_COMPLETE_STATUSES="lgtm failed max_reached"

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --decision) DECISION="$2"; shift 2 ;;
        --status)
            if [[ -z "$ACTION" || "$ACTION" == "ci" ]]; then
                CI_STATUS="$2"
            else
                COMPLETE_STATUS="$2"
            fi
            shift 2
            ;;
        --issues) ISSUES="$2"; shift 2 ;;
        --summary) SUMMARY="$2"; shift 2 ;;
        --applied) FIXES="$2"; shift 2 ;;
        --worktree) WORKTREE="$2"; shift 2 ;;
        --no-summary) NO_SUMMARY=true; shift ;;
        review|ci|fix|next|complete)
            ACTION="$1"; shift
            ;;
        -*)
            die_json "Unknown option: $1" 1
            ;;
        *)
            if [[ -z "$ACTION" ]]; then
                ACTION="$1"
            fi
            shift
            ;;
    esac
done

[[ -n "$ACTION" ]] || die_json "Action required (review|ci|fix|next|complete)" 1

# Validate ACTION enum
if ! echo "$VALID_ACTIONS" | grep -qw "$ACTION"; then
    die_json "Invalid action: $ACTION. Must be one of: $VALID_ACTIONS" 1
fi

# Find state file (Priority: --worktree > kickoff.json auto-detect > current dir)
if [[ -n "$WORKTREE" ]]; then
    # Explicit --worktree provided
    [[ -d "$WORKTREE" ]] || die_json "Worktree path does not exist: $WORKTREE" 1
    WORKTREE=$(cd "$WORKTREE" && pwd) || die_json "Cannot resolve worktree path" 1
    STATE_FILE="$WORKTREE/.claude/iterate.json"
else
    GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")

    # First try iterate.json in current git root
    if [[ -n "$GIT_ROOT" && -f "$GIT_ROOT/.claude/iterate.json" ]]; then
        STATE_FILE="$GIT_ROOT/.claude/iterate.json"
    # Then try to find worktree from kickoff.json
    elif [[ -n "$GIT_ROOT" && -f "$GIT_ROOT/.claude/kickoff.json" ]]; then
        DETECTED_WORKTREE=$(jq -r '.worktree // empty' "$GIT_ROOT/.claude/kickoff.json" 2>/dev/null || echo "")
        if [[ -n "$DETECTED_WORKTREE" && -f "$DETECTED_WORKTREE/.claude/iterate.json" ]]; then
            STATE_FILE="$DETECTED_WORKTREE/.claude/iterate.json"
        else
            die_json "State file not found. Use --worktree or initialize with init-iterate.sh" 1
        fi
    else
        die_json "State file not found. Use --worktree or initialize with init-iterate.sh" 1
    fi
fi

[[ -f "$STATE_FILE" ]] || die_json "State file not found: $STATE_FILE" 1

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
CURRENT=$(jq -r '.current_iteration' "$STATE_FILE")

# Base jq args
JQ_ARGS=(--arg now "$NOW" --argjson current "$CURRENT")
JQ_FILTER=""

case "$ACTION" in
    review)
        [[ -n "$DECISION" ]] || die_json "Decision required for review action" 1
        
        # Validate DECISION enum
        if ! echo "$VALID_DECISIONS" | grep -qw "$DECISION"; then
            die_json "Invalid decision: $DECISION. Must be one of: $VALID_DECISIONS" 1
        fi

        JQ_ARGS+=(--arg decision "$DECISION")
        JQ_FILTER='.updated_at = $now | .iterations[$current - 1].review.decision = $decision'

        if [[ -n "$ISSUES" ]]; then
            JQ_ARGS+=(--arg issues "$ISSUES")
            JQ_FILTER="$JQ_FILTER | .iterations[\$current - 1].review.issues = (\$issues | split(\",\") | map(. | gsub(\"^\\\\s+|\\\\s+\$\"; \"\")))"
        fi

        if [[ -n "$SUMMARY" ]]; then
            JQ_ARGS+=(--arg summary "$SUMMARY")
            JQ_FILTER="$JQ_FILTER | .iterations[\$current - 1].review.summary = \$summary"
        fi

        # Update next_actions based on decision
        if [[ "$DECISION" == "approved" ]]; then
            JQ_FILTER="$JQ_FILTER | .next_actions = [\"LGTM! Consider completing.\"] | .status = \"lgtm\""
        else
            JQ_FILTER="$JQ_FILTER | .next_actions = [\"Run pr-fix to address issues\"]"
        fi
        ;;

    ci)
        [[ -n "$CI_STATUS" ]] || die_json "Status required for ci action" 1
        
        # Validate CI_STATUS enum
        if ! echo "$VALID_CI_STATUSES" | grep -qw "$CI_STATUS"; then
            die_json "Invalid CI status: $CI_STATUS. Must be one of: $VALID_CI_STATUSES" 1
        fi

        JQ_ARGS+=(--arg ci_status "$CI_STATUS")
        JQ_FILTER='.updated_at = $now | .iterations[$current - 1].ci_status = $ci_status'

        if [[ "$CI_STATUS" == "failed" ]]; then
            JQ_FILTER="$JQ_FILTER | .next_actions = [\"Fix CI failures\"]"
        fi
        ;;

    fix)
        [[ -n "$FIXES" ]] || die_json "Applied fixes required for fix action" 1
        JQ_ARGS+=(--arg fixes "$FIXES")
        JQ_FILTER='.updated_at = $now |
            .iterations[$current - 1].fixes_applied = (.iterations[$current - 1].fixes_applied // []) + ($fixes | split(",") | map(. | gsub("^\\s+|\\s+$"; ""))) |
            .next_actions = ["Run pr-review to check fixes"]'
        ;;

    next)
        NEXT=$((CURRENT + 1))
        MAX=$(jq -r '.max_iterations' "$STATE_FILE")

        JQ_ARGS+=(--argjson next "$NEXT" --argjson max "$MAX")

        if [[ $NEXT -gt $MAX ]]; then
            JQ_FILTER='.updated_at = $now |
                .status = "max_reached" |
                .next_actions = ["Maximum iterations reached. Manual intervention required."]'
        else
            JQ_FILTER='.updated_at = $now |
                .current_iteration = $next |
                .iterations[$current - 1].completed_at = $now |
                .iterations += [{"number": $next, "started_at": $now, "review": {"decision": "pending"}, "ci_status": "pending"}] |
                .next_actions = ["Run pr-review"]'
        fi
        ;;

    complete)
        [[ -n "$COMPLETE_STATUS" ]] || die_json "Status required for complete action" 1
        
        # Validate COMPLETE_STATUS enum
        if ! echo "$VALID_COMPLETE_STATUSES" | grep -qw "$COMPLETE_STATUS"; then
            die_json "Invalid complete status: $COMPLETE_STATUS. Must be one of: $VALID_COMPLETE_STATUSES" 1
        fi

        JQ_ARGS+=(--arg complete_status "$COMPLETE_STATUS")
        JQ_FILTER='.updated_at = $now |
            .status = $complete_status |
            .iterations[$current - 1].completed_at = $now |
            .next_actions = []'
        ;;

    *)
        die_json "Unknown action: $ACTION" 1
        ;;
esac

# Apply update
TMP_FILE=$(mktemp)
if jq "${JQ_ARGS[@]}" "$JQ_FILTER" "$STATE_FILE" > "$TMP_FILE"; then
    mv "$TMP_FILE" "$STATE_FILE"
    echo "{\"status\":\"recorded\",\"action\":\"$ACTION\",\"iteration\":$CURRENT}"

    # Post summary on LGTM completion (unless --no-summary specified)
    if [[ "$ACTION" == "complete" && "$COMPLETE_STATUS" == "lgtm" && "$NO_SUMMARY" == false ]]; then
        WORKTREE_ARG=""
        if [[ -n "$WORKTREE" ]]; then
            WORKTREE_ARG="--worktree $WORKTREE"
        fi
        # shellcheck disable=SC2086
        "$SCRIPT_DIR/post-summary.sh" $WORKTREE_ARG 2>/dev/null || true
    fi
else
    rm -f "$TMP_FILE"
    die_json "Failed to update state" 1
fi