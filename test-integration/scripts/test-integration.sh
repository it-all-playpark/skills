#!/usr/bin/env bash
# test-integration.sh - Run integration tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

TARGET="" SETUP=false TEARDOWN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --setup) SETUP=true; shift ;;
        --teardown) TEARDOWN=true; shift ;;
        -h|--help) echo "Usage: test-integration.sh [target] [--setup] [--teardown]"; exit 0 ;;
        -*) shift ;;
        *) [[ -z "$TARGET" ]] && TARGET="$1"; shift ;;
    esac
done

DETECT=$("$SCRIPT_DIR/detect-test.sh") || exit $?

FRAMEWORK=$(echo "$DETECT" | jq -r '.framework')
BASE_CMD=$(echo "$DETECT" | jq -r '.commands.unit // empty')

# Find integration test path
FOUND_PATH=""
for path in tests/integration test/integration __tests__/integration integration; do
    [[ -d "$path" ]] && { FOUND_PATH="$path"; break; }
done

TARGET_PATH="${TARGET:-$FOUND_PATH}"
CMD="$BASE_CMD"

case "$FRAMEWORK" in
    vitest|jest) [[ -n "$TARGET_PATH" ]] && CMD="$CMD $TARGET_PATH" ;;
    pytest) [[ -n "$TARGET_PATH" ]] && CMD="$CMD $TARGET_PATH" ;;
    cargo) CMD="cargo test --test '*'"; [[ -n "$TARGET" ]] && CMD="cargo test --test $TARGET" ;;
    go) CMD="go test -tags=integration ./..."; [[ -n "$TARGET_PATH" ]] && CMD="go test -tags=integration $TARGET_PATH" ;;
esac

# Setup
if [[ "$SETUP" == true ]]; then
    [[ -f "scripts/test-setup.sh" ]] && bash scripts/test-setup.sh 2>/dev/null || true
    [[ -f "docker-compose.test.yml" ]] && docker-compose -f docker-compose.test.yml up -d 2>/dev/null || true
fi

START=$(now_sec)
OUTPUT="" STATUS="passed" EXIT_CODE=0
if OUTPUT=$(eval "$CMD" 2>&1); then STATUS="passed"; else STATUS="failed"; EXIT_CODE=$?; fi
DURATION=$(duration_since "$START")

# Teardown
if [[ "$TEARDOWN" == true ]]; then
    [[ -f "scripts/test-teardown.sh" ]] && bash scripts/test-teardown.sh 2>/dev/null || true
    [[ -f "docker-compose.test.yml" ]] && docker-compose -f docker-compose.test.yml down 2>/dev/null || true
fi

cat <<JSONEOF
{
  "status": "$STATUS",
  "framework": "$FRAMEWORK",
  "type": "integration",
  "target": $(json_str "$TARGET_PATH"),
  "setup_ran": $SETUP,
  "teardown_ran": $TEARDOWN,
  "duration_seconds": $DURATION,
  "exit_code": $EXIT_CODE
}
JSONEOF

exit $EXIT_CODE
