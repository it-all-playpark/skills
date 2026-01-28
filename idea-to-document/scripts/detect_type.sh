#!/bin/bash
# detect_type.sh - Detect document type from source content
# Usage: ./detect_type.sh <source-file>
# Output: JSON with recommended type and scores

set -euo pipefail

SOURCE_FILE="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../references/types.json"

if [[ -z "$SOURCE_FILE" || ! -f "$SOURCE_FILE" ]]; then
  echo '{"error": "Source file not found"}' >&2
  exit 1
fi

# Count code blocks
CODE_BLOCKS=$(grep -c '```' "$SOURCE_FILE" 2>/dev/null | awk '{print int($1/2)}') || CODE_BLOCKS=0

# Count keyword matches for each type
count_keywords() {
  local type="$1"
  local keywords
  keywords=$(jq -r ".types[\"$type\"].keywords[]" "$CONFIG_FILE" 2>/dev/null)
  local count=0
  while IFS= read -r kw; do
    if grep -qi "$kw" "$SOURCE_FILE" 2>/dev/null; then
      ((count++)) || true
    fi
  done <<< "$keywords"
  echo "$count"
}

CASE_STUDY=$(count_keywords "case-study")
TECH_TIP=$(count_keywords "tech-tip")
HOWTO=$(count_keywords "howto")
TUTORIAL=$(count_keywords "tutorial")

# Boost tech-tip if many code blocks
if [[ $CODE_BLOCKS -ge 3 ]]; then
  TECH_TIP=$((TECH_TIP + 3))
fi

# Find max score
declare -A scores=(
  ["case-study"]=$CASE_STUDY
  ["tech-tip"]=$TECH_TIP
  ["howto"]=$HOWTO
  ["tutorial"]=$TUTORIAL
)

RECOMMENDED="tech-tip"
MAX_SCORE=0
for type in "${!scores[@]}"; do
  if [[ ${scores[$type]} -gt $MAX_SCORE ]]; then
    MAX_SCORE=${scores[$type]}
    RECOMMENDED="$type"
  fi
done

cat << EOF
{
  "code_blocks": $CODE_BLOCKS,
  "recommended": "$RECOMMENDED",
  "scores": {
    "case-study": $CASE_STUDY,
    "tech-tip": $TECH_TIP,
    "howto": $HOWTO,
    "tutorial": $TUTORIAL
  }
}
EOF
