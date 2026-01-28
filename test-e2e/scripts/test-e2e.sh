#!/usr/bin/env bash
# test-e2e.sh - Run E2E tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

TARGET="" HEADED=false BROWSER=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --headed) HEADED=true; shift ;;
        --browser) BROWSER="$2"; shift 2 ;;
        -h|--help) echo "Usage: test-e2e.sh [target] [--headed] [--browser chrome|firefox|webkit]"; exit 0 ;;
        -*) shift ;;
        *) [[ -z "$TARGET" ]] && TARGET="$1"; shift ;;
    esac
done

DETECT=$("$SCRIPT_DIR/detect-test.sh") || exit $?

HAS_PLAYWRIGHT=$(echo "$DETECT" | jq -r '.has_playwright')
HAS_CYPRESS=$(echo "$DETECT" | jq -r '.has_cypress')
BASE_CMD=$(echo "$DETECT" | jq -r '.commands.e2e // empty')

[[ -z "$BASE_CMD" ]] && die_json "No E2E framework detected (Playwright or Cypress required)"

CMD="$BASE_CMD"
if [[ "$HAS_PLAYWRIGHT" == "true" ]]; then
    [[ -n "$TARGET" ]] && CMD="$CMD $TARGET"
    [[ "$HEADED" == true ]] && CMD="$CMD --headed"
    [[ -n "$BROWSER" ]] && CMD="$CMD --project=$BROWSER"
elif [[ "$HAS_CYPRESS" == "true" ]]; then
    [[ -n "$TARGET" ]] && CMD="$CMD --spec \"$TARGET\""
    [[ "$HEADED" == true ]] && CMD="${CMD/cypress run/cypress open}"
    [[ -n "$BROWSER" ]] && CMD="$CMD --browser $BROWSER"
fi

START=$(now_sec)
OUTPUT="" STATUS="passed" EXIT_CODE=0
if OUTPUT=$(eval "$CMD" 2>&1); then STATUS="passed"; else STATUS="failed"; EXIT_CODE=$?; fi
DURATION=$(duration_since "$START")

TESTS_PASSED=0 TESTS_FAILED=0
if [[ "$HAS_PLAYWRIGHT" == "true" ]]; then
    TESTS_PASSED=$(echo "$OUTPUT" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' | head -1 || echo "0")
    TESTS_FAILED=$(echo "$OUTPUT" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' | head -1 || echo "0")
fi

E2E_FRAMEWORK="playwright"
[[ "$HAS_CYPRESS" == "true" ]] && E2E_FRAMEWORK="cypress"

cat <<JSONEOF
{
  "status": "$STATUS",
  "framework": "$E2E_FRAMEWORK",
  "command": $(json_str "$CMD"),
  "options": {"headed": $HEADED, "browser": $(json_str "$BROWSER")},
  "tests": {"passed": $TESTS_PASSED, "failed": $TESTS_FAILED},
  "duration_seconds": $DURATION,
  "exit_code": $EXIT_CODE
}
JSONEOF

exit $EXIT_CODE
