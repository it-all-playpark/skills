#!/usr/bin/env bash
# merge-prs.sh - Batch merge PRs that passed testing
# Usage: merge-prs.sh <pr-numbers-comma-separated> [--dry-run]
# Output: JSON with merge results

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Args
# ============================================================================

PR_LIST=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        -*) die_json "Unknown option: $1" 1 ;;
        *)
            if [[ -z "$PR_LIST" ]]; then
                PR_LIST="$1"
            else
                die_json "Unexpected argument: $1" 1
            fi
            shift ;;
    esac
done

[[ -n "$PR_LIST" ]] || die_json "Usage: merge-prs.sh <pr-numbers-comma-separated> [--dry-run]" 1

# ============================================================================
# Main
# ============================================================================

require_gh_auth

MERGED="[]"
SKIPPED="[]"
MERGE_ERRORS="[]"

IFS=',' read -ra PR_NUMBERS <<< "$PR_LIST"

for PR in "${PR_NUMBERS[@]}"; do
    # Trim whitespace
    PR=$(echo "$PR" | tr -d '[:space:]')
    [[ -n "$PR" ]] || continue
    [[ "$PR" =~ ^[0-9]+$ ]] || {
        MERGE_ERRORS=$(echo "$MERGE_ERRORS" | jq --arg pr "$PR" --arg msg "Invalid PR number" \
            '. + [{"pr": $pr, "error": $msg}]')
        continue
    }

    # Check for "do not merge" label
    has_dnm=$(gh pr view "$PR" --json labels --jq '.labels[].name' 2>/dev/null | grep -ic "do not merge" || true)
    if [[ "$has_dnm" -gt 0 ]]; then
        SKIPPED=$(echo "$SKIPPED" | jq --argjson pr "$PR" --arg reason "has 'do not merge' label" \
            '. + [{"pr": $pr, "reason": $reason}]')
        continue
    fi

    # Check CI status
    ci_states=$(gh pr checks "$PR" --json state --jq '.[].state' 2>/dev/null || echo "UNKNOWN")
    has_failure=$(echo "$ci_states" | grep -icE "FAILURE|ERROR" || true)

    if [[ "$has_failure" -gt 0 ]]; then
        SKIPPED=$(echo "$SKIPPED" | jq --argjson pr "$PR" --arg reason "CI checks not passing" \
            '. + [{"pr": $pr, "reason": $reason}]')
        continue
    fi

    # Merge (or dry-run)
    if [[ "$DRY_RUN" == true ]]; then
        MERGED=$(echo "$MERGED" | jq --argjson pr "$PR" '. + [{"pr": $pr, "status": "dry_run"}]')
        continue
    fi

    if gh pr merge "$PR" --squash --auto 2>/dev/null; then
        MERGED=$(echo "$MERGED" | jq --argjson pr "$PR" '. + [{"pr": $pr, "status": "merged"}]')
    else
        MERGE_ERRORS=$(echo "$MERGE_ERRORS" | jq --argjson pr "$PR" --arg msg "gh pr merge failed" \
            '. + [{"pr": $pr, "error": $msg}]')
    fi
done

echo "{\"merged\":$MERGED,\"skipped\":$SKIPPED,\"errors\":$MERGE_ERRORS,\"dry_run\":$DRY_RUN}"
