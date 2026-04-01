#!/usr/bin/env bash
# analyze-dependencies.sh - Analyze file overlaps between issues
# Usage: analyze-dependencies.sh --issues-json FILE

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Argument Parsing
# ============================================================================

ISSUES_JSON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issues-json)
      ISSUES_JSON="${2:-}"
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

require_cmd jq "jq is required. Install: brew install jq"

[[ -n "$ISSUES_JSON" ]] || die_json "--issues-json is required" 1
[[ -f "$ISSUES_JSON" ]] || die_json "File not found: $ISSUES_JSON" 1

# ============================================================================
# Analysis
# ============================================================================

# Build file→issues mapping and find overlapping files (touched by >1 issue)
OVERLAPS=$(jq '[
  .issues[] as $issue |
  $issue.estimated_files[] |
  { file: ., issue: $issue.number }
] | group_by(.file) | map(select(length > 1)) | map({
  file: .[0].file,
  issues: map(.issue)
})' "$ISSUES_JSON")

# Collect issue numbers that appear in any overlap
OVERLAP_ISSUE_NUMBERS=$(echo "$OVERLAPS" | jq '[.[].issues[]] | unique')

# Find independent issues: no file overlap with any other issue
INDEPENDENT_GROUPS=$(jq --argjson overlap_issues "$OVERLAP_ISSUE_NUMBERS" '
  .issues | map(select(
    (.number as $n | $overlap_issues | index($n) | not)
  )) | map(.number)
' "$ISSUES_JSON")

# Output result
jq -n \
  --argjson overlaps "$OVERLAPS" \
  --argjson independent_groups "$INDEPENDENT_GROUPS" \
  '{overlaps: $overlaps, independent_groups: $independent_groups}'
