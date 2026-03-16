#!/usr/bin/env bash
# extract-thumbnail.sh - Extract a frame from video at specified offset
#
# Usage: extract-thumbnail.sh <video-path> --offset-ms <ms> --output <path>
# Output: JSON with thumbnail path and offset

set -euo pipefail

source "$(dirname "$0")/../../_lib/common.sh"

require_cmd jq
require_cmd ffmpeg "ffmpeg not found. Install: brew install ffmpeg"

# --- Usage ---
usage() {
    cat <<'EOF'
Usage: extract-thumbnail.sh <video-path> --offset-ms <ms> --output <path>

Options:
  --offset-ms MS   Frame offset in milliseconds
  --output PATH    Output JPEG path
  -h, --help       Show this help

Output: JSON with thumbnail path and offset_ms
EOF
    exit "${1:-0}"
}

# --- Parse args ---
VIDEO_PATH=""
OFFSET_MS=""
OUTPUT_PATH=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --offset-ms)
            OFFSET_MS="$2"
            shift 2
            ;;
        --output|-o)
            OUTPUT_PATH="$2"
            shift 2
            ;;
        -h|--help)
            usage 0
            ;;
        -*)
            die_json "Unknown option: $1"
            ;;
        *)
            if [[ -z "$VIDEO_PATH" ]]; then
                VIDEO_PATH="$1"
            else
                die_json "Unexpected argument: $1"
            fi
            shift
            ;;
    esac
done

# --- Validate ---
[[ -z "$VIDEO_PATH" ]] && die_json "Video path required"
[[ -f "$VIDEO_PATH" ]] || die_json "Video file not found: $VIDEO_PATH"
[[ -z "$OFFSET_MS" ]] && die_json "--offset-ms required"
[[ -z "$OUTPUT_PATH" ]] && die_json "--output required"

# --- Convert ms to seconds ---
OFFSET_SEC=$(echo "scale=3; $OFFSET_MS / 1000" | bc 2>/dev/null || die_json "bc not available for ms conversion")

# --- Create output directory ---
OUTPUT_DIR=$(dirname "$OUTPUT_PATH")
mkdir -p "$OUTPUT_DIR"

# --- Extract frame ---
ffmpeg -y -ss "$OFFSET_SEC" -i "$VIDEO_PATH" \
    -frames:v 1 -q:v 2 -update 1 \
    "$OUTPUT_PATH" 2>/dev/null \
    || die_json "ffmpeg failed to extract thumbnail at ${OFFSET_MS}ms"

[[ -f "$OUTPUT_PATH" ]] || die_json "Thumbnail was not created: $OUTPUT_PATH"

# --- Output JSON ---
jq -n \
    --arg thumb "$OUTPUT_PATH" \
    --argjson offset "$OFFSET_MS" \
    '{
        thumbnail: $thumb,
        offset_ms: $offset
    }'
