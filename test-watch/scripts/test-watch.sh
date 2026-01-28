#!/usr/bin/env bash
# test-watch.sh - Run tests in watch mode

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

TARGET="" FILTER=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --filter) FILTER="$2"; shift 2 ;;
        -h|--help) echo "Usage: test-watch.sh [target] [--filter PATTERN]"; exit 0 ;;
        -*) shift ;;
        *) [[ -z "$TARGET" ]] && TARGET="$1"; shift ;;
    esac
done

DETECT=$("$SCRIPT_DIR/detect-test.sh") || exit $?

FRAMEWORK=$(echo "$DETECT" | jq -r '.framework')
BASE_CMD=$(echo "$DETECT" | jq -r '.commands.watch // empty')

if [[ -z "$BASE_CMD" ]]; then
    BASE_CMD=$(echo "$DETECT" | jq -r '.commands.unit // empty')
    case "$FRAMEWORK" in
        vitest|jest) BASE_CMD="$BASE_CMD --watch" ;;
        pytest) BASE_CMD="ptw" ;;
        *) die_json "No watch mode available for $FRAMEWORK" ;;
    esac
fi

CMD="$BASE_CMD"
case "$FRAMEWORK" in
    vitest|jest)
        [[ -n "$TARGET" ]] && CMD="$CMD $TARGET"
        [[ -n "$FILTER" ]] && CMD="$CMD -t \"$FILTER\""
        ;;
    pytest)
        [[ -n "$TARGET" ]] && CMD="$CMD -- $TARGET"
        [[ -n "$FILTER" ]] && CMD="$CMD -- -k \"$FILTER\""
        ;;
    cargo) CMD="cargo watch -x test"; [[ -n "$TARGET" ]] && CMD="$CMD -- $TARGET" ;;
esac

cat <<JSONEOF
{
  "status": "starting",
  "framework": "$FRAMEWORK",
  "command": $(json_str "$CMD"),
  "target": $(json_str "$TARGET"),
  "filter": $(json_str "$FILTER"),
  "message": "Starting watch mode..."
}
JSONEOF

exec $CMD
