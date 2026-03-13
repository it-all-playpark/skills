#!/bin/bash
# list-articles.sh - List blog articles for cross-post selection
# Usage: ./list-articles.sh [--recent N] [--include-existing] [--all-categories]
#
# Filters:
#   - Only configured categories (default: tech-tips and lab-reports)
#   - Only articles with date <= today (excludes future/scheduled)
#   - Excludes articles already in cross_post_dir/<slug>/ (unless --include-existing)
#
# Output: JSON array of articles with title, date, slug, path, category

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source common utilities
source "$SKILLS_DIR/_lib/common.sh"

# Load config
CONFIG=$(load_skill_config "cross-post-publish")
CONTENT_DIR=$(echo "$CONFIG" | jq -r '.content_dir // "content/blog"')
CROSS_POST_DIR=$(echo "$CONFIG" | jq -r '.cross_post_dir // "post/cross-post"')

# Read categories from config (array)
VALID_CATEGORIES=()
while IFS= read -r cat; do
  [[ -n "$cat" ]] && VALID_CATEGORIES+=("$cat")
done < <(echo "$CONFIG" | jq -r '.cross_post_categories[]? // empty' 2>/dev/null)

# Default categories if not configured
if [[ ${#VALID_CATEGORIES[@]} -eq 0 ]]; then
  VALID_CATEGORIES=("tech-tips" "lab-reports")
fi

# Resolve paths relative to git root
GIT_ROOT=$(git_root)
CONTENT_ABS="$GIT_ROOT/$CONTENT_DIR"
CROSS_POST_ABS="$GIT_ROOT/$CROSS_POST_DIR"

RECENT_COUNT=10
INCLUDE_EXISTING=false
ALL_CATEGORIES=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --recent)
      RECENT_COUNT="${2:-10}"
      shift 2
      ;;
    --include-existing)
      INCLUDE_EXISTING=true
      shift
      ;;
    --all-categories)
      ALL_CATEGORIES=true
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [[ ! -d "$CONTENT_ABS" ]]; then
  echo '{"error": "Content directory not found"}' | jq .
  exit 1
fi

# Function to check if category is valid for cross-post
is_valid_category() {
  local category="$1"
  for valid in "${VALID_CATEGORIES[@]}"; do
    if [[ "$category" == "$valid" ]]; then
      return 0
    fi
  done
  return 1
}

# Get today's date for comparison
TODAY=$(date +%Y-%m-%d)

# Find all MDX files and extract metadata
articles="[]"
skipped_categories="[]"
collected=0

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  [[ $collected -ge $RECENT_COUNT ]] && break

  filename=$(basename "$file" .mdx)

  # Extract date from filename (YYYY-MM-DD-)
  article_date=$(echo "$filename" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || echo "")

  # Skip if no date found
  [[ -z "$article_date" ]] && continue

  # Skip future articles (date > today)
  if [[ "$article_date" > "$TODAY" ]]; then
    continue
  fi

  # Extract slug (remove date prefix)
  slug=$(echo "$filename" | sed 's/^[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}-//')

  # Skip if already cross-posted (unless --include-existing)
  if [[ "$INCLUDE_EXISTING" == false ]] && [[ -d "$CROSS_POST_ABS/$slug" ]]; then
    continue
  fi

  # Extract category from frontmatter
  category=$(grep -m1 '^category:' "$file" 2>/dev/null | sed 's/^category:[[:space:]]*//' | sed 's/^["'"'"']//' | sed 's/["'"'"']$//' || echo "")

  # Skip non-target categories (unless --all-categories)
  if [[ "$ALL_CATEGORIES" == false ]]; then
    if ! is_valid_category "$category"; then
      # Track skipped for reporting
      title=$(grep -m1 '^title:' "$file" 2>/dev/null | sed 's/^title:[[:space:]]*//' | sed 's/^["'"'"']//' | sed 's/["'"'"']$//' || echo "$slug")
      skipped_categories=$(echo "$skipped_categories" | jq \
        --arg slug "$slug" \
        --arg category "$category" \
        --arg title "$title" \
        '. + [{slug: $slug, category: $category, title: $title}]')
      continue
    fi
  fi

  # Extract title from frontmatter
  title=$(grep -m1 '^title:' "$file" 2>/dev/null | sed 's/^title:[[:space:]]*//' | sed 's/^["'"'"']//' | sed 's/["'"'"']$//' || echo "$slug")

  # Check if already cross-posted (for display)
  cross_posted=false
  if [[ -d "$CROSS_POST_ABS/$slug" ]]; then
    cross_posted=true
  fi

  # Add to array
  articles=$(echo "$articles" | jq \
    --arg path "$file" \
    --arg date "$article_date" \
    --arg slug "$slug" \
    --arg title "$title" \
    --arg category "$category" \
    --argjson cross_posted "$cross_posted" \
    '. + [{path: $path, date: $date, slug: $slug, title: $title, category: $category, cross_posted: $cross_posted}]')

  collected=$((collected + 1))

done < <(find "$CONTENT_ABS" -name "*.mdx" -type f | sort -r)

# Build valid_categories JSON array
valid_cats_json=$(printf '%s\n' "${VALID_CATEGORIES[@]}" | jq -R . | jq -s .)

# Output with count and metadata
jq -n \
  --argjson articles "$articles" \
  --argjson skipped "$skipped_categories" \
  --arg today "$TODAY" \
  --argjson include_existing "$INCLUDE_EXISTING" \
  --argjson all_categories "$ALL_CATEGORIES" \
  --argjson valid_categories "$valid_cats_json" \
  '{
    count: ($articles | length),
    skipped_count: ($skipped | length),
    today: $today,
    include_existing: $include_existing,
    all_categories: $all_categories,
    valid_categories: $valid_categories,
    articles: $articles,
    skipped: $skipped
  }'
