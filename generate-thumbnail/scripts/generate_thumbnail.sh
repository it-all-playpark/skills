#!/bin/bash
#
# Generate blog thumbnail using Gemini API, optionally optimize to WebP.
# Usage: generate_thumbnail.sh <mdx-path> [--optimize]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source common utilities
source "$SKILLS_DIR/_lib/common.sh"

# Load config
CONFIG=$(load_skill_config "generate-thumbnail")
OUTPUT_DIR=$(echo "$CONFIG" | jq -r '.output_dir // "public/blog"')

PROJECT_ROOT="$(git_root)"
OUTPUT_ABS="$PROJECT_ROOT/$OUTPUT_DIR"

usage() {
    cat << 'EOF'
Usage: generate_thumbnail.sh <mdx-path> [--optimize]

Generate blog thumbnail from MDX frontmatter using Gemini API.

Arguments:
  <mdx-path>    Path to MDX file (e.g., content/blog/2026-01-20-example.mdx)
  --optimize    Convert to WebP and delete original PNG after generation

Examples:
  generate_thumbnail.sh content/blog/2026-01-20-example.mdx
  generate_thumbnail.sh content/blog/2026-01-20-example.mdx --optimize
EOF
    exit "${1:-0}"
}

# Parse arguments
MDX_PATH=""
OPTIMIZE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --optimize)
            OPTIMIZE=true
            shift
            ;;
        -h|--help)
            usage 0
            ;;
        -*)
            echo "Error: Unknown option: $1" >&2
            usage 1
            ;;
        *)
            if [[ -z "$MDX_PATH" ]]; then
                MDX_PATH="$1"
            else
                echo "Error: Unexpected argument: $1" >&2
                usage 1
            fi
            shift
            ;;
    esac
done

# Validate input
if [[ -z "$MDX_PATH" ]]; then
    echo "Error: MDX path required" >&2
    usage 1
fi

if [[ ! -f "$MDX_PATH" ]]; then
    echo "Error: File not found: $MDX_PATH" >&2
    exit 1
fi

if [[ ! "$MDX_PATH" == *.mdx ]]; then
    echo "Error: File must be .mdx format: $MDX_PATH" >&2
    exit 1
fi

# Extract basename for output path
BASENAME=$(basename "$MDX_PATH" .mdx)
PNG_PATH="$OUTPUT_ABS/${BASENAME}.png"
WEBP_PATH="$OUTPUT_ABS/${BASENAME}.webp"

# Step 1: Generate thumbnail via TypeScript
echo "🎨 Generating thumbnail..."
NODE_PATH="$PROJECT_ROOT/node_modules" npx tsx "$SCRIPT_DIR/generate_thumbnail.ts" "$MDX_PATH"

# Step 2: Optimize if requested
if [[ "$OPTIMIZE" == true ]]; then
    echo "🔄 Converting to WebP..."
    vips webpsave "$PNG_PATH" "$WEBP_PATH" --Q 85

    echo "🗑️  Deleting original PNG..."
    rip "$PNG_PATH"

    echo ""
    echo "✅ Thumbnail Generated & Optimized"
    echo ""
    echo "📷 Image:"
    echo "   $WEBP_PATH"
    echo ""
    echo "🔗 Ready for publish"
else
    echo ""
    echo "✅ Thumbnail Generated"
    echo ""
    echo "📷 Image:"
    echo "   $PNG_PATH"
    echo ""
    echo "💡 Next step:"
    echo "   vips webpsave $PNG_PATH ${PNG_PATH%.png}.webp --Q 85"
fi
