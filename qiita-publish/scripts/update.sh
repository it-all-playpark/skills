#!/bin/bash
# Qiita Update Script
# Usage: update.sh <file-path> <item-id> [--public]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$SKILL_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"
fi

FILE_PATH="$1"
ITEM_ID="$2"
IS_PUBLIC=false

for arg in "$@"; do
  case $arg in
    --public)
      IS_PUBLIC=true
      ;;
  esac
done

if [ -z "$FILE_PATH" ] || [ -z "$ITEM_ID" ]; then
  echo '{"status": "error", "message": "Usage: update.sh <file-path> <item-id> [--public]"}' >&2
  exit 1
fi

if [ ! -f "$FILE_PATH" ]; then
  echo '{"status": "error", "message": "File not found: '"$FILE_PATH"'"}' >&2
  exit 1
fi

if [ -z "$QIITA_TOKEN" ]; then
  echo '{"status": "error", "message": "QIITA_TOKEN not set"}' >&2
  exit 1
fi

FRONTMATTER=$(awk '/^---$/ { count++; next } count == 1 { print } count >= 2 { exit }' "$FILE_PATH")

BODY=$(awk '/^---$/ { count++; if (count <= 2) next } count >= 2 { print }' "$FILE_PATH")

TITLE=$(echo "$FRONTMATTER" | grep -E '^title:' | sed 's/^title:[[:space:]]*//' | sed 's/^["'\'']//' | sed 's/["'\'']$//')

if [ -z "$TITLE" ]; then
  echo '{"status": "error", "message": "Title not found in frontmatter"}' >&2
  exit 1
fi

TAGS_JSON=$(echo "$FRONTMATTER" | awk '
  /^tags:/ { in_tags=1; next }
  in_tags && /^[[:space:]]+-[[:space:]]+/ {
    gsub(/^[[:space:]]+-[[:space:]]+/, "")
    gsub(/^["'\''"]/, "")
    gsub(/["'\''"]$/, "")
    if (match($0, /^name:[[:space:]]*/)) {
      gsub(/^name:[[:space:]]*/, "")
    }
    gsub(/ /, "", $0)
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

if [ -z "$TAGS_JSON" ] || [ "$TAGS_JSON" = "[]" ]; then
  TAGS_JSON='[{"name":"未分類"}]'
fi

if [ "$IS_PUBLIC" = true ]; then
  PRIVATE_FLAG="false"
else
  PRIVATE_FLAG="true"
fi

JSON_PAYLOAD=$(jq -n \
  --arg title "$TITLE" \
  --arg body "$BODY" \
  --argjson tags "$TAGS_JSON" \
  --argjson private "$PRIVATE_FLAG" \
  '{title: $title, body: $body, tags: $tags, private: $private}')

RESPONSE=$(curl -s -w "\n%{http_code}" -X PATCH \
  -H "Authorization: Bearer $QIITA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$JSON_PAYLOAD" \
  "https://qiita.com/api/v2/items/$ITEM_ID")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -eq 200 ]; then
  ITEM_URL=$(echo "$RESPONSE_BODY" | jq -r '.url')
  ITEM_ID_OUT=$(echo "$RESPONSE_BODY" | jq -r '.id')
  UPDATED_AT=$(echo "$RESPONSE_BODY" | jq -r '.updated_at')

  echo "{"
  echo "  \"status\": \"success\","
  echo "  \"url\": \"$ITEM_URL\","
  echo "  \"id\": \"$ITEM_ID_OUT\","
  echo "  \"private\": $PRIVATE_FLAG,"
  echo "  \"updated_at\": \"$UPDATED_AT\""
  echo "}"
else
  ERROR_MSG=$(echo "$RESPONSE_BODY" | jq -r '.message // "Unknown error"')
  echo '{"status": "error", "http_code": '"$HTTP_CODE"', "message": "'"$ERROR_MSG"'"}' >&2
  exit 1
fi
