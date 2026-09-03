#!/bin/bash
#
# Image format conversion using vips CLI.
# Supports: JPG, PNG, WEBP, AVIF, TIFF, GIF.
#

set -euo pipefail

usage() {
    cat << 'EOF'
Usage: convert.sh <input> -f <format> [-q <quality>]
       convert.sh <input> -o <output> [-q <quality>]

Options:
  -f, --format FORMAT  Target format (jpg, png, webp, avif, tiff, gif)
  -o, --output FILE    Output image file (format inferred from extension)
  -q, --quality NUM    Output quality 1-100 (default: 90)
  -h, --help           Show this help

Examples:
  # Convert PNG to JPEG
  convert.sh image.png -f jpg

  # Convert JPEG to WEBP
  convert.sh photo.jpg -f webp

  # Convert to AVIF with high quality
  convert.sh image.png -f avif -q 95

  # Specify output path
  convert.sh input.png -o /path/to/output.webp
EOF
    exit "${1:-0}"
}

# Parse arguments
INPUT=""
OUTPUT=""
FORMAT=""
QUALITY=90

while [[ $# -gt 0 ]]; do
    case "$1" in
        -f|--format)
            FORMAT="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT="$2"
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

if [[ ! -f "$INPUT" ]]; then
    echo "Error: Input file not found: $INPUT" >&2
    exit 1
fi

if [[ -z "$OUTPUT" && -z "$FORMAT" ]]; then
    echo "Error: Must specify --output or --format" >&2
    usage 1
fi

# Determine output path and format
if [[ -n "$OUTPUT" ]]; then
    # Format from output extension
    OUTPUT_EXT="${OUTPUT##*.}"
    OUTPUT_EXT=$(echo "$OUTPUT_EXT" | tr '[:upper:]' '[:lower:]')
else
    # Generate output path from input and format
    FORMAT=$(echo "$FORMAT" | tr '[:upper:]' '[:lower:]')
    # Normalize jpeg to jpg
    [[ "$FORMAT" == "jpeg" ]] && FORMAT="jpg"
    INPUT_DIR=$(dirname "$INPUT")
    INPUT_BASE=$(basename "$INPUT")
    INPUT_NAME="${INPUT_BASE%.*}"
    OUTPUT="${INPUT_DIR}/${INPUT_NAME}.${FORMAT}"
    OUTPUT_EXT="$FORMAT"
fi

# Validate format
case "$OUTPUT_EXT" in
    jpg|jpeg|png|webp|avif|heif|tiff|tif|gif)
        ;;
    *)
        echo "Error: Unsupported format: $OUTPUT_EXT" >&2
        echo "Supported formats: jpg, png, webp, avif, tiff, gif" >&2
        exit 1
        ;;
esac

# Build output options based on format
build_output_options() {
    local opts=""
    case "$OUTPUT_EXT" in
        jpg|jpeg)
            opts="[Q=${QUALITY}]"
            ;;
        png)
            # PNG compression 0-9, convert from quality scale
            local comp=$(((100 - QUALITY) / 10))
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

# Perform conversion using vips copy
vips copy "$INPUT" "${OUTPUT}${OUTPUT_OPTS}"

echo "Converted: $INPUT -> $OUTPUT"
