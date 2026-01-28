#!/usr/bin/env bash
# test-unit.sh - Run unit tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

TARGET="" FILTER="" VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --filter) FILTER="$2"; shift 2 ;;
        --verbose) VERBOSE=true; shift ;;
        -h|--help) echo "Usage: test-unit.sh [target] [--filter PATTERN] [--verbose]"; exit 0 ;;
        -*) shift ;;
        *) [[ -z "$TARGET" ]] && TARGET="$1"; shift ;;
    esac
done

DETECT=$("$SCRIPT_DIR/detect-test.sh") || exit $?

FRAMEWORK=$(echo "$DETECT" | jq -r '.framework')
BASE_CMD=$(echo "$DETECT" | jq -r '.commands.unit // empty')

[[ -z "$BASE_CMD" ]] && die_json "No unit test command available"

CMD="$BASE_CMD"
case "$FRAMEWORK" in
    vitest|jest)
        [[ -n "$TARGET" ]] && CMD="$CMD $TARGET"
        [[ -n "$FILTER" ]] && CMD="$CMD -t \"$FILTER\""
        [[ "$VERBOSE" == true ]] && CMD="$CMD --verbose"
        ;;
    pytest)
        [[ -n "$TARGET" ]] && CMD="$CMD $TARGET"
        [[ -n "$FILTER" ]] && CMD="$CMD -k \"$FILTER\""
        [[ "$VERBOSE" == true ]] && CMD="$CMD -v"
        ;;
    cargo)
        [[ -n "$TARGET" ]] && CMD="$CMD $TARGET"
        [[ -n "$FILTER" ]] && CMD="$CMD -- $FILTER"
        ;;
    go)
        [[ -n "$TARGET" ]] && CMD="go test $TARGET"
        [[ -n "$FILTER" ]] && CMD="$CMD -run \"$FILTER\""
        [[ "$VERBOSE" == true ]] && CMD="$CMD -v"
        ;;
esac

START=$(now_sec)
OUTPUT="" STATUS="passed" EXIT_CODE=0

if OUTPUT=$(eval "$CMD" 2>&1); then STATUS="passed"; else STATUS="failed"; EXIT_CODE=$?; fi

DURATION=$(duration_since "$START")

# Extract counts
TESTS_RUN=0 TESTS_PASSED=0 TESTS_FAILED=0
case "$FRAMEWORK" in
    vitest|jest)
        TESTS_PASSED=$(echo "$OUTPUT" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' | head -1 || echo "0")
        TESTS_FAILED=$(echo "$OUTPUT" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' | head -1 || echo "0")
        ;;
    pytest)
        TESTS_PASSED=$(echo "$OUTPUT" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' | head -1 || echo "0")
        TESTS_FAILED=$(echo "$OUTPUT" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' | head -1 || echo "0")
        ;;
esac
TESTS_RUN=$((TESTS_PASSED + TESTS_FAILED))

cat <<JSONEOF
{
  "status": "$STATUS",
  "framework": "$FRAMEWORK",
  "command": $(json_str "$CMD"),
  "duration_seconds": $DURATION,
  "tests": {"total": $TESTS_RUN, "passed": $TESTS_PASSED, "failed": $TESTS_FAILED},
  "exit_code": $EXIT_CODE,
  "output_preview": $(printf '%s' "$OUTPUT" | tail -30 | jq -Rs .)
}
JSONEOF

exit $EXIT_CODE
