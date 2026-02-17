#!/bin/bash
#
# Extract chorus clip from YouTube video as .opus with fade-out.
# Requires: yt-dlp, ffmpeg
#

set -euo pipefail

usage() {
    cat << 'EOF'
Usage: extract.sh <youtube-url> --start <MM:SS> [options]

Options:
  --start TIME       Start position (MM:SS or seconds, required)
  --duration SECS    Clip duration in seconds (default: 30)
  --fade SECS        Fade-out duration in seconds (default: 5)
  --bitrate KBPS     Opus bitrate in kbps (default: 128)
  -o, --output FILE  Output file path (default: auto from title)
  -h, --help         Show this help

Examples:
  extract.sh "https://www.youtube.com/watch?v=xxxxx" --start 1:20
  extract.sh "https://youtu.be/xxxxx" --start 2:05 --duration 45 --fade 10
EOF
    exit "${1:-0}"
}

# Defaults
URL=""
START=""
DURATION=30
FADE=5
BITRATE=128
OUTPUT=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --start)
            START="$2"
            shift 2
            ;;
        --duration)
            DURATION="$2"
            shift 2
            ;;
        --fade)
            FADE="$2"
            shift 2
            ;;
        --bitrate)
            BITRATE="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT="$2"
            shift 2
            ;;
        -h|--help)
            usage 0
            ;;
        -*)
            echo "Error: Unknown option: $1" >&2
            usage 1
            ;;
        *)
            if [[ -z "$URL" ]]; then
                URL="$1"
            else
                echo "Error: Unexpected argument: $1" >&2
                usage 1
            fi
            shift
            ;;
    esac
done

# Validate
if [[ -z "$URL" ]]; then
    echo "Error: YouTube URL required" >&2
    usage 1
fi

if [[ -z "$START" ]]; then
    echo "Error: --start is required" >&2
    usage 1
fi

for cmd in yt-dlp ffmpeg; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: $cmd is not installed" >&2
        exit 1
    fi
done

if (( FADE >= DURATION )); then
    echo "Error: Fade duration ($FADE) must be less than clip duration ($DURATION)" >&2
    exit 1
fi

# Convert MM:SS to seconds for ffmpeg -ss (supports both formats)
parse_time() {
    local t="$1"
    if [[ "$t" =~ ^([0-9]+):([0-9]+)$ ]]; then
        echo $(( ${BASH_REMATCH[1]} * 60 + ${BASH_REMATCH[2]} ))
    elif [[ "$t" =~ ^([0-9]+):([0-9]+):([0-9]+)$ ]]; then
        echo $(( ${BASH_REMATCH[1]} * 3600 + ${BASH_REMATCH[2]} * 60 + ${BASH_REMATCH[3]} ))
    elif [[ "$t" =~ ^[0-9]+$ ]]; then
        echo "$t"
    else
        echo "Error: Invalid time format: $t (use MM:SS or seconds)" >&2
        exit 1
    fi
}

START_SEC=$(parse_time "$START")
FADE_START=$((DURATION - FADE))

# Get video title for output filename
echo "Fetching video info..."
TITLE=$(yt-dlp --get-title "$URL" 2>/dev/null || echo "")
if [[ -z "$TITLE" ]]; then
    echo "Error: Could not fetch video info. Check the URL." >&2
    exit 1
fi

# Sanitize title for filename
SAFE_TITLE=$(echo "$TITLE" | sed 's/[/:*?"<>|\\]/ /g' | sed 's/  */ /g' | sed 's/^ *//;s/ *$//')

if [[ -z "$OUTPUT" ]]; then
    OUTPUT="${SAFE_TITLE} (chorus).opus"
fi

# Create temp directory
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Download audio only
echo "Downloading audio: $TITLE"
yt-dlp -f 'bestaudio' \
    --no-playlist \
    -o "$TMPDIR/source.%(ext)s" \
    "$URL" 2>&1 | grep -E '^\[download\]|^\[ExtractAudio\]' || true

# Find downloaded file
SOURCE=$(find "$TMPDIR" -name 'source.*' -type f | head -1)
if [[ -z "$SOURCE" ]]; then
    echo "Error: Download failed" >&2
    exit 1
fi

# Extract clip with fade-out
echo "Extracting ${DURATION}s from ${START} (fade-out: last ${FADE}s)..."
ffmpeg -ss "$START_SEC" -i "$SOURCE" \
    -t "$DURATION" \
    -af "afade=t=out:st=${FADE_START}:d=${FADE}" \
    -c:a libopus -b:a "${BITRATE}k" -vbr on \
    -vn \
    "$OUTPUT" -y 2>/dev/null

# Verify output
if [[ ! -f "$OUTPUT" ]]; then
    echo "Error: Failed to create output file" >&2
    exit 1
fi

SIZE=$(ls -lh "$OUTPUT" | awk '{print $5}')
echo ""
echo "Done: $OUTPUT ($SIZE)"
echo "  Source:   $TITLE"
echo "  Clip:     ${START} + ${DURATION}s"
echo "  Fade-out: last ${FADE}s"
echo "  Bitrate:  ${BITRATE}kbps opus"
