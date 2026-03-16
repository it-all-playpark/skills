#!/usr/bin/env bash
#
# check-future-links.sh - Check for links to unpublished articles
# Usage: check-future-links.sh --links-json <path> --content-dir DIR
# Output: JSON array of future link violations
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
  "seed_dir": "seed"
}'

CONFIG="$(merge_config "$DEFAULTS" "blog-internal-links")"

LINKS_JSON=""
CONTENT_DIR="$(echo "$CONFIG" | jq -r '.content_dir')"
SEED_DIR="$(echo "$CONFIG" | jq -r '.seed_dir // "seed"')"

# ============================================================================
# Argument Parsing
# ============================================================================

usage() {
    cat << 'EOF'
Usage: check-future-links.sh --links-json <path> [--content-dir DIR]

Options:
  --links-json   Path to links JSON (output of extract-links.sh)
  --content-dir  MDX content directory (git root relative)
  -h, --help     Show this help

Output:
  JSON array of violations:
  [{"from": "slug-a", "to": "slug-b", "reason": "future_date|draft|seed_only", "target_date": "..."}]
EOF
    exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --links-json)  LINKS_JSON="$2";  shift 2 ;;
        --content-dir) CONTENT_DIR="$2"; shift 2 ;;
        -h|--help)     usage 0 ;;
        *)             warn "Unknown option: $1"; shift ;;
    esac
done

[[ -z "$LINKS_JSON" ]] && die_json "Missing required --links-json argument"
[[ ! -f "$LINKS_JSON" ]] && die_json "Links JSON not found: $LINKS_JSON"

# ============================================================================
# Resolve Paths
# ============================================================================

PROJECT_ROOT="$(git_root)"
[[ -z "$PROJECT_ROOT" ]] && die_json "Not in a git repository"

BLOG_DIR="$PROJECT_ROOT/$CONTENT_DIR"
SEED_FULL_DIR="$PROJECT_ROOT/$SEED_DIR"
TODAY="$(date +%Y-%m-%d)"

# ============================================================================
# Frontmatter Extraction
# ============================================================================

extract_frontmatter_field() {
    local file="$1"
    local field="$2"
    sed -n '/^---$/,/^---$/p' "$file" \
        | grep -E "^${field}:" \
        | head -1 \
        | sed "s/^${field}:[[:space:]]*//" \
        | sed "s/^['\"]//;s/['\"]$//" \
        | tr -d $'\r' \
        || echo ""
}

# ============================================================================
# Build Target Article Status Cache
# ============================================================================

declare -A TARGET_STATUS  # slug -> "published|scheduled|draft|seed_only|not_found"
declare -A TARGET_DATE    # slug -> "YYYY-MM-DD"

resolve_target_status() {
    local slug="$1"

    # Already cached?
    if [[ -n "${TARGET_STATUS[$slug]+x}" ]]; then
        return
    fi

    # Find MDX file matching slug
    local mdx_file=""
    mdx_file="$(find "$BLOG_DIR" -name "*${slug}.mdx" -type f 2>/dev/null | head -1)"

    if [[ -z "$mdx_file" ]]; then
        # Check if exists in seed only
        if [[ -d "$SEED_FULL_DIR/$slug" ]]; then
            TARGET_STATUS[$slug]="seed_only"
            TARGET_DATE[$slug]=""
        else
            TARGET_STATUS[$slug]="not_found"
            TARGET_DATE[$slug]=""
        fi
        return
    fi

    # Extract date and draft from frontmatter
    local fm_date
    fm_date="$(extract_frontmatter_field "$mdx_file" "date")"
    local article_date
    article_date="$(echo "$fm_date" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || echo "")"

    # Fallback: extract date from filename
    if [[ -z "$article_date" ]]; then
        local filename
        filename="$(basename "$mdx_file" .mdx)"
        article_date="$(echo "$filename" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || echo "")"
    fi

    local draft_val
    draft_val="$(extract_frontmatter_field "$mdx_file" "draft")"

    TARGET_DATE[$slug]="$article_date"

    if [[ "$draft_val" == "true" ]]; then
        TARGET_STATUS[$slug]="draft"
    elif [[ -n "$article_date" && "$article_date" > "$TODAY" ]]; then
        TARGET_STATUS[$slug]="scheduled"
    else
        TARGET_STATUS[$slug]="published"
    fi
}

# ============================================================================
# Check All Links for Violations
# ============================================================================

VIOLATIONS="[]"

# Iterate over each source slug in the links JSON
while IFS= read -r from_slug; do
    [[ -z "$from_slug" ]] && continue

    # Get target slugs for this source
    while IFS= read -r to_slug; do
        [[ -z "$to_slug" ]] && continue

        resolve_target_status "$to_slug"

        status="${TARGET_STATUS[$to_slug]}"
        target_date="${TARGET_DATE[$to_slug]}"

        # Determine violation reason
        reason=""
        case "$status" in
            scheduled)  reason="future_date" ;;
            draft)      reason="draft" ;;
            seed_only)  reason="seed_only" ;;
            not_found)  reason="not_found" ;;
            published)  continue ;;  # No violation
        esac

        VIOLATIONS="$(echo "$VIOLATIONS" | jq \
            --arg from "$from_slug" \
            --arg to "$to_slug" \
            --arg reason "$reason" \
            --arg target_date "$target_date" \
            '. + [{"from": $from, "to": $to, "reason": $reason, "target_date": $target_date}]')"

    done < <(jq -r --arg slug "$from_slug" '.links[$slug][]? // empty' "$LINKS_JSON")

done < <(jq -r '.links | keys[]' "$LINKS_JSON")

echo "$VIOLATIONS" | jq '.'
