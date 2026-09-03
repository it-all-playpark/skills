#!/usr/bin/env bash
# extract-metadata.sh - Extract metadata from MDX/Markdown files
# Usage: extract-metadata.sh <file-path> [--base-url URL] [--url-pattern PATTERN]
#
# Output: JSON with title, description, tags, category, url, date

set -euo pipefail

FILE_PATH=""
BASE_URL=""
URL_PATTERN=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --base-url)
            BASE_URL="$2"
            shift 2
            ;;
        --url-pattern)
            URL_PATTERN="$2"
            shift 2
            ;;
        *)
            if [[ -z "$FILE_PATH" ]]; then
                FILE_PATH="$1"
            fi
            shift
            ;;
    esac
done

if [[ -z "$FILE_PATH" ]] || [[ ! -f "$FILE_PATH" ]]; then
    echo '{"error":"file_not_found","message":"File path required or file does not exist"}'
    exit 1
fi

if [[ -z "$BASE_URL" ]]; then
    echo '{"error":"base_url_required","message":"--base-url is required"}'
    exit 1
fi

# Read file content
CONTENT=$(cat "$FILE_PATH")

# Extract frontmatter (between first two ---)
FRONTMATTER=$(echo "$CONTENT" | sed -n '/^---$/,/^---$/p' | sed '1d;$d')

# Parse YAML fields
extract_field() {
    local field="$1"
    echo "$FRONTMATTER" | grep -E "^${field}:" | sed "s/^${field}:[[:space:]]*//" | sed 's/^["'"'"']//;s/["'"'"']$//' || echo ""
}

# Extract arrays (tags)
extract_array() {
    local field="$1"
    local in_array=false
    local result=""

    while IFS= read -r line; do
        if [[ "$line" =~ ^${field}: ]]; then
            in_array=true
            # Check for inline array
            if [[ "$line" =~ \[.*\] ]]; then
                result=$(echo "$line" | grep -oE '\[.*\]' | tr -d '[]' | sed 's/,/ /g')
                break
            fi
            continue
        fi
        if $in_array; then
            if [[ "$line" =~ ^[[:space:]]*-[[:space:]] ]]; then
                item=$(echo "$line" | sed 's/^[[:space:]]*-[[:space:]]*//' | sed 's/^["'"'"']//;s/["'"'"']$//')
                result="$result $item"
            elif [[ ! "$line" =~ ^[[:space:]] ]]; then
                break
            fi
        fi
    done <<< "$FRONTMATTER"

    echo "$result" | xargs
}

TITLE=$(extract_field "title")
DESCRIPTION=$(extract_field "description")
CATEGORY=$(extract_field "category")
DATE=$(extract_field "date")
TAGS=$(extract_array "tags")

# Generate URL from file path
FILENAME=$(basename "$FILE_PATH" .mdx)
FILENAME=$(basename "$FILENAME" .md)
# Remove date prefix (YYYY-MM-DD-)
SLUG=$(echo "$FILENAME" | sed 's/^[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}-//')

# Determine URL path
if [[ -n "$URL_PATTERN" ]]; then
    # Use custom pattern: replace {slug} with actual slug
    URL_PATH=$(echo "$URL_PATTERN" | sed "s/{slug}/$SLUG/g")
elif [[ "$FILE_PATH" == *"/blog/"* ]]; then
    URL_PATH="/blog/$SLUG"
elif [[ "$FILE_PATH" == *"/news/"* ]]; then
    URL_PATH="/news/$SLUG"
else
    URL_PATH="/$SLUG"
fi

# Remove trailing slash from BASE_URL if present
BASE_URL="${BASE_URL%/}"
FULL_URL="${BASE_URL}${URL_PATH}"

# Convert tags to JSON array
TAGS_JSON=$(echo "$TAGS" | tr ' ' '\n' | grep -v '^$' | jq -R . | jq -s . 2>/dev/null || echo "[]")

# Output JSON
cat <<JSONEOF
{
  "title": $(echo "$TITLE" | jq -R .),
  "description": $(echo "$DESCRIPTION" | jq -R .),
  "category": $(echo "$CATEGORY" | jq -R .),
  "date": $(echo "$DATE" | jq -R .),
  "tags": $TAGS_JSON,
  "slug": "$SLUG",
  "url": "$FULL_URL",
  "file": "$FILE_PATH"
}
JSONEOF
