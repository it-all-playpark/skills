#!/bin/bash
#
# Image resize script using vips CLI.
# Supports: resolution, scale, width/height with aspect ratio preservation.
#

set -euo pipefail

usage() {
    cat << 'EOF'
Usage: resize_image.sh <input> -o <output> [options]

Options:
  -o, --output FILE    Output image file (required)
  -W, --width NUM      Target width (px)
  -H, --height NUM     Target height (px)
  -s, --scale NUM      Scale factor (0.5 = 50%, 2 = 200%)
  -q, --quality NUM    Output quality 1-100 (default: 90)
  -h, --help           Show this help

Examples:
  # Resize to specific width (aspect ratio preserved)
  resize_image.sh photo.jpg -o thumb.jpg -W 800

  # Resize with both dimensions
  resize_image.sh photo.jpg -o out.jpg -W 1920 -H 1080

  # Scale to 50%
  resize_image.sh large.jpg -o small.jpg -s 0.5

  # Scale to 200% with max quality
  resize_image.sh icon.png -o icon_2x.png -s 2 -q 95
EOF
    exit "${1:-0}"
}

# Parse arguments
INPUT=""
OUTPUT=""
WIDTH=""
HEIGHT=""
SCALE=""
QUALITY=90

while [[ $# -gt 0 ]]; do
    case "$1" in
        -o|--output)
            OUTPUT="$2"
            shift 2
            ;;
        -W|--width)
            WIDTH="$2"
            shift 2
            ;;
        -H|--height)
            HEIGHT="$2"
            shift 2
            ;;
        -s|--scale)
            SCALE="$2"
            shift 2
            ;;
        -q|--quality)
            QUALITY="$2"
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
            if [[ -z "$INPUT" ]]; then
                INPUT="$1"
            else
                echo "Error: Unexpected argument: $1" >&2
                usage 1
            fi
            shift
            ;;
    esac
done

# Validate required arguments
if [[ -z "$INPUT" ]]; then
    echo "Error: Input file required" >&2
    usage 1
fi

if [[ -z "$OUTPUT" ]]; then
    echo "Error: Output file required (-o)" >&2
    usage 1
fi

if [[ ! -f "$INPUT" ]]; then
    echo "Error: Input file not found: $INPUT" >&2
    exit 1
fi

# Validate mutually exclusive options
if [[ -n "$SCALE" && (-n "$WIDTH" || -n "$HEIGHT") ]]; then
    echo "Error: Cannot specify both scale and width/height" >&2
    exit 1
fi

if [[ -z "$SCALE" && -z "$WIDTH" && -z "$HEIGHT" ]]; then
    echo "Error: Must specify --scale, --width, or --height" >&2
    exit 1
fi

# Get output extension for format-specific options
OUTPUT_EXT="${OUTPUT##*.}"
OUTPUT_EXT=$(echo "$OUTPUT_EXT" | tr '[:upper:]' '[:lower:]')

# Build output options based on format
build_output_options() {
    local opts=""
    case "$OUTPUT_EXT" in
        jpg|jpeg)
            opts="[Q=${QUALITY}]"
            ;;
        png)
            # PNG compression 0-9, convert from quality scale
            local comp=$((( 100 - QUALITY ) / 10))
            [[ $comp -lt 0 ]] && comp=0
            [[ $comp -gt 9 ]] && comp=9
            opts="[compression=${comp}]"
            ;;
        webp)
            opts="[Q=${QUALITY}]"
            ;;
        avif|heif)
            opts="[Q=${QUALITY}]"
            ;;
        tiff|tif)
            opts="[Q=${QUALITY}]"
            ;;
        *)
            opts=""
            ;;
    esac
    echo "$opts"
}

OUTPUT_OPTS=$(build_output_options)

# Perform resize
if [[ -n "$SCALE" ]]; then
    # Scale-based resize using vips resize
    vips resize "$INPUT" "${OUTPUT}${OUTPUT_OPTS}" "$SCALE"
elif [[ -n "$WIDTH" && -n "$HEIGHT" ]]; then
    # Exact dimensions using vips thumbnail with crop
    vips thumbnail "$INPUT" "${OUTPUT}${OUTPUT_OPTS}" "$WIDTH" --height "$HEIGHT" --crop centre
elif [[ -n "$WIDTH" ]]; then
    # Width only (aspect ratio preserved)
    vips thumbnail "$INPUT" "${OUTPUT}${OUTPUT_OPTS}" "$WIDTH"
elif [[ -n "$HEIGHT" ]]; then
    # Height only - need to use width=1000000 to let height control
    vips thumbnail "$INPUT" "${OUTPUT}${OUTPUT_OPTS}" 100000000 --height "$HEIGHT"
fi

echo "Resized: $INPUT -> $OUTPUT"
