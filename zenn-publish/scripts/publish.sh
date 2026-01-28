#!/bin/bash
# Zenn Publish Script
# Usage: publish.sh <file-path>
# Copies content to clipboard and opens Zenn editor

set -e

FILE_PATH="$1"

# Validation
if [ -z "$FILE_PATH" ]; then
  echo '{"status": "error", "message": "File path required"}' >&2
  exit 1
fi

if [ ! -f "$FILE_PATH" ]; then
  echo '{"status": "error", "message": "File not found: '"$FILE_PATH"'"}' >&2
  exit 1
fi

# Copy file content to clipboard
cat "$FILE_PATH" | pbcopy

# Open Zenn article creation page
open "https://zenn.dev/dashboard"

echo '{"status": "success", "message": "Content copied to clipboard. Zenn editor opened. Paste with Cmd+V."}'
