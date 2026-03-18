#!/bin/bash
#
# swap-dates.sh - 2つのブログ記事の投稿日を入れ替え
# Usage: swap-dates.sh <article1_path> <article2_path> [--dry-run]
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
CONFIG=$(load_skill_config "blog-swap-dates")
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
ARTICLE1=""
ARTICLE2=""

usage() {
    cat << 'EOF'
Usage: swap-dates.sh <article1_path> <article2_path> [--dry-run]

Arguments:
  article1_path  1つ目の記事のMDXファイルパス
  article2_path  2つ目の記事のMDXファイルパス
  --dry-run      変更内容を表示するのみ（実行しない）

Examples:
  swap-dates.sh content/blog/2026-02-03-foo.mdx content/blog/2026-03-19-bar.mdx
  swap-dates.sh content/blog/2026-02-03-foo.mdx content/blog/2026-03-19-bar.mdx --dry-run
EOF
    exit "${1:-0}"
}

log() {
    echo "[swap-dates] $*" >&2
}

# Extract date and slug from MDX path
parse_mdx_path() {
    local path="$1"
    local filename=$(basename "$path" .mdx)
    local date=$(echo "$filename" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
    local slug=$(echo "$filename" | sed 's/^[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}-//')
    echo "$date $slug"
}

# Safe file rename with collision avoidance
safe_rename_files() {
    local file1="$1"
    local file2="$2"
    local new_name1="$3"
    local new_name2="$4"

    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] mv $file1 -> $new_name1"
        log "[DRY-RUN] mv $file2 -> $new_name2"
        return
    fi

    # Use temp files to avoid collision when dates overlap in naming
    local temp1=$(mktemp)
    local temp2=$(mktemp)
    mv "$file1" "$temp1"
    mv "$file2" "$temp2"
    mv "$temp1" "$new_name1"
    mv "$temp2" "$new_name2"
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
    local new_date="$3"

    # Convert to relative path for searching in seed files
    local old_relative="${old_path#$PROJECT_ROOT/}"
    local new_relative="${new_path#$PROJECT_ROOT/}"

    local seed_abs="$PROJECT_ROOT/$SEED_DIR"

    # Find seed files containing this article (search by relative path)
    local seed_files=$(grep -rl "$old_relative" "$seed_abs" 2>/dev/null || true)

    for seed_file in $seed_files; do
        if [[ -z "$seed_file" ]]; then continue; fi

        # Extract old date from old path
        local old_date
        old_date=$(basename "$old_path" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}')

        if [[ "$DRY_RUN" == "true" ]]; then
            log "[DRY-RUN] Update $seed_file: path=$new_relative, date ${old_date} -> ${new_date} (preserving time)"
            continue
        fi

        # Update path (use relative paths)
        "${SED_INPLACE[@]}" "s|$old_relative|$new_relative|g" "$seed_file"

        # Update createdAt date portion only (preserve original time: T##:##:##Z)
        "${SED_INPLACE[@]}" "s|\"createdAt\": \"${old_date}T|\"createdAt\": \"${new_date}T|g" "$seed_file"

        log "Updated seed: $seed_file"
    done
}

# Update post/blog/*.json
update_sns_posts() {
    local old_date="$1"
    local new_date="$2"
    local slug="$3"

    local sns_abs="$PROJECT_ROOT/$SNS_POST_DIR"
    local old_post="$sns_abs/${old_date}-${slug}.json"

    if [[ ! -f "$old_post" ]]; then
        log "No SNS post file: $old_post (skipping)"
        return
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] Update schedule dates: $old_date -> $new_date"
        return
    fi

    # Update schedule dates in content
    "${SED_INPLACE[@]}" "s|\"schedule\": \"${old_date}|\"schedule\": \"${new_date}|g" "$old_post"

    log "Updated SNS post: $old_post"
}

# Swap SNS post files
swap_sns_posts() {
    local date1="$1"
    local date2="$2"
    local slug1="$3"
    local slug2="$4"

    local sns_abs="$PROJECT_ROOT/$SNS_POST_DIR"
    local post1="$sns_abs/${date1}-${slug1}.json"
    local post2="$sns_abs/${date2}-${slug2}.json"
    local new_post1="$sns_abs/${date2}-${slug1}.json"
    local new_post2="$sns_abs/${date1}-${slug2}.json"

    local has_post1=false
    local has_post2=false
    [[ -f "$post1" ]] && has_post1=true
    [[ -f "$post2" ]] && has_post2=true

    if [[ "$has_post1" == "true" && "$has_post2" == "true" ]]; then
        safe_rename_files "$post1" "$post2" "$new_post1" "$new_post2"
    elif [[ "$has_post1" == "true" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "[DRY-RUN] mv $post1 -> $new_post1"
        else
            mv "$post1" "$new_post1"
        fi
    elif [[ "$has_post2" == "true" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "[DRY-RUN] mv $post2 -> $new_post2"
        else
            mv "$post2" "$new_post2"
        fi
    fi
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
            if [[ -z "$ARTICLE1" ]]; then
                ARTICLE1="$1"
            elif [[ -z "$ARTICLE2" ]]; then
                ARTICLE2="$1"
            else
                echo "Error: Too many arguments" >&2
                usage 1
            fi
            shift
            ;;
    esac
done

# Validate arguments
if [[ -z "$ARTICLE1" || -z "$ARTICLE2" ]]; then
    echo "Error: Two article paths required" >&2
    usage 1
fi

# Resolve to absolute paths
[[ "$ARTICLE1" != /* ]] && ARTICLE1="$PROJECT_ROOT/$ARTICLE1"
[[ "$ARTICLE2" != /* ]] && ARTICLE2="$PROJECT_ROOT/$ARTICLE2"

if [[ ! -f "$ARTICLE1" ]]; then
    echo "Error: Article not found: $ARTICLE1" >&2
    exit 1
fi

if [[ ! -f "$ARTICLE2" ]]; then
    echo "Error: Article not found: $ARTICLE2" >&2
    exit 1
fi

# Parse article info
read DATE1 SLUG1 <<< $(parse_mdx_path "$ARTICLE1")
read DATE2 SLUG2 <<< $(parse_mdx_path "$ARTICLE2")

# Check if dates are the same (no-op)
if [[ "$DATE1" == "$DATE2" ]]; then
    echo "Error: Both articles have the same date ($DATE1). Nothing to swap." >&2
    exit 0
fi

log "Article 1: $DATE1 / $SLUG1"
log "Article 2: $DATE2 / $SLUG2"
log "Swapping dates: $DATE1 <-> $DATE2"
[[ "$DRY_RUN" == "true" ]] && log "=== DRY RUN MODE ==="

# Calculate new paths
BLOG_DIR="$PROJECT_ROOT/$CONTENT_DIR"
NEW_MDX1="$BLOG_DIR/${DATE2}-${SLUG1}.mdx"
NEW_MDX2="$BLOG_DIR/${DATE1}-${SLUG2}.mdx"

IMG_ABS="$PROJECT_ROOT/$IMAGE_DIR"
IMAGE1="$IMG_ABS/${DATE1}-${SLUG1}${IMAGE_EXT}"
IMAGE2="$IMG_ABS/${DATE2}-${SLUG2}${IMAGE_EXT}"
NEW_IMAGE1="$IMG_ABS/${DATE2}-${SLUG1}${IMAGE_EXT}"
NEW_IMAGE2="$IMG_ABS/${DATE1}-${SLUG2}${IMAGE_EXT}"

# Step 1: Update SNS post schedules (before renaming)
log "Step 1: Updating SNS post schedules..."
update_sns_posts "$DATE1" "$DATE2" "$SLUG1"
update_sns_posts "$DATE2" "$DATE1" "$SLUG2"

# Step 2: Swap MDX files
log "Step 2: Swapping MDX files..."
safe_rename_files "$ARTICLE1" "$ARTICLE2" "$NEW_MDX1" "$NEW_MDX2"

# Step 3: Update frontmatter
log "Step 3: Updating frontmatter..."
update_frontmatter "$NEW_MDX2" "$DATE1" "$DATE2" "$SLUG2"  # Article2 now has DATE1
update_frontmatter "$NEW_MDX1" "$DATE2" "$DATE1" "$SLUG1"  # Article1 now has DATE2

# Step 4: Swap images
log "Step 4: Swapping images..."
if [[ -f "$IMAGE1" && -f "$IMAGE2" ]]; then
    safe_rename_files "$IMAGE1" "$IMAGE2" "$NEW_IMAGE1" "$NEW_IMAGE2"
elif [[ -f "$IMAGE1" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] mv $IMAGE1 -> $NEW_IMAGE1"
    else
        mv "$IMAGE1" "$NEW_IMAGE1"
    fi
elif [[ -f "$IMAGE2" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
        log "[DRY-RUN] mv $IMAGE2 -> $NEW_IMAGE2"
    else
        mv "$IMAGE2" "$NEW_IMAGE2"
    fi
else
    log "Warning: No images found"
fi

# Step 5: Update seed files
log "Step 5: Updating seed files..."
update_seed "$ARTICLE1" "$NEW_MDX1" "$DATE2"
update_seed "$ARTICLE2" "$NEW_MDX2" "$DATE1"

# Step 6: Swap SNS post files
log "Step 6: Swapping SNS post files..."
swap_sns_posts "$DATE1" "$DATE2" "$SLUG1" "$SLUG2"

# Output summary
cat << EOF

=== Swap Complete ===

Article 1: $SLUG1
  Date: $DATE1 -> $DATE2
  MDX:  $NEW_MDX1

Article 2: $SLUG2
  Date: $DATE2 -> $DATE1
  MDX:  $NEW_MDX2

Next steps:
  1. npm run build (verify build)
  2. Update Zernio API schedules if needed
EOF

if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    echo "=== DRY RUN - No changes made ==="
fi
