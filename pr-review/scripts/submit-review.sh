#!/usr/bin/env bash
# submit-review.sh - Submit PR review with automatic fallback
# Usage: submit-review.sh <pr-number> <decision> <body-file>
#
# Arguments:
#   pr-number  - PR number or URL
#   decision   - approve | request-changes | comment
#   body-file  - Path to file containing review body (markdown)
#
# Behavior:
#   - approve: Tries --approve first, falls back to --comment for own PRs
#   - request-changes: Uses --request-changes
#   - comment: Uses --comment directly

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$SCRIPT_DIR/../.."

source "$SKILL_ROOT/_lib/common.sh"

# Parse arguments
PR_REF="${1:-}"
DECISION="${2:-}"
BODY_FILE="${3:-}"

if [[ -z "$PR_REF" ]] || [[ -z "$DECISION" ]] || [[ -z "$BODY_FILE" ]]; then
    die_json "Usage: submit-review.sh <pr-number> <decision> <body-file>"
fi

if [[ ! -f "$BODY_FILE" ]]; then
    die_json "Body file not found: $BODY_FILE"
fi

require_gh_auth

BODY=$(cat "$BODY_FILE")

case "$DECISION" in
    approve)
        # Pre-detect self-PR to avoid the "Cannot approve your own pull request"
        # error from leaking into stderr (which gets logged as a journal failure).
        pr_author=$(gh pr view "$PR_REF" --json author -q '.author.login' 2>/dev/null || echo "")
        me=$(gh api user -q '.login' 2>/dev/null || echo "")
        if [[ -n "$pr_author" && -n "$me" && "$pr_author" == "$me" ]]; then
            echo "Self PR detected ($me); submitting as comment instead of approve..." >&2
            gh pr review "$PR_REF" --comment --body "$BODY"
            echo "Review submitted: comment (self-PR)" >&2
        else
            echo "Attempting to approve PR #$PR_REF..." >&2
            if gh pr review "$PR_REF" --approve --body "$BODY" 2>&1; then
                echo "Review submitted: approved" >&2
            else
                echo "Cannot approve, falling back to comment..." >&2
                gh pr review "$PR_REF" --comment --body "$BODY"
                echo "Review submitted: comment (fallback)" >&2
            fi
        fi
        ;;
    request-changes)
        echo "Submitting changes requested for PR #$PR_REF..." >&2
        gh pr review "$PR_REF" --request-changes --body "$BODY"
        echo "Review submitted: request-changes" >&2
        ;;
    comment)
        echo "Submitting comment for PR #$PR_REF..." >&2
        gh pr review "$PR_REF" --comment --body "$BODY"
        echo "Review submitted: comment" >&2
        ;;
    *)
        die_json "Invalid decision: $DECISION. Must be: approve | request-changes | comment"
        ;;
esac

# Output PR URL
gh pr view "$PR_REF" --json url -q '.url'
