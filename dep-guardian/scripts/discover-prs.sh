#!/usr/bin/env bash
# discover-prs.sh - List dependency update PRs
# Usage: discover-prs.sh [--label LABEL]
# Output: JSON array of PRs with number, title, headRefName, labels, body

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Args
# ============================================================================

LABEL="dependencies"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --label) LABEL="$2"; shift 2 ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

# ============================================================================
# Main
# ============================================================================

require_gh_auth

prs=$(gh pr list \
    --label "$LABEL" \
    --state open \
    --json number,title,headRefName,labels,body \
    --limit 50 2>/dev/null) || die_json "Failed to list PRs with label '$LABEL'" 1

count=$(echo "$prs" | jq 'length')

if [[ "$count" -eq 0 ]]; then
    echo "{\"status\":\"empty\",\"label\":$(json_str "$LABEL"),\"prs\":[]}"
    exit 0
fi

echo "{\"status\":\"ok\",\"label\":$(json_str "$LABEL"),\"count\":$count,\"prs\":$prs}"
