#!/usr/bin/env bash
# check-duplicates.sh - Fetch open issues for duplicate detection by LLM
# Usage: check-duplicates.sh [--label LABEL]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Argument Parsing
# ============================================================================

LABEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)
      LABEL="${2:-}"
      shift 2
      ;;
    *)
      die_json "Unknown argument: $1" 1
      ;;
  esac
done

# ============================================================================
# Prerequisite Checks
# ============================================================================

require_gh_auth
require_cmd "jq" "jq is required for JSON processing. Install: brew install jq"

# ============================================================================
# Build gh issue list command
# ============================================================================

GH_ARGS=(issue list --state open --json "number,title,body,labels" --limit 200)

if [[ -n "$LABEL" ]]; then
  GH_ARGS+=(--label "$LABEL")
fi

# ============================================================================
# Fetch issues
# ============================================================================

RAW_JSON=$(gh "${GH_ARGS[@]}") || die_json "Failed to fetch GitHub issues" 2

# ============================================================================
# Output: normalized JSON with truncated body (200 chars)
# ============================================================================

echo "$RAW_JSON" | jq '[.[] | {
  number: .number,
  title: .title,
  body_summary: ((.body // "") | .[0:200]),
  labels: (.labels | map(.name))
}]'
