#!/usr/bin/env bash
# pr-setup.sh - Checkout PR and show review feedback
# Usage: pr-setup.sh <pr-number-or-url>

set -euo pipefail

source "$(dirname "$0")/../../_lib/common.sh"

PR_REF="${1:-}"
[[ -z "$PR_REF" ]] && die_json "PR reference required" 1

require_gh_auth

echo "=== Checkout ===" >&2
gh pr checkout "$PR_REF"

echo ""
echo "=== PR Info ===" >&2
gh pr view "$PR_REF" --json number,title,state,additions,deletions

echo ""
echo "=== Review Comments ===" >&2
gh pr view "$PR_REF" --json reviews --jq '.reviews[] | "[\(.state)] \(.author.login): \(.body)"' 2>/dev/null || echo "No reviews yet"

echo ""
echo "=== PR Comments ===" >&2
gh pr view "$PR_REF" --json comments --jq '.comments[] | "\(.author.login): \(.body)"' 2>/dev/null || echo "No comments"

echo ""
echo "=== CI Status ===" >&2
gh pr checks "$PR_REF" 2>/dev/null || echo "No CI checks"
