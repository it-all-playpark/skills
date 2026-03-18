#!/usr/bin/env bash
# get-gemini-notes.sh - Fetch Gemini notes from Google Docs attachment
# Usage: get-gemini-notes.sh <file-id>
# Output: Plain text content from the Google Doc

set -euo pipefail

source "$(dirname "$0")/../../_lib/common.sh"

require_cmds gws jq python3

# ============================================================================
# Parse arguments
# ============================================================================

FILE_ID="${1:-}"
[[ -n "$FILE_ID" ]] || die_json "Usage: get-gemini-notes.sh <file-id>"

# ============================================================================
# Fetch document (with token retry)
# ============================================================================

fetch_doc() {
  gws docs documents get --params "$(python3 -c "import json; print(json.dumps({'documentId': '${FILE_ID}'}))")"
}

DOC_JSON=$(fetch_doc 2>&1) || {
  # Token may be expired — remove cache and retry once
  warn "gws docs request failed, retrying after token cache removal..."
  TOKEN_CACHE="${HOME}/.config/gws/token_cache.json"
  if [[ -f "$TOKEN_CACHE" ]]; then
    require_cmd rip "rip command not found (needed for safe deletion)"
    rip "$TOKEN_CACHE"
  fi
  DOC_JSON=$(fetch_doc) || die_json "Failed to fetch document $FILE_ID after token refresh"
}

# ============================================================================
# Extract text content from document JSON
# ============================================================================
# Walks body.content[].paragraph.elements[] and concatenates:
#   - textRun.content
#   - autoText (page numbers etc, usually skipped)
#   - richLink.richLinkProperties.title

TEXT=$(echo "$DOC_JSON" | python3 -c "
import json, sys

doc = json.load(sys.stdin)
parts = []

for block in doc.get('body', {}).get('content', []):
    paragraph = block.get('paragraph')
    if not paragraph:
        continue
    for elem in paragraph.get('elements', []):
        # textRun
        text_run = elem.get('textRun')
        if text_run:
            parts.append(text_run.get('content', ''))
            continue
        # richLink
        rich_link = elem.get('richLink', {}).get('richLinkProperties', {})
        if rich_link.get('title'):
            parts.append(rich_link['title'])
            continue

print(''.join(parts).strip())
")

if [[ -z "$TEXT" ]]; then
  die_json "No text content found in document $FILE_ID"
fi

echo "$TEXT"
