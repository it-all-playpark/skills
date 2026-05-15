#!/usr/bin/env bash
# auto-merge-child.sh - Auto-merge a child PR into the integration branch
#
# Used as `--on-success` callback by run-batch-loop.sh in dev-flow child-split
# mode. Resolves the child issue's linked PR via GitHub's authoritative Issue→PR
# link (closingIssuesReferences / closedByPullRequestsReferences), runs
# auto-merge-guard.sh, and if allowed runs `gh pr merge --admin`. Also updates
# flow.json child status.
#
# PR resolution priority (deterministic, no fuzzy search):
#   1. flow.json `children[].pr_number` (if --flow-state provided and recorded)
#   2. `gh issue view <CHILD> --json closedByPullRequestsReferences`
#      (GitHub's authoritative linked-PR list; populated when the PR body
#      contains "Closes #N" or the PR is created via gh CLI with `--issue`)
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
            sed -n '2,18p' "$0"
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
[[ "$CHILD" =~ ^[1-9][0-9]*$ ]] || die_json "child-issue must be a positive integer (>=1)" 1
[[ -n "$BASE" ]] || die_json "--base is required" 1

# ============================================================================
# Resolve PR_NUMBER deterministically
# ============================================================================
#
# Step 1: Trust flow.json if it has pr_number recorded for this child.
# Step 2: Otherwise use GitHub's Issue→PR authoritative link.
# Step 3: Verify the resolved PR is OPEN and base matches BASE before merging.

PR_NUMBER=""
PR_SOURCE=""

# Step 1: flow.json (most authoritative — set by dev-flow when child PR is created)
if [[ -n "$FLOW_STATE" && -f "$FLOW_STATE" ]]; then
    PR_NUMBER=$(jq -r --argjson i "$CHILD" \
        '.children[] | select(.issue == $i) | .pr_number // empty' \
        "$FLOW_STATE" 2>/dev/null || echo "")
    if [[ -n "$PR_NUMBER" && "$PR_NUMBER" != "null" ]]; then
        PR_SOURCE="flow.json"
    else
        PR_NUMBER=""
    fi
fi

# Step 2: GitHub Issue→PR authoritative link (closedByPullRequestsReferences)
if [[ -z "$PR_NUMBER" ]]; then
    # closedByPullRequestsReferences lists PRs that GitHub's metadata links to
    # this issue as closer (populated when PR body has "Closes #N" or
    # development sidebar links the PR). This is the source of truth — no
    # search/fuzzy match.
    LINKED_JSON=$(gh issue view "$CHILD" \
        --json closedByPullRequestsReferences 2>/dev/null || echo "")
    if [[ -n "$LINKED_JSON" ]]; then
        # Filter to open PRs only and pick the one targeting BASE.
        PR_NUMBER=$(echo "$LINKED_JSON" | jq -r --arg base "$BASE" \
            '.closedByPullRequestsReferences[]?
             | select(.state == "OPEN")
             | select(.baseRefName == $base)
             | .number' 2>/dev/null | head -1)
        [[ -n "$PR_NUMBER" ]] && PR_SOURCE="gh-issue-link"
    fi
fi

if [[ -z "$PR_NUMBER" ]]; then
    die_json "No linked open PR found for child #$CHILD targeting $BASE (checked flow.json and gh issue closedByPullRequestsReferences)" 1
fi

# Step 3: Verify the resolved PR — defense-in-depth before --admin merge.
PR_META=$(gh pr view "$PR_NUMBER" --json state,baseRefName,closingIssuesReferences 2>/dev/null || echo "")
if [[ -z "$PR_META" ]]; then
    die_json "Could not fetch PR #$PR_NUMBER metadata" 1
fi
PR_STATE=$(echo "$PR_META" | jq -r '.state')
PR_BASE=$(echo "$PR_META" | jq -r '.baseRefName')
PR_CLOSES_CHILD=$(echo "$PR_META" | jq -r --argjson i "$CHILD" \
    '[.closingIssuesReferences[]?.number] | any(. == $i)')

if [[ "$PR_STATE" != "OPEN" ]]; then
    die_json "PR #$PR_NUMBER is not OPEN (state: $PR_STATE)" 1
fi
if [[ "$PR_BASE" != "$BASE" ]]; then
    die_json "PR #$PR_NUMBER base mismatch: got '$PR_BASE', expected '$BASE'" 1
fi
if [[ "$PR_CLOSES_CHILD" != "true" ]]; then
    die_json "PR #$PR_NUMBER does not declare 'Closes #$CHILD' (closingIssuesReferences mismatch)" 1
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
    --arg pr_source "$PR_SOURCE" \
    '{status: "merged", child: $child, pr: $pr, pr_source: $pr_source, base: $base, merged_at: $merged_at}'
