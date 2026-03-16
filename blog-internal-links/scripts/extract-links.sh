#!/usr/bin/env bash
#
# extract-links.sh - Extract all internal links from MDX articles
# Usage: extract-links.sh [--content-dir DIR] [--blog-prefix PREFIX]
# Output: JSON with link matrix
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$SKILLS_DIR/_lib/common.sh"

require_cmd "jq"

# ============================================================================
# Defaults & Config
# ============================================================================

DEFAULTS='{
  "content_dir": "content/blog",
  "blog_path_prefix": "/blog/"
}'

CONFIG="$(merge_config "$DEFAULTS" "blog-internal-links")"

CONTENT_DIR="$(echo "$CONFIG" | jq -r '.content_dir')"
BLOG_PREFIX="$(echo "$CONFIG" | jq -r '.blog_path_prefix')"

# ============================================================================
# Argument Parsing
# ============================================================================

usage() {
    cat << 'EOF'
Usage: extract-links.sh [--content-dir DIR] [--blog-prefix PREFIX]

Options:
  --content-dir   MDX content directory (git root relative)
  --blog-prefix   Blog URL prefix (default: /blog/)
  -h, --help      Show this help

Output:
  JSON with link matrix:
  {"links": {"slug-a": ["slug-b", "slug-c"]}, "counts": {"slug-a": 2}}
EOF
    exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --content-dir)  CONTENT_DIR="$2"; shift 2 ;;
        --blog-prefix)  BLOG_PREFIX="$2"; shift 2 ;;
        -h|--help)      usage 0 ;;
        *)              warn "Unknown option: $1"; shift ;;
    esac
done

# ============================================================================
# Resolve Paths
# ============================================================================

PROJECT_ROOT="$(git_root)"
[[ -z "$PROJECT_ROOT" ]] && die_json "Not in a git repository"

BLOG_DIR="$PROJECT_ROOT/$CONTENT_DIR"
[[ ! -d "$BLOG_DIR" ]] && die_json "Content directory not found: $BLOG_DIR"

# Escape prefix for grep regex (escape /)
ESCAPED_PREFIX="$(echo "$BLOG_PREFIX" | sed 's|/|\\/|g')"

# ============================================================================
# Extract Internal Links from a Single File
# ============================================================================

extract_links_from_file() {
    local file="$1"
    local links=""

    # Pattern 1: Markdown links [text](/blog/slug) or [text](/blog/slug/)
    local md_links
    md_links="$(grep -oE '\[[^]]*\]\('"$BLOG_PREFIX"'[^)]+\)' "$file" 2>/dev/null \
        | grep -oE '\('"$BLOG_PREFIX"'[^)]+\)' \
        | sed 's/^(//;s/)$//' \
        || true)"

    # Pattern 2: MDX/JSX href="/blog/slug"
    local jsx_links
    jsx_links="$(grep -oE 'href="'"$BLOG_PREFIX"'[^"]*"' "$file" 2>/dev/null \
        | sed 's/^href="//;s/"$//' \
        || true)"

    # Combine all links
    links="$(printf '%s\n%s' "$md_links" "$jsx_links" | sort -u)"

    # Extract slug from each URL
    while IFS= read -r url; do
        [[ -z "$url" ]] && continue

        # Remove prefix, trailing slash, and any anchor/query
        local slug
        slug="$(echo "$url" \
            | sed "s|^${BLOG_PREFIX}||" \
            | sed 's|/$||' \
            | sed 's|[#?].*||')"

        [[ -n "$slug" ]] && echo "$slug"
    done <<< "$links"
}

# ============================================================================
# Build Link Matrix
# ============================================================================

LINKS_JSON="{}"
COUNTS_JSON="{}"

while IFS= read -r mdx_file; do
    [[ -z "$mdx_file" ]] && continue

    filename="$(basename "$mdx_file" .mdx)"

    # Extract source slug from filename (YYYY-MM-DD-slug pattern)
    from_slug="$(echo "$filename" | sed 's/^[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}-//')"

    # Get all target slugs
    target_slugs="$(extract_links_from_file "$mdx_file")"

    # Build JSON array of targets (deduplicated)
    targets_array="[]"
    if [[ -n "$target_slugs" ]]; then
        targets_array="$(echo "$target_slugs" | sort -u | jq -R . | jq -s '.')"
    fi

    count="$(echo "$targets_array" | jq 'length')"

    LINKS_JSON="$(echo "$LINKS_JSON" | jq --arg slug "$from_slug" --argjson targets "$targets_array" '. + {($slug): $targets}')"
    COUNTS_JSON="$(echo "$COUNTS_JSON" | jq --arg slug "$from_slug" --argjson count "$count" '. + {($slug): $count}')"

done < <(find "$BLOG_DIR" -name "*.mdx" -type f 2>/dev/null | sort)

# ============================================================================
# Output
# ============================================================================

jq -n --argjson links "$LINKS_JSON" --argjson counts "$COUNTS_JSON" \
    '{"links": $links, "counts": $counts}'
