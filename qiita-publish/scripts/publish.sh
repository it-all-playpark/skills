#!/bin/bash
# Qiita Publish Script
# Usage: publish.sh <file-path> [--public]

set -e

# Load .env from skill directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$SKILL_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

FILE_PATH="$1"
IS_PUBLIC=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --public)
      IS_PUBLIC=true
      shift
      ;;
  esac
done

# Validation
if [ -z "$FILE_PATH" ]; then
  echo '{"status": "error", "message": "File path required"}' >&2
  exit 1
fi

if [ ! -f "$FILE_PATH" ]; then
  echo '{"status": "error", "message": "File not found: '"$FILE_PATH"'"}' >&2
  exit 1
fi

if [ -z "$QIITA_TOKEN" ]; then
  echo '{"status": "error", "message": "QIITA_TOKEN environment variable not set"}' >&2
  exit 1
fi

# Read file content
CONTENT=$(cat "$FILE_PATH")

# Extract frontmatter and body using awk for accurate parsing
# Frontmatter is between first --- and second --- (only first two occurrences)
FRONTMATTER=$(awk '
  /^---$/ { count++; next }
  count == 1 { print }
  count >= 2 { exit }
' "$FILE_PATH")

BODY=$(awk '
  /^---$/ { count++ }
  count >= 2 { if (count == 2 && /^---$/) { count++; next } print }
' "$FILE_PATH")

# Extract title from frontmatter
TITLE=$(echo "$FRONTMATTER" | grep -E '^title:' | sed 's/^title:[[:space:]]*//' | sed 's/^["'\'']//' | sed 's/["'\'']$//')

if [ -z "$TITLE" ]; then
  echo '{"status": "error", "message": "Title not found in frontmatter"}' >&2
  exit 1
fi

# Extract tags from frontmatter (YAML list format)
# tags:
#   - Tag1
#   - Tag2
TAGS_JSON=$(echo "$FRONTMATTER" | awk '
  /^tags:/ { in_tags=1; next }
  in_tags && /^[[:space:]]+-[[:space:]]+/ {
    gsub(/^[[:space:]]+-[[:space:]]+/, "")
    gsub(/^["'\''"]/, "")
    gsub(/["'\''"]$/, "")
    # Handle "name: Tag" format
    if (match($0, /^name:[[:space:]]*/)) {
      gsub(/^name:[[:space:]]*/, "")
    }
    tags[++n] = $0
    next
  }
  in_tags && /^[a-z]/ { in_tags=0 }
  END {
    printf "["
    for (i=1; i<=n; i++) {
      if (i>1) printf ","
      printf "{\"name\":\"%s\"}", tags[i]
    }
    printf "]"
  }
')

# Default to empty tags array if parsing failed
if [ -z "$TAGS_JSON" ] || [ "$TAGS_JSON" = "[]" ]; then
  TAGS_JSON='[{"name":"未分類"}]'
fi

# Determine private flag (inverse of --public)
if [ "$IS_PUBLIC" = true ]; then
  PRIVATE_FLAG="false"
else
  PRIVATE_FLAG="true"
fi

# Escape body for JSON
BODY_ESCAPED=$(echo "$BODY" | jq -Rs .)

# Build JSON payload
JSON_PAYLOAD=$(cat <<EOF
{
  "title": $(echo "$TITLE" | jq -Rs .),
  "body": $BODY_ESCAPED,
  "tags": $TAGS_JSON,
  "private": $PRIVATE_FLAG
}
EOF
)

# Post to Qiita API
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Authorization: Bearer $QIITA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$JSON_PAYLOAD" \
  "https://qiita.com/api/v2/items")

# Extract HTTP status code (last line)
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

# Check response
if [ "$HTTP_CODE" -eq 201 ]; then
  # Success - extract URL and ID
  ITEM_URL=$(echo "$RESPONSE_BODY" | jq -r '.url')
  ITEM_ID=$(echo "$RESPONSE_BODY" | jq -r '.id')

  echo "{"
  echo "  \"status\": \"success\","
  echo "  \"url\": \"$ITEM_URL\","
  echo "  \"id\": \"$ITEM_ID\","
  echo "  \"private\": $PRIVATE_FLAG"
  echo "}"
else
  # Error
  ERROR_MSG=$(echo "$RESPONSE_BODY" | jq -r '.message // "Unknown error"')
  echo '{"status": "error", "http_code": '"$HTTP_CODE"', "message": "'"$ERROR_MSG"'"}' >&2
  exit 1
fi
