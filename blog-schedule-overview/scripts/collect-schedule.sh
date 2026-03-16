#!/usr/bin/env bash
#
# collect-schedule.sh - Collect publish dates and statuses from all MDX articles
# Usage: collect-schedule.sh [--content-dir DIR] [--seed-dir DIR] [--sns-dir DIR]
# Output: JSON array of article schedule entries
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
  "seed_dir": "seed",
  "sns_post_dir": "post/blog"
}'

CONFIG="$(merge_config "$DEFAULTS" "blog-schedule-overview")"

CONTENT_DIR="$(echo "$CONFIG" | jq -r '.content_dir')"
SEED_DIR="$(echo "$CONFIG" | jq -r '.seed_dir')"
SNS_POST_DIR="$(echo "$CONFIG" | jq -r '.sns_post_dir')"

# ============================================================================
# Argument Parsing
# ============================================================================

usage() {
    cat << 'EOF'
Usage: collect-schedule.sh [--content-dir DIR] [--seed-dir DIR] [--sns-dir DIR]

Options:
  --content-dir  MDX content directory (git root relative)
  --seed-dir     Seed articles directory (git root relative)
  --sns-dir      SNS post schedule directory (git root relative)
  -h, --help     Show this help

Output:
  JSON array of schedule entries:
  [{"slug": "...", "date": "YYYY-MM-DD", "status": "published|scheduled|draft|seed", "sns": "scheduled|posted|none", "path": "..."}]
EOF
    exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --content-dir) CONTENT_DIR="$2"; shift 2 ;;
        --seed-dir)    SEED_DIR="$2";    shift 2 ;;
        --sns-dir)     SNS_POST_DIR="$2"; shift 2 ;;
        -h|--help)     usage 0 ;;
        *)             warn "Unknown option: $1"; shift ;;
    esac
done

# ============================================================================
# Resolve Paths
# ============================================================================

PROJECT_ROOT="$(git_root)"
[[ -z "$PROJECT_ROOT" ]] && die_json "Not in a git repository"

BLOG_DIR="$PROJECT_ROOT/$CONTENT_DIR"
SEED_FULL_DIR="$PROJECT_ROOT/$SEED_DIR"
SNS_FULL_DIR="$PROJECT_ROOT/$SNS_POST_DIR"

TODAY="$(date +%Y-%m-%d)"

# ============================================================================
# Frontmatter Extraction (simple key-value only: date, draft)
# ============================================================================

extract_frontmatter_field() {
    local file="$1"
    local field="$2"
    # Extract between first and second --- lines, then grep the field
    sed -n '/^---$/,/^---$/p' "$file" \
        | grep -E "^${field}:" \
        | head -1 \
        | sed "s/^${field}:[[:space:]]*//" \
        | sed "s/^['\"]//;s/['\"]$//" \
        | tr -d $'\r' \
        || echo ""
}

# ============================================================================
# Determine SNS Status
# ============================================================================

get_sns_status() {
    local slug="$1"

    if [[ ! -d "$SNS_FULL_DIR" ]]; then
        echo "none"
        return
    fi

    # Look for JSON files matching the slug
    local sns_file=""
    sns_file="$(find "$SNS_FULL_DIR" -name "*${slug}*" -type f 2>/dev/null | head -1)"

    if [[ -z "$sns_file" ]]; then
        echo "none"
        return
    fi

    # Check if file contains posted/scheduled status
    if jq -e '.posted // .status == "posted"' "$sns_file" &>/dev/null 2>&1; then
        echo "posted"
    else
        echo "scheduled"
    fi
}

# ============================================================================
# Collect MDX Articles
# ============================================================================

ENTRIES="[]"

if [[ -d "$BLOG_DIR" ]]; then
    while IFS= read -r mdx_file; do
        [[ -z "$mdx_file" ]] && continue

        filename="$(basename "$mdx_file" .mdx)"

        # Extract date and slug from filename (YYYY-MM-DD-slug pattern)
        file_date="$(echo "$filename" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || echo "")"
        slug="$(echo "$filename" | sed 's/^[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}-//')"

        # Extract frontmatter date (overrides filename date if present)
        fm_date="$(extract_frontmatter_field "$mdx_file" "date")"
        # Normalize: take YYYY-MM-DD portion
        if [[ -n "$fm_date" ]]; then
            file_date="$(echo "$fm_date" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || echo "$file_date")"
        fi

        # Extract draft status
        draft_val="$(extract_frontmatter_field "$mdx_file" "draft")"

        # Determine status
        status="published"
        if [[ "$draft_val" == "true" ]]; then
            status="draft"
        elif [[ -n "$file_date" && "$file_date" > "$TODAY" ]]; then
            status="scheduled"
        fi

        # SNS status
        sns="$(get_sns_status "$slug")"

        # Relative path from project root
        rel_path="${mdx_file#"$PROJECT_ROOT"/}"

        ENTRIES="$(echo "$ENTRIES" | jq --arg slug "$slug" \
            --arg date "$file_date" \
            --arg status "$status" \
            --arg sns "$sns" \
            --arg path "$rel_path" \
            '. + [{"slug": $slug, "date": $date, "status": $status, "sns": $sns, "path": $path}]')"

    done < <(find "$BLOG_DIR" -name "*.mdx" -type f 2>/dev/null | sort)
fi

# ============================================================================
# Check Seed Directory for Articles Not Yet in Content
# ============================================================================

if [[ -d "$SEED_FULL_DIR" ]]; then
    # Collect existing slugs from content
    existing_slugs="$(echo "$ENTRIES" | jq -r '.[].slug')"

    while IFS= read -r seed_entry; do
        [[ -z "$seed_entry" ]] && continue
        [[ ! -d "$seed_entry" ]] && continue

        seed_slug="$(basename "$seed_entry")"

        # Skip if already in content
        if echo "$existing_slugs" | grep -qx "$seed_slug"; then
            continue
        fi

        rel_path="${seed_entry#"$PROJECT_ROOT"/}"

        ENTRIES="$(echo "$ENTRIES" | jq --arg slug "$seed_slug" \
            --arg path "$rel_path" \
            '. + [{"slug": $slug, "date": "", "status": "seed", "sns": "none", "path": $path}]')"

    done < <(find "$SEED_FULL_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
fi

# ============================================================================
# Output (sorted by date)
# ============================================================================

echo "$ENTRIES" | jq 'sort_by(.date)'
