#!/usr/bin/env bash
# build.sh - Execute build with options

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

TYPE="dev" CLEAN=false OPTIMIZE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --type) TYPE="$2"; shift 2 ;;
        --clean) CLEAN=true; shift ;;
        --optimize) OPTIMIZE=true; shift ;;
        -h|--help)
            echo "Usage: build.sh [--type dev|prod|test] [--clean] [--optimize]"
            exit 0
            ;;
        *) shift ;;
    esac
done

BUILD_INFO=$("$SCRIPT_DIR/detect-build.sh") || exit $?

SYSTEM=$(echo "$BUILD_INFO" | jq -r '.system')
BUILD_CMD=$(echo "$BUILD_INFO" | jq -r '.commands.build // empty')
DEV_CMD=$(echo "$BUILD_INFO" | jq -r '.commands.dev // empty')
PROD_CMD=$(echo "$BUILD_INFO" | jq -r '.commands.prod // empty')
CLEAN_CMD=$(echo "$BUILD_INFO" | jq -r '.commands.clean // empty')

# Clean if requested
[[ "$CLEAN" == true && -n "$CLEAN_CMD" ]] && eval "$CLEAN_CMD" 2>/dev/null || true

# Select command
case "$TYPE" in
    dev)  CMD="${DEV_CMD:-$BUILD_CMD}" ;;
    prod) CMD="${PROD_CMD:-$BUILD_CMD}"; [[ "$OPTIMIZE" == true && "$SYSTEM" == "node" ]] && CMD="NODE_ENV=production $CMD" ;;
    test) CMD=$(echo "$BUILD_INFO" | jq -r '.commands.test // empty') ;;
esac

[[ -z "$CMD" ]] && die_json "No command available for type: $TYPE"

# Execute
START=$(now_sec)
OUTPUT="" STATUS="success" EXIT_CODE=0

if OUTPUT=$(eval "$CMD" 2>&1); then STATUS="success"; else STATUS="failed"; EXIT_CODE=$?; fi

DURATION=$(duration_since "$START")

# Get output size
OUTPUT_SIZE="0"
for dir in dist .next build target/release; do
    [[ -d "$dir" ]] && { OUTPUT_SIZE=$(du -sh "$dir" 2>/dev/null | cut -f1); break; }
done

cat <<JSONEOF
{
  "status": "$STATUS",
  "type": "$TYPE",
  "system": "$SYSTEM",
  "command": $(json_str "$CMD"),
  "duration_seconds": $DURATION,
  "output_size": "$OUTPUT_SIZE",
  "exit_code": $EXIT_CODE,
  "output_preview": $(printf '%s' "$OUTPUT" | tail -20 | jq -Rs .)
}
JSONEOF

exit $EXIT_CODE
