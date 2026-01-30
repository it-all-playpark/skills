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

# Run marp
echo "Exporting: $INPUT -> $OUTPUT ($FORMAT)"

if command -v marp &> /dev/null; then
  marp "$PROCESS_INPUT" --"$FORMAT" -o "$OUTPUT"
else
  npx @marp-team/marp-cli "$PROCESS_INPUT" --"$FORMAT" -o "$OUTPUT"
fi

echo "Done: $OUTPUT"
