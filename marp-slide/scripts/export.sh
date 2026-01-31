#!/bin/bash
# Marp slide export script
# Usage: export.sh <input.md> [--format pdf|html|pptx] [-o output]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT=""
FORMAT="pdf"
OUTPUT=""
SKIP_LOGO=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --format)
      FORMAT="$2"
      shift 2
      ;;
    -o|--output)
      OUTPUT="$2"
      shift 2
      ;;
    --skip-logo)
      SKIP_LOGO=true
      shift
      ;;
    *)
      if [[ -z "$INPUT" ]]; then
        INPUT="$1"
      fi
      shift
      ;;
  esac
done

# Validate input
if [[ -z "$INPUT" ]]; then
  echo "Error: Input file required"
  echo "Usage: export.sh <input.md> [--format pdf|html|pptx] [-o output]"
  exit 1
fi

if [[ ! -f "$INPUT" ]]; then
  echo "Error: File not found: $INPUT"
  exit 1
fi

# Determine output filename
if [[ -z "$OUTPUT" ]]; then
  BASENAME="${INPUT%.md}"
  OUTPUT="${BASENAME}.${FORMAT}"
fi

# Validate format
case $FORMAT in
  pdf|html|pptx)
    ;;
  *)
    echo "Error: Invalid format '$FORMAT'. Use: pdf, html, pptx"
    exit 1
    ;;
esac

# Check marp-cli
if ! command -v marp &> /dev/null && ! command -v npx &> /dev/null; then
  echo "Error: marp-cli not found. Install with: npm install -g @marp-team/marp-cli"
  exit 1
fi

# Inject logo if needed
PROCESS_INPUT="$INPUT"
TEMP_FILE=""

if [[ "$SKIP_LOGO" != true ]] && grep -qE "{{LOGO_BASE64}}|url\('\./assets/logo\.png'\)" "$INPUT" 2>/dev/null; then
  TEMP_FILE="$(mktemp -t marp-export-XXXXXX.md)"
  "$SCRIPT_DIR/inject-logo.sh" "$INPUT" -o "$TEMP_FILE"
  PROCESS_INPUT="$TEMP_FILE"
fi

# Cleanup function
cleanup() {
  if [[ -n "$TEMP_FILE" && -f "$TEMP_FILE" ]]; then
    rm -f "$TEMP_FILE"
  fi
}
trap cleanup EXIT

# Detect theme from frontmatter and resolve custom CSS
THEME_OPTS=""
THEME_NAME=$(grep -m1 '^[[:space:]]*theme:' "$INPUT" 2>/dev/null | sed 's/^[[:space:]]*theme:[[:space:]]*//' | tr -d '\r')

if [[ -n "$THEME_NAME" ]]; then
  CUSTOM_THEME="$SCRIPT_DIR/../references/themes/${THEME_NAME}.css"
  if [[ -f "$CUSTOM_THEME" ]]; then
    THEME_OPTS="--theme $CUSTOM_THEME"
    echo "Using custom theme: $THEME_NAME"
  fi
fi

# Run marp
echo "Exporting: $INPUT -> $OUTPUT ($FORMAT)"

if command -v marp &> /dev/null; then
  marp --no-stdin "$PROCESS_INPUT" --"$FORMAT" -o "$OUTPUT" $THEME_OPTS
else
  npx @marp-team/marp-cli --no-stdin "$PROCESS_INPUT" --"$FORMAT" -o "$OUTPUT" $THEME_OPTS
fi

echo "Done: $OUTPUT"
