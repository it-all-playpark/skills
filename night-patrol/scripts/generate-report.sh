#!/usr/bin/env bash
# generate-report.sh - Generate night patrol report from state file
# Usage: generate-report.sh --state FILE [--output FILE]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Argument Parsing
# ============================================================================

STATE_FILE=""
OUTPUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state)
      STATE_FILE="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_FILE="${2:-}"
      shift 2
      ;;
    *)
      die_json "Unknown argument: $1" 1
      ;;
  esac
done

# ============================================================================
# Validation
# ============================================================================

if [[ -z "$STATE_FILE" ]]; then
  die_json "--state is required" 1
fi

if [[ ! -f "$STATE_FILE" ]]; then
  die_json "State file not found: $STATE_FILE" 1
fi

require_cmd "jq" "jq is required for JSON processing. Install: brew install jq"

# ============================================================================
# Read State
# ============================================================================

STATE="$(cat "$STATE_FILE")"

DATE="$(echo "$STATE" | jq -r '.date // ""')"
BRANCH="$(echo "$STATE" | jq -r '.branch // ""')"
ISSUES_TOTAL="$(echo "$STATE" | jq -r '.issues_total // 0')"
ISSUES_COMPLETED="$(echo "$STATE" | jq -r '.issues_completed // 0')"
ISSUES_FAILED="$(echo "$STATE" | jq -r '.issues_failed // 0')"
ISSUES_SKIPPED="$(echo "$STATE" | jq -r '.issues_skipped // 0')"
CUMULATIVE_LINES="$(echo "$STATE" | jq -r '.cumulative_lines_changed // 0')"

# ============================================================================
# Resolve Output Path
# ============================================================================

REPO_ROOT="$(git_root)"

if [[ -z "$OUTPUT_FILE" ]]; then
  OUTPUT_DIR="$REPO_ROOT/claudedocs/night-patrol"
  mkdir -p "$OUTPUT_DIR"
  OUTPUT_FILE="$OUTPUT_DIR/${DATE}.md"
fi

# Ensure parent directory exists
mkdir -p "$(dirname "$OUTPUT_FILE")"

# ============================================================================
# Build Report Sections
# ============================================================================

# Completed section rows (status == "merged")
COMPLETED_ROWS="$(echo "$STATE" | jq -r '
  .results // [] |
  .[] | select(.status == "merged") |
  "| #\(.issue) | \(.pr // "-") | \(.lines_changed // 0) | merged |"
')"

# Skipped section rows
SKIPPED_ROWS="$(echo "$STATE" | jq -r '
  .results // [] |
  .[] | select(.status == "skipped") |
  "| #\(.issue) | \(.reason // "-") |"
')"

# Failed section rows
FAILED_ROWS="$(echo "$STATE" | jq -r '
  .results // [] |
  .[] | select(.status == "failed") |
  "| #\(.issue) | \(.reason // "-") |"
')"

# Next steps: skipped issues
SKIPPED_NEXT="$(echo "$STATE" | jq -r '
  .results // [] |
  .[] | select(.status == "skipped") |
  "- [ ] #\(.issue): \(.reason // "要確認")"
')"

# ============================================================================
# Generate Report
# ============================================================================

{
  echo "# Night Patrol Report - ${DATE}"
  echo ""
  echo "## Summary"
  echo "- 検出: ${ISSUES_TOTAL}件 → 処理: ${ISSUES_COMPLETED}件完了 / ${ISSUES_SKIPPED}件スキップ / ${ISSUES_FAILED}件失敗"
  echo "- ブランチ: \`${BRANCH}\`"
  echo "- 累積変更: ${CUMULATIVE_LINES}行"
  echo ""
  echo "## Completed"
  echo "| Issue | PR | 変更行数 | ステータス |"
  echo "|-------|-----|---------|-----------|"
  if [[ -n "$COMPLETED_ROWS" ]]; then
    echo "$COMPLETED_ROWS"
  else
    echo "| - | - | - | (なし) |"
  fi
  echo ""
  echo "## Skipped"
  echo "| Issue | 理由 |"
  echo "|-------|------|"
  if [[ -n "$SKIPPED_ROWS" ]]; then
    echo "$SKIPPED_ROWS"
  else
    echo "| - | (なし) |"
  fi
  echo ""
  echo "## Failed"
  if [[ -n "$FAILED_ROWS" ]]; then
    echo "| Issue | 理由 |"
    echo "|-------|------|"
    echo "$FAILED_ROWS"
  else
    echo "(なし)"
  fi
  echo ""
  echo "## Next Steps"
  echo "- [ ] \`${BRANCH}\` を確認して dev にマージ"
  if [[ -n "$SKIPPED_NEXT" ]]; then
    echo "$SKIPPED_NEXT"
  fi
} > "$OUTPUT_FILE"

# ============================================================================
# Output JSON
# ============================================================================

echo "{\"report_path\":$(json_str "$OUTPUT_FILE"),\"date\":$(json_str "$DATE")}"
