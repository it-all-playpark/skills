#!/usr/bin/env bash
# create-draft.sh - Create Gmail draft with base64-encoded content
# Usage: create-draft.sh --to EMAIL --subject SUBJECT --body BODY
# Output: JSON with draft_id and url

set -euo pipefail

source "$(dirname "$0")/../../_lib/common.sh"

require_cmds gws python3 jq

# ============================================================================
# Parse arguments
# ============================================================================

TO=""
SUBJECT=""
BODY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)
      TO="$2"
      shift 2
      ;;
    --subject)
      SUBJECT="$2"
      shift 2
      ;;
    --body)
      BODY="$2"
      shift 2
      ;;
    *)
      die_json "Unknown option: $1"
      ;;
  esac
done

[[ -n "$TO" ]] || die_json "Missing required --to EMAIL"
[[ -n "$SUBJECT" ]] || die_json "Missing required --subject SUBJECT"
[[ -n "$BODY" ]] || die_json "Missing required --body BODY"

# ============================================================================
# Base64 encode with python3 (handles Japanese safely)
# ============================================================================

ENCODED_JSON=$(python3 -c "
import json, base64, sys

to = sys.argv[1]
subject = sys.argv[2]
body = sys.argv[3]

raw = f'To: {to}\r\nSubject: {subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}'
print(json.dumps({'message': {'raw': base64.urlsafe_b64encode(raw.encode()).decode()}}))
" "$TO" "$SUBJECT" "$BODY")

# ============================================================================
# Create draft via gws
# ============================================================================

RESPONSE=$(gws gmail users drafts create --params '{"userId": "me"}' --json "$ENCODED_JSON")

# ============================================================================
# Extract draft ID and construct URL
# ============================================================================

DRAFT_ID=$(echo "$RESPONSE" | jq -r '.id // empty')

if [[ -z "$DRAFT_ID" ]]; then
  die_json "Failed to create draft: no ID in response"
fi

DRAFT_URL="https://mail.google.com/mail/u/0/#drafts?compose=${DRAFT_ID}"

jq -n --arg id "$DRAFT_ID" --arg url "$DRAFT_URL" \
  '{"draft_id": $id, "url": $url}'
