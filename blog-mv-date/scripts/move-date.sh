#!/bin/bash
#
# move-date.sh - ブログ記事の投稿日を移動
# Usage: move-date.sh <article_path> <dest_date> [--dry-run]
#
# Operations:
#   1. MDXファイルリネーム
#   2. frontmatter date/image更新
#   3. 画像リネーム
#   4. seed/articles.json更新
#   5. post/blog/*.json更新
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source common utilities
source "$SKILLS_DIR/_lib/common.sh"

# Load config
CONFIG=$(load_skill_config "blog-mv-date")
CONTENT_DIR=$(echo "$CONFIG" | jq -r '.content_dir // "content/blog"')
IMAGE_DIR=$(echo "$CONFIG" | jq -r '.image_dir // "public/blog"')
IMAGE_EXT=$(echo "$CONFIG" | jq -r '.image_ext // ".webp"')
SEED_DIR=$(echo "$CONFIG" | jq -r '.seed_dir // "seed"')
SNS_POST_DIR=$(echo "$CONFIG" | jq -r '.sns_post_dir // "post/blog"')

PROJECT_ROOT="$(git_root)"

# OS detection for sed compatibility
if [[ "$(uname)" == "Darwin" ]]; then
    SED_INPLACE=(sed -i '')
else
    SED_INPLACE=(sed -i)
fi

DRY_RUN=false
ARTICLE=""
DEST_DATE=""

usage() {
    cat << 'EOF'
Usage: move-date.sh <article_path> <dest_date> [--dry-run]

Arguments:
  article_path  記事のMDXファイルパス
  dest_date     移動先の日付 (YYYY-MM-DD)
  --dry-run     変更内容を表示するのみ（実行しない）

Examples:
  move-date.sh content/blog/2026-02-03-foo.mdx 2026-03-19
  move-date.sh content/blog/2026-02-03-foo.mdx 2026-03-19 --dry-run
EOF
    exit "${1:-0}"
}

log() {
    echo "[move-date] $*" >&2
}

# Extract date and slug from MDX path
parse_mdx_path() {
    local path="$1"
    local filename=$(basename "$path" .mdx)
    local date=$(echo "$filename" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
    local slug=$(echo "$filename" | sed 's/^[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}-//')
    echo "$date $slug"
}

# Validate date format (YYYY-MM-DD)
validate_date() {
    local date="$1"
    if ! echo "$date" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
        echo "Error: Invalid date format: $date (expected YYYY-MM-DD)" >&2
        exit 1
    fi
}

# Update frontmatter date and image
update_frontmatter() {
    local file="$1"
    local new_date="$2"
    local old_date="$3"
    local slug="$4"

    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] Update $file: date=$new_date, image=/${IMAGE_DIR##*/}/${new_date}-${slug}${IMAGE_EXT}"
        return
    fi

    # Update date field
    "${SED_INPLACE[@]}" "s/^date: ${old_date}/date: ${new_date}/" "$file"

    # Update image path
    "${SED_INPLACE[@]}" "s|image: '/${IMAGE_DIR##*/}/${old_date}-${slug}|image: '/${IMAGE_DIR##*/}/${new_date}-${slug}|" "$file"
}

# Update seed/*/articles.json
update_seed() {
    local old_path="$1"
    local new_path="$2"
    local old_date="$3"
    local new_date="$4"

    # Convert to relative path for searching in seed files
    local old_relative="${old_path#$PROJECT_ROOT/}"
    local new_relative="${new_path#$PROJECT_ROOT/}"

    local seed_abs="$PROJECT_ROOT/$SEED_DIR"

    # Find seed files containing this article
    local seed_files=$(grep -rl "$old_relative" "$seed_abs" 2>/dev/null || true)

    for seed_file in $seed_files; do
        if [[ -z "$seed_file" ]]; then continue; fi

        if [[ "$DRY_RUN" == "true" ]]; then
            log "[DRY-RUN] Update $seed_file: path=$new_relative, date ${old_date} -> ${new_date} (preserving time)"
            continue
        fi

        # Update path
        "${SED_INPLACE[@]}" "s|$old_relative|$new_relative|g" "$seed_file"

        # Update createdAt date portion only (preserve original time: T##:##:##Z)
        "${SED_INPLACE[@]}" "s|\"createdAt\": \"${old_date}T|\"createdAt\": \"${new_date}T|g" "$seed_file"

        log "Updated seed: $seed_file"
    done
}

# Update and rename post/blog/*.json
update_sns_post() {
    local old_date="$1"
    local new_date="$2"
    local slug="$3"

    local sns_abs="$PROJECT_ROOT/$SNS_POST_DIR"
    local old_post="$sns_abs/${old_date}-${slug}.json"
    local new_post="$sns_abs/${new_date}-${slug}.json"

    if [[ ! -f "$old_post" ]]; then
        log "No SNS post file: $old_post (skipping)"
        return
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] Update schedule dates: $old_date -> $new_date"
        log "[DRY-RUN] Rename $old_post -> $new_post"
        return
    fi

    # Update schedule dates in content
    "${SED_INPLACE[@]}" "s|\"schedule\": \"${old_date}|\"schedule\": \"${new_date}|g" "$old_post"

    # Rename file
    mv "$old_post" "$new_post"

    log "Updated SNS post: $old_post -> $new_post"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            usage 0
            ;;
        *)
            if [[ -z "$ARTICLE" ]]; then
                ARTICLE="$1"
            elif [[ -z "$DEST_DATE" ]]; then
                DEST_DATE="$1"
            else
                echo "Error: Too many arguments" >&2
                usage 1
            fi
            shift
            ;;
    esac
done

# Validate arguments
if [[ -z "$ARTICLE" || -z "$DEST_DATE" ]]; then
    echo "Error: Article path and destination date required" >&2
    usage 1
fi

# Validate destination date format
validate_date "$DEST_DATE"

# Resolve to absolute path
[[ "$ARTICLE" != /* ]] && ARTICLE="$PROJECT_ROOT/$ARTICLE"

if [[ ! -f "$ARTICLE" ]]; then
    echo "Error: Article not found: $ARTICLE" >&2
    exit 1
fi

# Parse article info
read OLD_DATE SLUG <<< $(parse_mdx_path "$ARTICLE")

# Check if dates are the same (no-op)
if [[ "$OLD_DATE" == "$DEST_DATE" ]]; then
    echo "Error: Article already has date $OLD_DATE. Nothing to move." >&2
    exit 0
fi

# Check destination doesn't already exist
BLOG_DIR="$PROJECT_ROOT/$CONTENT_DIR"
NEW_MDX="$BLOG_DIR/${DEST_DATE}-${SLUG}.mdx"

if [[ -f "$NEW_MDX" ]]; then
    echo "Error: Destination already exists: $NEW_MDX" >&2
    exit 1
fi

log "Article: $OLD_DATE / $SLUG"
log "Moving date: $OLD_DATE -> $DEST_DATE"
[[ "$DRY_RUN" == "true" ]] && log "=== DRY RUN MODE ==="

# Calculate new paths
IMG_ABS="$PROJECT_ROOT/$IMAGE_DIR"
OLD_IMAGE="$IMG_ABS/${OLD_DATE}-${SLUG}${IMAGE_EXT}"
NEW_IMAGE="$IMG_ABS/${DEST_DATE}-${SLUG}${IMAGE_EXT}"

# Step 1: Update SNS post schedules and rename (before renaming MDX)
log "Step 1: Updating SNS post..."
update_sns_post "$OLD_DATE" "$DEST_DATE" "$SLUG"

# Step 2: Rename MDX file
log "Step 2: Renaming MDX file..."
if [[ "$DRY_RUN" == "true" ]]; then
    log "[DRY-RUN] mv $ARTICLE -> $NEW_MDX"
else
    mv "$ARTICLE" "$NEW_MDX"
fi

# Step 3: Update frontmatter
log "Step 3: Updating frontmatter..."
update_frontmatter "$NEW_MDX" "$DEST_DATE" "$OLD_DATE" "$SLUG"

# Step 4: Rename image
log "Step 4: Renaming image..."
if [[ -f "$OLD_IMAGE" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] mv $OLD_IMAGE -> $NEW_IMAGE"
    else
        mv "$OLD_IMAGE" "$NEW_IMAGE"
    fi
else
    log "Warning: No image found at $OLD_IMAGE"
fi

# Step 5: Update seed files
log "Step 5: Updating seed files..."
update_seed "$ARTICLE" "$NEW_MDX" "$OLD_DATE" "$DEST_DATE"

# Output summary
cat << EOF

=== Move Complete ===

Article: $SLUG
  Date: $OLD_DATE -> $DEST_DATE
  MDX:  $NEW_MDX

Next steps:
  1. npm run build (verify build)
  2. Update Zernio API schedules if needed
EOF

if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    echo "=== DRY RUN - No changes made ==="
fi
