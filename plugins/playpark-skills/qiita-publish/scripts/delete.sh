#!/bin/bash
# Qiita Delete Script
# Usage: delete.sh <item-id>

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$SKILL_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"
fi

ITEM_ID="$1"

if [ -z "$ITEM_ID" ]; then
  echo '{"status": "error", "message": "Usage: delete.sh <item-id>"}' >&2
  exit 1
fi

if [ -z "$QIITA_TOKEN" ]; then
  echo '{"status": "error", "message": "QIITA_TOKEN not set"}' >&2
  exit 1
fi

RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE \
  -H "Authorization: Bearer $QIITA_TOKEN" \
  "https://qiita.com/api/v2/items/$ITEM_ID")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -eq 204 ]; then
  echo "{\"status\": \"success\", \"id\": \"$ITEM_ID\"}"
else
  ERROR_MSG=$(echo "$RESPONSE_BODY" | jq -r '.message // "Unknown error"' 2>/dev/null || echo "Unknown error")
  echo '{"status": "error", "http_code": '"$HTTP_CODE"', "message": "'"$ERROR_MSG"'"}' >&2
  exit 1
fi
