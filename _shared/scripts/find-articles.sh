#!/usr/bin/env bash
#
# find-articles.sh - 記事識別子からMDXファイルを特定
# Usage: find-articles.sh [--content-dir DIR] <identifier>
# Output: JSON array of matching articles
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source common utilities
source "$SKILLS_DIR/_lib/common.sh"

# Defaults
CONTENT_DIR=""
IDENTIFIER=""

usage() {
    cat << 'EOF'
Usage: find-articles.sh [--content-dir DIR] <identifier>

Arguments:
  --content-dir  コンテンツディレクトリ（git root相対、デフォルト: content/blog）
  identifier     日付(2026-02-03), slug(nissan-united), 部分マッチ対応

Output:
  JSON array with: path, date, slug, title, image

Examples:
  find-articles.sh 2026-02-03
  find-articles.sh --content-dir content/blog claude-code-skills
  find-articles.sh crowdlog
EOF
    exit "${1:-0}"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --content-dir)
            CONTENT_DIR="$2"
            shift 2
            ;;
        -h|--help)
            usage 0
            ;;
        *)
            if [[ -z "$IDENTIFIER" ]]; then
                IDENTIFIER="$1"
            fi
            shift
            ;;
    esac
done

if [[ -z "$IDENTIFIER" ]]; then
    usage 1
fi

# Resolve content dir
PROJECT_ROOT="$(git_root)"
[[ -z "$CONTENT_DIR" ]] && CONTENT_DIR="content/blog"
BLOG_DIR="$PROJECT_ROOT/$CONTENT_DIR"

# Parse frontmatter field
extract_field() {
    local file="$1"
    local field="$2"
    sed -n '/^---$/,/^---$/p' "$file" | grep -E "^${field}:" | sed "s/^${field}:[[:space:]]*//" | sed "s/^['\"]//;s/['\"]$//" || echo ""
}

# Find matching files (macOS compatible)
MATCHES=$(find "$BLOG_DIR" -name "*${IDENTIFIER}*.mdx" -type f 2>/dev/null | sort)

if [[ -z "$MATCHES" ]]; then
    echo '{"error":"not_found","message":"No articles matching: '"$IDENTIFIER"'","available":[]}'
    exit 1
fi

# Build JSON output
echo "["
FIRST=true
while IFS= read -r FILE; do
    [[ -z "$FILE" ]] && continue

    FILENAME=$(basename "$FILE" .mdx)

    # Extract date and slug from filename (YYYY-MM-DD-slug)
    DATE=$(echo "$FILENAME" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || echo "")
    SLUG=$(echo "$FILENAME" | sed 's/^[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}-//')

    # Extract from frontmatter
    TITLE=$(extract_field "$FILE" "title")
    IMAGE=$(extract_field "$FILE" "image")

    # Output JSON object
    if [[ "$FIRST" == "true" ]]; then
        FIRST=false
    else
        echo ","
    fi
    cat << JSONEOF
  {
    "path": "$FILE",
    "filename": "$FILENAME",
    "date": "$DATE",
    "slug": "$SLUG",
    "title": $(echo "$TITLE" | jq -R .),
    "image": "$IMAGE"
  }
JSONEOF
done <<< "$MATCHES"
echo "]"
