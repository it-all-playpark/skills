#!/usr/bin/env bash
# detect-media.sh - Detect video/image metadata and determine content type per platform
#
# Usage: detect-media.sh <media-path> [--type TYPE]
# Output: JSON with width, height, duration, aspect, content_types per platform
#
# --type overrides auto-detection (feed, reels, story, carousel)

set -euo pipefail

source "$(dirname "$0")/../../_lib/common.sh"

require_cmd jq
require_cmd ffprobe "ffprobe not found. Install: brew install ffmpeg"

# --- Usage ---
usage() {
    cat <<'EOF'
Usage: detect-media.sh <media-path> [--type TYPE]

Options:
  --type, -t TYPE   Override content type (feed, reels, story, carousel)
  -h, --help        Show this help

Output: JSON with width, height, duration, aspect, content_types
EOF
    exit "${1:-0}"
}

# --- Parse args ---
MEDIA_PATH=""
TYPE_OVERRIDE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -t|--type)
            TYPE_OVERRIDE="$2"
            shift 2
            ;;
        -h|--help)
            usage 0
            ;;
        -*)
            die_json "Unknown option: $1"
            ;;
        *)
            if [[ -z "$MEDIA_PATH" ]]; then
                MEDIA_PATH="$1"
            else
                die_json "Unexpected argument: $1"
            fi
            shift
            ;;
    esac
done

[[ -z "$MEDIA_PATH" ]] && die_json "Media path required"
[[ -f "$MEDIA_PATH" ]] || die_json "File not found: $MEDIA_PATH"

# --- Detect media type ---
EXT="${MEDIA_PATH##*.}"
EXT=$(echo "$EXT" | tr '[:upper:]' '[:lower:]')

is_image() {
    case "$1" in
        jpg|jpeg|png|gif|webp|avif|heif|bmp|tiff|tif) return 0 ;;
        *) return 1 ;;
    esac
}

is_video() {
    case "$1" in
        mp4|mov|avi|mkv|webm|m4v|flv|wmv|3gp) return 0 ;;
        *) return 1 ;;
    esac
}

# --- Image handling ---
if is_image "$EXT"; then
    # Get dimensions via ffprobe
    PROBE=$(ffprobe -v error -select_streams v:0 \
        -show_entries stream=width,height \
        -of json "$MEDIA_PATH" 2>/dev/null) || die_json "ffprobe failed on image: $MEDIA_PATH"

    WIDTH=$(echo "$PROBE" | jq -r '.streams[0].width // 0')
    HEIGHT=$(echo "$PROBE" | jq -r '.streams[0].height // 0')

    IG_TYPE="${TYPE_OVERRIDE:-feed}"

    jq -n \
        --argjson w "$WIDTH" \
        --argjson h "$HEIGHT" \
        --arg ig "$IG_TYPE" \
        '{
            width: $w,
            height: $h,
            duration: null,
            aspect: (if $h > $w then "9:16" elif $w > $h then "16:9" else "1:1" end),
            media_type: "image",
            content_types: {
                instagram: $ig,
                youtube: null,
                tiktok: null
            }
        }'
    exit 0
fi

# --- Video handling ---
is_video "$EXT" || die_json "Unsupported file extension: $EXT"

PROBE=$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height,duration \
    -of json "$MEDIA_PATH" 2>/dev/null) || die_json "ffprobe failed on video: $MEDIA_PATH"

WIDTH=$(echo "$PROBE" | jq -r '.streams[0].width // 0')
HEIGHT=$(echo "$PROBE" | jq -r '.streams[0].height // 0')
DURATION_RAW=$(echo "$PROBE" | jq -r '.streams[0].duration // "0"')

# Duration may be "N/A" in some containers; fall back to format-level duration
if [[ "$DURATION_RAW" == "N/A" || "$DURATION_RAW" == "null" || -z "$DURATION_RAW" ]]; then
    DURATION_RAW=$(ffprobe -v error -show_entries format=duration \
        -of default=noprint_wrappers=1:nokey=1 "$MEDIA_PATH" 2>/dev/null || echo "0")
fi

# Convert to integer seconds for comparison
DURATION_SEC=$(printf '%.0f' "$DURATION_RAW" 2>/dev/null || echo "0")

# Determine aspect ratio
if [[ "$HEIGHT" -gt "$WIDTH" ]]; then
    ASPECT="9:16"
elif [[ "$WIDTH" -gt "$HEIGHT" ]]; then
    ASPECT="16:9"
else
    ASPECT="1:1"
fi

# --- Content type detection ---
if [[ -n "$TYPE_OVERRIDE" ]]; then
    IG_TYPE="$TYPE_OVERRIDE"
    YT_TYPE="$TYPE_OVERRIDE"
    TT_TYPE="$TYPE_OVERRIDE"
else
    # Auto-detect per platform based on aspect + duration
    if [[ "$ASPECT" == "9:16" && "$DURATION_SEC" -le 90 ]]; then
        IG_TYPE="reels"
        YT_TYPE="shorts"
        TT_TYPE="standard"
    elif [[ "$ASPECT" == "16:9" ]] || [[ "$ASPECT" == "1:1" ]] || [[ "$DURATION_SEC" -gt 90 ]]; then
        IG_TYPE="feed"
        YT_TYPE="standard"
        TT_TYPE="standard"
    else
        IG_TYPE="feed"
        YT_TYPE="standard"
        TT_TYPE="standard"
    fi
fi

jq -n \
    --argjson w "$WIDTH" \
    --argjson h "$HEIGHT" \
    --argjson dur "$DURATION_RAW" \
    --argjson dur_sec "$DURATION_SEC" \
    --arg aspect "$ASPECT" \
    --arg ig "$IG_TYPE" \
    --arg yt "$YT_TYPE" \
    --arg tt "$TT_TYPE" \
    '{
        width: $w,
        height: $h,
        duration: $dur,
        duration_sec: $dur_sec,
        aspect: $aspect,
        media_type: "video",
        content_types: {
            instagram: $ig,
            youtube: $yt,
            tiktok: $tt
        }
    }'
