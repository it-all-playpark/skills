#!/usr/bin/env bash
# analyze-termination-loops.sh - Analyze verdict_history / termination block across kickoff worktrees
#
# Check 9 (issue #53): Detect unhealthy Generator-Verifier loop outcomes recorded
# in `phases.3b_plan_review.termination` and `phases.6_evaluate.termination`.
#
# Findings:
#   - pattern="repeated_feedback_target"  : same feedback_target in 2 consecutive Phase 6 iterations
#                                             → likely a design vs. implementation mis-diagnosis
#   - pattern="max_iterations"             : termination.reason == "max_iterations"
#                                             → loop could not converge within iteration budget
#   - pattern="stuck"                      : termination.reason == "stuck"
#                                             → same finding persisted across Phase 3b iterations
#   - pattern="fork_failure"               : termination.reason == "fork_failure"
#                                             → verifier fork failed (possibly tooling issue)
#
# Usage:
#   analyze-termination-loops.sh [--worktree-base <dir>] [--max-age-days N]
#
#   --worktree-base  Directory containing worktree subdirectories with .claude/kickoff.json.
#                    Default: $REPO_ROOT/../$(basename $REPO_ROOT)-worktrees
#   --max-age-days   Skip kickoff.json whose updated_at is older than N days (default: 30)
#
# Output: JSON on stdout.
#
# See: dev-kickoff/references/kickoff-schema.md `termination` block.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

WORKTREE_BASE=""
MAX_AGE_DAYS=30

while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree-base) WORKTREE_BASE="$2"; shift 2 ;;
        --max-age-days) MAX_AGE_DAYS="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,25p' "$0"
            exit 0
            ;;
        *) die_json "Unknown argument: $1" 1 ;;
    esac
done

# Default worktree base: $REPO_ROOT/../$(basename $REPO_ROOT)-worktrees
if [[ -z "$WORKTREE_BASE" ]]; then
    GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    if [[ -n "$GIT_ROOT" ]]; then
        REPO_NAME=$(basename "$GIT_ROOT")
        WORKTREE_BASE="$GIT_ROOT/../${REPO_NAME}-worktrees"
    else
        die_json "Cannot auto-detect worktree-base; use --worktree-base" 1
    fi
fi

if [[ ! -d "$WORKTREE_BASE" ]]; then
    # Non-existent → return empty result (not an error; rotation of worktrees is expected)
    jq -n --arg base "$WORKTREE_BASE" '{
        worktree_base: $base,
        checked_worktrees: 0,
        findings: []
    }'
    exit 0
fi

# Collect kickoff.json paths
KICKOFF_FILES=()
while IFS= read -r -d '' f; do
    KICKOFF_FILES+=("$f")
done < <(find "$WORKTREE_BASE" -maxdepth 3 -type f -name 'kickoff.json' -path '*/.claude/kickoff.json' -print0 2>/dev/null)

CHECKED=0
FINDINGS_JSON='[]'

for kf in "${KICKOFF_FILES[@]}"; do
    # Skip unreadable / invalid JSON
    if ! jq empty "$kf" >/dev/null 2>&1; then
        continue
    fi

    CHECKED=$((CHECKED + 1))
    WT_DIR=$(dirname "$(dirname "$kf")")
    ISSUE=$(jq -r '.issue // null' "$kf")

    # -----------------------------------------------------------
    # Phase 6 (6_evaluate) — check verdict_history
    # -----------------------------------------------------------
    HAS_P6=$(jq 'has("phases") and (.phases | has("6_evaluate")) and (.phases["6_evaluate"] | has("termination"))' "$kf")
    if [[ "$HAS_P6" == "true" ]]; then
        P6_REASON=$(jq -r '.phases["6_evaluate"].termination.reason // "null"' "$kf")
        P6_FINAL_ITER=$(jq -r '.phases["6_evaluate"].termination.final_iteration // 0' "$kf")

        # Pattern: max_iterations
        if [[ "$P6_REASON" == "max_iterations" ]]; then
            FINDING=$(jq -n \
                --arg wt "$WT_DIR" \
                --argjson issue "$ISSUE" \
                --arg phase "6_evaluate" \
                --arg pattern "max_iterations" \
                --argjson iter "$P6_FINAL_ITER" \
                --arg msg "Phase 6 loop did not converge within max iterations ($P6_FINAL_ITER)" \
                '{worktree: $wt, issue: $issue, phase: $phase, pattern: $pattern, final_iteration: $iter, message: $msg}')
            FINDINGS_JSON=$(echo "$FINDINGS_JSON" | jq --argjson f "$FINDING" '. + [$f]')
        fi

        # Pattern: fork_failure
        if [[ "$P6_REASON" == "fork_failure" ]]; then
            FINDING=$(jq -n \
                --arg wt "$WT_DIR" \
                --argjson issue "$ISSUE" \
                --arg phase "6_evaluate" \
                --arg pattern "fork_failure" \
                --arg msg "dev-evaluate fork failed — verifier could not run" \
                '{worktree: $wt, issue: $issue, phase: $phase, pattern: $pattern, message: $msg}')
            FINDINGS_JSON=$(echo "$FINDINGS_JSON" | jq --argjson f "$FINDING" '. + [$f]')
        fi

        # Pattern: repeated_feedback_target (same target in 2+ consecutive iterations)
        REPEATED=$(jq -c '
            .phases["6_evaluate"].termination.verdict_history // [] as $h
            | [range(1; $h | length)
                | . as $i
                | if ($h[$i].feedback_target // null) != null
                     and ($h[$i].feedback_target == ($h[$i - 1].feedback_target // null))
                  then $h[$i].feedback_target
                  else empty end]
            | unique
        ' "$kf" 2>/dev/null || echo '[]')

        REPEATED_LEN=$(echo "$REPEATED" | jq 'length')
        if [[ "$REPEATED_LEN" -gt 0 ]]; then
            for target in $(echo "$REPEATED" | jq -r '.[]'); do
                # Count occurrences across the history
                OCCURRENCES=$(jq --arg t "$target" \
                    '[.phases["6_evaluate"].termination.verdict_history[]? | select(.feedback_target == $t)] | length' "$kf")
                FINDING=$(jq -n \
                    --arg wt "$WT_DIR" \
                    --argjson issue "$ISSUE" \
                    --arg phase "6_evaluate" \
                    --arg pattern "repeated_feedback_target" \
                    --arg target "$target" \
                    --argjson occ "$OCCURRENCES" \
                    --arg msg "同一 feedback_target ($target) が 2 iteration 連続で発生 → 設計問題の可能性" \
                    '{worktree: $wt, issue: $issue, phase: $phase, pattern: $pattern, feedback_target: $target, occurrences: $occ, message: $msg}')
                FINDINGS_JSON=$(echo "$FINDINGS_JSON" | jq --argjson f "$FINDING" '. + [$f]')
            done
        fi
    fi

    # -----------------------------------------------------------
    # Phase 3b (3b_plan_review) — check termination.reason
    # -----------------------------------------------------------
    HAS_P3B=$(jq 'has("phases") and (.phases | has("3b_plan_review")) and (.phases["3b_plan_review"] | has("termination"))' "$kf")
    if [[ "$HAS_P3B" == "true" ]]; then
        P3B_REASON=$(jq -r '.phases["3b_plan_review"].termination.reason // "null"' "$kf")
        P3B_FINAL_ITER=$(jq -r '.phases["3b_plan_review"].termination.final_iteration // 0' "$kf")

        if [[ "$P3B_REASON" == "stuck" ]]; then
            FINDING=$(jq -n \
                --arg wt "$WT_DIR" \
                --argjson issue "$ISSUE" \
                --arg phase "3b_plan_review" \
                --arg pattern "stuck" \
                --argjson iter "$P3B_FINAL_ITER" \
                --arg msg "Plan-review loop が stuck (同一 finding が連続)" \
                '{worktree: $wt, issue: $issue, phase: $phase, pattern: $pattern, final_iteration: $iter, message: $msg}')
            FINDINGS_JSON=$(echo "$FINDINGS_JSON" | jq --argjson f "$FINDING" '. + [$f]')
        fi

        if [[ "$P3B_REASON" == "max_iterations" ]]; then
            FINDING=$(jq -n \
                --arg wt "$WT_DIR" \
                --argjson issue "$ISSUE" \
                --arg phase "3b_plan_review" \
                --arg pattern "max_iterations" \
                --argjson iter "$P3B_FINAL_ITER" \
                --arg msg "Plan-review loop が max_iterations で escalate" \
                '{worktree: $wt, issue: $issue, phase: $phase, pattern: $pattern, final_iteration: $iter, message: $msg}')
            FINDINGS_JSON=$(echo "$FINDINGS_JSON" | jq --argjson f "$FINDING" '. + [$f]')
        fi

        if [[ "$P3B_REASON" == "fork_failure" ]]; then
            FINDING=$(jq -n \
                --arg wt "$WT_DIR" \
                --argjson issue "$ISSUE" \
                --arg phase "3b_plan_review" \
                --arg pattern "fork_failure" \
                --arg msg "dev-plan-review fork failed — verifier could not run" \
                '{worktree: $wt, issue: $issue, phase: $phase, pattern: $pattern, message: $msg}')
            FINDINGS_JSON=$(echo "$FINDINGS_JSON" | jq --argjson f "$FINDING" '. + [$f]')
        fi
    fi
done

jq -n \
    --arg base "$WORKTREE_BASE" \
    --argjson checked "$CHECKED" \
    --argjson findings "$FINDINGS_JSON" \
    '{
        worktree_base: $base,
        checked_worktrees: $checked,
        findings: $findings
    }'
