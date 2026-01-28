#!/usr/bin/env bash
# pr-iterate-setup.sh - Checkout PR for iteration
# Usage: pr-iterate-setup.sh <pr-number-or-url>

set -euo pipefail

source "$(dirname "$0")/../../_lib/common.sh"

PR_REF="${1:-}"
[[ -z "$PR_REF" ]] && die_json "PR reference required" 1

require_gh_auth

gh pr checkout "$PR_REF"
echo "Ready for iteration on PR: $PR_REF"
