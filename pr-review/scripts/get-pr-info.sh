#!/usr/bin/env bash
# get-pr-info.sh - Fetch PR metadata and diff
# Usage: get-pr-info.sh <pr-number-or-url> [--with-ci]
#
# Output: JSON with PR info, diff, and optionally CI status

set -euo pipefail

PR_REF="${1:-}"
WITH_CI="${2:-}"

if [[ -z "$PR_REF" ]]; then
    echo "Error: PR reference required" >&2
    exit 1
fi

# Get PR metadata
echo "=== PR Metadata ===" >&2
gh pr view "$PR_REF" --json number,title,body,state,author,files,additions,deletions,commits,labels,reviewDecision

echo ""
echo "=== PR Diff ===" >&2
gh pr diff "$PR_REF"

# Get CI status if requested
if [[ "$WITH_CI" == "--with-ci" ]]; then
    echo ""
    echo "=== CI Status ===" >&2
    gh pr checks "$PR_REF" --json name,state,conclusion 2>/dev/null || echo '[]'
fi
