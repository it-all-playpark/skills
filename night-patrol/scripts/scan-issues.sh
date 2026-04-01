#!/usr/bin/env bash
# scan-issues.sh - Fetch unassigned GitHub issues matching configured filters
# Usage: scan-issues.sh [--allowed-labels LIST] [--denylist-labels LIST] [--denylist-issues LIST]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Argument Parsing
# ============================================================================

ALLOWED_LABELS=""
DENYLIST_LABELS=""
DENYLIST_ISSUES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allowed-labels)
      ALLOWED_LABELS="${2:-}"
      shift 2
      ;;
    --denylist-labels)
      DENYLIST_LABELS="${2:-}"
      shift 2
      ;;
    --denylist-issues)
      DENYLIST_ISSUES="${2:-}"
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
require_git_repo
require_cmd "jq" "jq is required for JSON processing. Install: brew install jq"

# ============================================================================
# Build gh issue list command
# ============================================================================

GH_ARGS=(issue list --state open --assignee "" --json "number,title,labels,createdAt,body" --limit 100)

# Add --label flags for each allowed label (gh CLI requires separate flags per label)
if [[ -n "$ALLOWED_LABELS" ]]; then
  IFS=',' read -ra LABEL_ARRAY <<< "$ALLOWED_LABELS"
  for label in "${LABEL_ARRAY[@]}"; do
    label="${label// /}"  # trim spaces
    [[ -n "$label" ]] && GH_ARGS+=(--label "$label")
  done
fi

# ============================================================================
# Fetch issues
# ============================================================================

RAW_JSON=$(gh "${GH_ARGS[@]}") || die_json "Failed to fetch GitHub issues" 2

# ============================================================================
# Filter: denylist labels
# ============================================================================

FILTERED_JSON="$RAW_JSON"

if [[ -n "$DENYLIST_LABELS" ]]; then
  IFS=',' read -ra DENY_LABEL_ARRAY <<< "$DENYLIST_LABELS"
  # Build a JSON array of denylist label names for jq
  DENY_LABELS_JSON=$(printf '%s\n' "${DENY_LABEL_ARRAY[@]}" | \
    awk '{gsub(/^[[:space:]]+|[[:space:]]+$/, ""); if(length) print}' | \
    jq -R . | jq -s '.')
  FILTERED_JSON=$(echo "$FILTERED_JSON" | jq --argjson deny "$DENY_LABELS_JSON" \
    '[.[] | select(
      (.labels | map(.name) | any(. as $l | $deny | index($l))) | not
    )]')
fi

# ============================================================================
# Filter: denylist issue numbers
# ============================================================================

if [[ -n "$DENYLIST_ISSUES" ]]; then
  IFS=',' read -ra DENY_ISSUE_ARRAY <<< "$DENYLIST_ISSUES"
  DENY_NUMBERS_JSON=$(printf '%s\n' "${DENY_ISSUE_ARRAY[@]}" | \
    awk '{gsub(/^[[:space:]]+|[[:space:]]+$/, ""); if(length && $0+0 == $0) print $0+0}' | \
    jq -s '.')
  FILTERED_JSON=$(echo "$FILTERED_JSON" | jq --argjson deny "$DENY_NUMBERS_JSON" \
    '[.[] | select(.number as $n | $deny | index($n) | not)]')
fi

# ============================================================================
# Output: normalized JSON array
# ============================================================================

echo "$FILTERED_JSON" | jq '[.[] | {
  number: .number,
  title: .title,
  labels: (.labels | map(.name)),
  created_at: .createdAt
}]'
