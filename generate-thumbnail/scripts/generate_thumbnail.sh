#!/bin/bash
#
# Generate blog thumbnail via Codex CLI built-in image_gen (gpt-image-2).
# Usage: generate_thumbnail.sh <mdx-path> [--optimize]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$SKILLS_DIR/_lib/common.sh"

require_cmds codex jq python3

CONFIG=$(load_skill_config "generate-thumbnail")
OUTPUT_DIR=$(echo "$CONFIG" | jq -r '.output_dir // "public/blog"')
ASPECT_RATIO=$(echo "$CONFIG" | jq -r '.aspect_ratio // "16:9"')
BRAND_PROMPT_PATH=$(echo "$CONFIG" | jq -r '.brand_prompt_path // ""')
CODEX_MODEL=$(echo "$CONFIG" | jq -r '.codex_model // "gpt-5.4-mini"')
CODEX_EFFORT=$(echo "$CONFIG" | jq -r '.codex_reasoning_effort // "low"')

PROJECT_ROOT="$(git_root)"
[[ -n "$PROJECT_ROOT" ]] || die_json "Not in a git repository" 128
OUTPUT_ABS="$PROJECT_ROOT/$OUTPUT_DIR"

usage() {
    cat << 'EOF'
Usage: generate_thumbnail.sh <mdx-path> [--optimize]

Generate blog thumbnail from MDX frontmatter via Codex CLI (gpt-image-2).
No API key required — uses Codex subscription quota.

Arguments:
  <mdx-path>    Path to MDX file (e.g., content/blog/2026-01-20-example.mdx)
  --optimize    Convert to WebP and delete original PNG after generation

Examples:
  generate_thumbnail.sh content/blog/2026-01-20-example.mdx
  generate_thumbnail.sh content/blog/2026-01-20-example.mdx --optimize
EOF
    exit "${1:-0}"
}

MDX_PATH=""
OPTIMIZE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --optimize) OPTIMIZE=true; shift ;;
        -h|--help) usage 0 ;;
        -*) err "Unknown option: $1"; usage 1 ;;
        *)
            if [[ -z "$MDX_PATH" ]]; then MDX_PATH="$1"
            else err "Unexpected argument: $1"; usage 1
            fi
            shift
            ;;
    esac
done

[[ -n "$MDX_PATH" ]] || { err "MDX path required"; usage 1; }
[[ -f "$MDX_PATH" ]] || die_json "File not found: $MDX_PATH" 1
[[ "$MDX_PATH" == *.mdx ]] || die_json "File must be .mdx format: $MDX_PATH" 1

# ----------------------------------------------------------------------------
# Resolve brand prompt
# ----------------------------------------------------------------------------
resolve_brand_prompt() {
    if [[ -n "$BRAND_PROMPT_PATH" ]]; then
        local p="$BRAND_PROMPT_PATH"
        [[ "$p" = /* ]] || p="$PROJECT_ROOT/$p"
        if [[ -f "$p" ]]; then
            cat "$p"
            return
        fi
        warn "Brand prompt not found: $p, falling back to default"
    fi
    cat "$SKILLS_DIR/generate-thumbnail/prompts/default-brand-prompt.md"
}

BRAND_PROMPT="$(resolve_brand_prompt)"

# ----------------------------------------------------------------------------
# Parse MDX frontmatter via Python (PyYAML not required — manual parse)
# ----------------------------------------------------------------------------
FRONTMATTER_JSON=$(python3 - "$MDX_PATH" << 'PY'
import json, re, sys

path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    text = f.read()

m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
data = {}
if m:
    block = m.group(1)
    # naive YAML: key: value, supports quoted strings and inline arrays
    for line in block.splitlines():
        line = line.rstrip()
        if not line or line.startswith("#"):
            continue
        mm = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", line)
        if not mm:
            continue
        key, val = mm.group(1), mm.group(2).strip()
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1]
            items = [x.strip().strip("'\"") for x in inner.split(",") if x.strip()]
            data[key] = items
        else:
            v = val.strip("'\"")
            if v:
                data[key] = v
print(json.dumps(data, ensure_ascii=False))
PY
)

TITLE=$(echo "$FRONTMATTER_JSON" | jq -r '.title // "Untitled"')
DESCRIPTION=$(echo "$FRONTMATTER_JSON" | jq -r '.description // empty')
CATEGORY=$(echo "$FRONTMATTER_JSON" | jq -r '.category // empty')
TAGS=$(echo "$FRONTMATTER_JSON" | jq -r '(.tags // []) | join(", ")')

BASENAME=$(basename "$MDX_PATH" .mdx)
PNG_PATH="$OUTPUT_ABS/${BASENAME}.png"
WEBP_PATH="$OUTPUT_ABS/${BASENAME}.webp"
mkdir -p "$OUTPUT_ABS"

# ----------------------------------------------------------------------------
# Build prompt for Codex
# ----------------------------------------------------------------------------
PROMPT=$(cat << EOF
あなたはブログ記事のサムネイル生成エージェントです。以下のブランドガイドラインと記事情報を踏まえ、built-in image_gen ツールでサムネイル画像を1枚生成し、指定パスにコピーしてください。

# ブランドガイドライン

$BRAND_PROMPT

# 記事情報

- タイトル: $TITLE
$([[ -n "$DESCRIPTION" ]] && echo "- 概要: $DESCRIPTION")
$([[ -n "$CATEGORY" ]] && echo "- カテゴリ: $CATEGORY")
$([[ -n "$TAGS" ]] && echo "- タグ: $TAGS")

# 制約

- アスペクト比は ${ASPECT_RATIO}（横長）
- image_gen の呼び出しは1回のみ。再生成・iteration は不要
- 生成後、画像を以下の絶対パスにコピーしてください（既存ファイルは上書き可）:
  $PNG_PATH
- コピー後、最終出力として保存先パスのみを1行で報告してください
EOF
)

# ----------------------------------------------------------------------------
# Run codex exec
# ----------------------------------------------------------------------------
echo "🎨 Generating thumbnail via Codex (gpt-image-2)..."
echo "   Title: $TITLE"
echo "   Output: $PNG_PATH"

LOG_FILE="$(mktemp -t codex-thumb.XXXXXX.log)"
trap 'rm -f "$LOG_FILE"' EXIT

if ! codex exec \
    --skip-git-repo-check \
    --full-auto \
    -m "$CODEX_MODEL" \
    -c "model_reasoning_effort=$CODEX_EFFORT" \
    --json \
    "$PROMPT" > "$LOG_FILE" 2>&1; then
    err "codex exec failed (exit=$?). Last 30 lines of log:"
    tail -n 30 "$LOG_FILE" >&2
    exit 1
fi

# ----------------------------------------------------------------------------
# Verify output
# ----------------------------------------------------------------------------
if [[ ! -f "$PNG_PATH" ]]; then
    err "Codex completed but output file not found: $PNG_PATH"
    err "Last 30 lines of log:"
    tail -n 30 "$LOG_FILE" >&2
    exit 1
fi

if ! file "$PNG_PATH" | grep -q "PNG image"; then
    err "Output is not a PNG: $(file "$PNG_PATH")"
    exit 1
fi

# ----------------------------------------------------------------------------
# Optional WebP optimization
# ----------------------------------------------------------------------------
if [[ "$OPTIMIZE" == true ]]; then
    require_cmd vips "vips not installed. Install: brew install vips"
    require_cmd rip
    echo "🔄 Converting to WebP..."
    vips webpsave "$PNG_PATH" "$WEBP_PATH" --Q 85
    echo "🗑️  Deleting original PNG..."
    rip "$PNG_PATH"

    echo ""
    echo "✅ Thumbnail Generated & Optimized"
    echo "📷 $WEBP_PATH"
else
    echo ""
    echo "✅ Thumbnail Generated"
    echo "📷 $PNG_PATH"
    echo ""
    echo "💡 Next: vips webpsave $PNG_PATH ${PNG_PATH%.png}.webp --Q 85"
fi
