#!/usr/bin/env bash
# auto-merge-child.sh - Auto-merge a child PR into the integration branch
#
# Used as `--on-success` callback by run-batch-loop.sh in dev-flow child-split
# mode. Resolves the child issue's open PR, runs auto-merge-guard.sh, and if
# allowed runs `gh pr merge --admin`. Also updates flow.json child status.
#
# Usage:
#   auto-merge-child.sh <child-issue> --base <integration-branch> [--flow-state PATH]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SKILLS_REPO/_lib/common.sh"

require_cmds jq gh

CHILD=""
BASE=""
FLOW_STATE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --base) BASE="$2"; shift 2 ;;
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,10p' "$0"
            exit 0
            ;;
        *)
            if [[ -z "$CHILD" ]]; then CHILD="$1"
            else die_json "Unexpected arg: $1" 1
            fi
            shift
            ;;
    esac
done

[[ -n "$CHILD" ]] || die_json "child-issue argument required" 1
[[ "$CHILD" =~ ^[0-9]+$ ]] || die_json "child-issue must be a positive integer" 1
[[ -n "$BASE" ]] || die_json "--base is required" 1

# Resolve the child's open PR targeting BASE
PR_NUMBER=$(gh pr list --search "is:open author:@me $CHILD in:title" --json number,baseRefName \
    --jq ".[] | select(.baseRefName == \"$BASE\") | .number" 2>/dev/null | head -1)

if [[ -z "$PR_NUMBER" ]]; then
    # Fallback: search by issue link in body
    PR_NUMBER=$(gh pr list --search "is:open in:body Closes #$CHILD" --json number,baseRefName \
        --jq ".[] | select(.baseRefName == \"$BASE\") | .number" 2>/dev/null | head -1)
fi

if [[ -z "$PR_NUMBER" ]]; then
    die_json "No open PR found for child #$CHILD targeting $BASE" 1
fi

# Guard check
GUARD_OUTPUT=$("$SKILLS_REPO/_lib/scripts/auto-merge-guard.sh" --pr "$PR_NUMBER")
GUARD_STATUS=$(echo "$GUARD_OUTPUT" | jq -r '.status')

if [[ "$GUARD_STATUS" != "allowed" ]]; then
    REASON=$(echo "$GUARD_OUTPUT" | jq -r '.reason')
    die_json "auto-merge-guard refused PR #$PR_NUMBER (base=$BASE): $REASON" 1
fi

# Merge
MERGE_OUTPUT=$(gh pr merge "$PR_NUMBER" --merge --admin --delete-branch 2>&1) || {
    die_json "gh pr merge failed for PR #$PR_NUMBER: $MERGE_OUTPUT" 1
}

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Update flow.json (best-effort if --flow-state provided)
if [[ -n "$FLOW_STATE" && -f "$FLOW_STATE" ]]; then
    "$SKILLS_REPO/_lib/scripts/flow-update.sh" \
        --flow-state "$FLOW_STATE" child "$CHILD" \
        --status completed --merged-at "$NOW" >/dev/null 2>&1 || true
    # Capture PR URL for the record
    PR_URL=$(gh pr view "$PR_NUMBER" --json url -q '.url' 2>/dev/null || echo "")
    if [[ -n "$PR_URL" ]]; then
        "$SKILLS_REPO/_lib/scripts/flow-update.sh" \
            --flow-state "$FLOW_STATE" child "$CHILD" \
            --pr "$PR_NUMBER" --pr-url "$PR_URL" >/dev/null 2>&1 || true
    fi
fi

jq -n \
    --argjson child "$CHILD" \
    --argjson pr "$PR_NUMBER" \
    --arg base "$BASE" \
    --arg merged_at "$NOW" \
    '{status: "merged", child: $child, pr: $pr, base: $base, merged_at: $merged_at}'
