#!/bin/bash
# Inject logo base64 into Marp slides or CSS files
# Usage: inject-logo.sh <input.md|input.css> [-o output] [--logo path/to/logo.png]
#
# Replaces {{LOGO_BASE64}} placeholder with data URI of the logo
# If no output specified, modifies file in-place
#
# Examples:
#   inject-logo.sh slides.md                    # In-place injection
#   inject-logo.sh slides.md -o output.md       # Output to new file
#   inject-logo.sh theme.css --logo custom.png  # Use custom logo

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
LOGO_PATH="${SKILL_DIR}/assets/logo.png"

INPUT=""
OUTPUT=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -o|--output)
      OUTPUT="$2"
      shift 2
      ;;
    --logo)
      LOGO_PATH="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: inject-logo.sh <input> [-o output] [--logo path/to/logo.png]"
      echo ""
      echo "Options:"
      echo "  -o, --output  Output file path (default: in-place)"
      echo "  --logo        Custom logo path (default: assets/logo.png)"
      echo ""
      echo "Placeholders replaced:"
      echo "  {{LOGO_BASE64}}  - Full data URI for logo"
      exit 0
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
  echo "Usage: inject-logo.sh <input> [-o output] [--logo path/to/logo.png]"
  exit 1
fi

if [[ ! -f "$INPUT" ]]; then
  echo "Error: File not found: $INPUT"
  exit 1
fi

# Check if placeholder exists
PLACEHOLDER="{{LOGO_BASE64}}"

if ! grep -q "$PLACEHOLDER" "$INPUT"; then
  echo "No {{LOGO_BASE64}} placeholder found, skipping injection"
  if [[ -n "$OUTPUT" && "$OUTPUT" != "$INPUT" ]]; then
    cp "$INPUT" "$OUTPUT"
  fi
  exit 0
fi

# Check logo file
if [[ ! -f "$LOGO_PATH" ]]; then
  echo "Error: Logo file not found: $LOGO_PATH"
  echo "Please ensure assets/logo.png exists or specify --logo path"
  exit 1
fi

# Generate base64 data URI
echo "Converting logo to base64: $LOGO_PATH"
LOGO_BASE64="data:image/png;base64,$(base64 -i "$LOGO_PATH" | tr -d '\n')"

# Determine output
if [[ -z "$OUTPUT" ]]; then
  OUTPUT="$INPUT"
fi

# Inject logo using Python for reliable handling of large strings
python3 << EOF
import sys

with open('$INPUT', 'r') as f:
    content = f.read()

logo_base64 = '''$LOGO_BASE64'''

# Count replacements
count = content.count('{{LOGO_BASE64}}')

# Replace placeholder
content = content.replace('{{LOGO_BASE64}}', logo_base64)

with open('$OUTPUT', 'w') as f:
    f.write(content)

print(f"Injected logo ({count} occurrences) into: $OUTPUT")
EOF
