#!/usr/bin/env bash
# test-coverage.sh - Generate coverage reports

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd "jq"

THRESHOLD="" REPORT_FORMAT="text"

while [[ $# -gt 0 ]]; do
    case $1 in
        --threshold) THRESHOLD="$2"; shift 2 ;;
        --report) REPORT_FORMAT="$2"; shift 2 ;;
        -h|--help) echo "Usage: test-coverage.sh [--threshold PERCENT] [--report html|text|json]"; exit 0 ;;
        *) shift ;;
    esac
done

DETECT=$("$SCRIPT_DIR/detect-test.sh") || exit $?

FRAMEWORK=$(echo "$DETECT" | jq -r '.framework')
BASE_CMD=$(echo "$DETECT" | jq -r '.commands.coverage // empty')

[[ -z "$BASE_CMD" ]] && die_json "No coverage command available for $FRAMEWORK"

CMD="$BASE_CMD"
case "$FRAMEWORK" in
    vitest)
        [[ "$REPORT_FORMAT" == "html" ]] && CMD="$CMD --reporter=html"
        [[ "$REPORT_FORMAT" == "json" ]] && CMD="$CMD --reporter=json"
        ;;
    jest)
        [[ "$REPORT_FORMAT" == "html" ]] && CMD="$CMD --coverageReporters=html"
        [[ "$REPORT_FORMAT" == "json" ]] && CMD="$CMD --coverageReporters=json"
        [[ -n "$THRESHOLD" ]] && CMD="$CMD --coverageThreshold='{\"global\":{\"lines\":$THRESHOLD}}'"
        ;;
    pytest)
        [[ "$REPORT_FORMAT" == "html" ]] && CMD="$CMD --cov-report=html"
        [[ "$REPORT_FORMAT" == "json" ]] && CMD="$CMD --cov-report=json"
        [[ -n "$THRESHOLD" ]] && CMD="$CMD --cov-fail-under=$THRESHOLD"
        ;;
esac

START=$(now_sec)
OUTPUT="" STATUS="passed" EXIT_CODE=0
if OUTPUT=$(eval "$CMD" 2>&1); then STATUS="passed"; else STATUS="failed"; EXIT_CODE=$?; fi
DURATION=$(duration_since "$START")

LINES_COV="0" BRANCHES_COV="0" FUNCS_COV="0"
if echo "$OUTPUT" | grep -qE '[0-9]+(\.[0-9]+)?%'; then
    LINES_COV=$(echo "$OUTPUT" | grep -oE 'Lines\s*:\s*[0-9]+(\.[0-9]+)?%' | grep -oE '[0-9]+(\.[0-9]+)?' | head -1 || echo "0")
    BRANCHES_COV=$(echo "$OUTPUT" | grep -oE 'Branches\s*:\s*[0-9]+(\.[0-9]+)?%' | grep -oE '[0-9]+(\.[0-9]+)?' | head -1 || echo "0")
    FUNCS_COV=$(echo "$OUTPUT" | grep -oE 'Functions\s*:\s*[0-9]+(\.[0-9]+)?%' | grep -oE '[0-9]+(\.[0-9]+)?' | head -1 || echo "0")
fi

THRESHOLD_MET="true"
if [[ -n "$THRESHOLD" && "$LINES_COV" != "0" ]]; then
    (( $(echo "$LINES_COV < $THRESHOLD" | bc -l) )) && { THRESHOLD_MET="false"; STATUS="below_threshold"; }
fi

cat <<JSONEOF
{
  "status": "$STATUS",
  "framework": "$FRAMEWORK",
  "coverage": {"lines": $LINES_COV, "branches": $BRANCHES_COV, "functions": $FUNCS_COV},
  "threshold": $(if [[ -n "$THRESHOLD" ]]; then echo "$THRESHOLD"; else echo "null"; fi),
  "threshold_met": $THRESHOLD_MET,
  "report_format": "$REPORT_FORMAT",
  "duration_seconds": $DURATION,
  "exit_code": $EXIT_CODE
}
JSONEOF

exit $EXIT_CODE
