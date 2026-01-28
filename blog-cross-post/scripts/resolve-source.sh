#!/bin/bash
# resolve-source.sh - Resolve blog source from slug or path
# Usage: ./resolve-source.sh <slug-or-path> [content-dir]
#
# Output: JSON with source_path, slug, seed_path (if exists)

set -euo pipefail

INPUT="${1:-}"
CONTENT_DIR="${2:-content/blog}"
BASE_URL="https://www.playpark.co.jp"

if [[ -z "$INPUT" ]]; then
  echo '{"error": "No input provided"}' | jq .
  exit 1
fi

# Determine if input is path or slug
if [[ -f "$INPUT" ]]; then
  # Direct file path
  SOURCE_PATH="$INPUT"
  FILENAME=$(basename "$SOURCE_PATH" .mdx)
  # Extract slug: remove YYYY-MM-DD- prefix
  SLUG=$(echo "$FILENAME" | sed 's/^[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}-//')
else
  # Slug provided - find matching file
  SLUG="$INPUT"
  # Remove leading/trailing slashes
  SLUG="${SLUG#/}"
  SLUG="${SLUG%/}"

  # Find file matching pattern *-{slug}.mdx
  FOUND=$(find "$CONTENT_DIR" -name "*-${SLUG}.mdx" 2>/dev/null | head -1)

  if [[ -z "$FOUND" ]]; then
    echo "{\"error\": \"No article found for slug: $SLUG\"}" | jq .
    exit 1
  fi

  SOURCE_PATH="$FOUND"
  FILENAME=$(basename "$SOURCE_PATH" .mdx)
fi

# Extract date from filename
DATE=$(echo "$FILENAME" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || echo "")

# Check for related seed directory
SEED_PATH=""
if [[ -d "seed" ]]; then
  # Look for seed directories and check if any article matches
  for seed_dir in seed/*/; do
    if [[ -f "${seed_dir}articles.json" ]]; then
      # Check if this article is in articles.json
      if jq -e ".articles[] | select(.slug == \"$SLUG\")" "${seed_dir}articles.json" > /dev/null 2>&1; then
        SEED_PATH="${seed_dir%/}"
        break
      fi
    fi
  done
fi

# Build original URL
ORIGINAL_URL="${BASE_URL}/blog/${SLUG}"

# Output JSON
jq -n \
  --arg source_path "$SOURCE_PATH" \
  --arg slug "$SLUG" \
  --arg date "$DATE" \
  --arg filename "$FILENAME" \
  --arg seed_path "$SEED_PATH" \
  --arg original_url "$ORIGINAL_URL" \
  '{
    source_path: $source_path,
    slug: $slug,
    date: $date,
    filename: $filename,
    seed_path: (if $seed_path == "" then null else $seed_path end),
    original_url: $original_url
  }'
