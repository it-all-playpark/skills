#!/usr/bin/env bash
# save-session.sh - Save session context to memvid
# Usage: save-session.sh --title "TITLE" --content "CONTENT" [--target global|project] [--type session|project|feedback] [--tags "k=v,..."]
#
# Output: JSON with save result

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd memvid "memvid CLI not found. Install: cargo install memvid-cli"

# ============================================================================
# Args
# ============================================================================

TITLE=""
CONTENT=""
TARGET="global"
TYPE="session"
EXTRA_TAGS=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --title)   TITLE="$2";   shift 2 ;;
        --content) CONTENT="$2"; shift 2 ;;
        --target)  TARGET="$2";  shift 2 ;;
        --type)    TYPE="$2";    shift 2 ;;
        --tags)    EXTRA_TAGS="$2"; shift 2 ;;
        -h|--help)
            echo 'Usage: save-session.sh --title "TITLE" --content "CONTENT" [--target global|project] [--type session|project|feedback] [--tags "k=v,..."]'
            exit 0
            ;;
        *) shift ;;
    esac
done

if [[ -z "$TITLE" ]]; then
    die_json "--title is required" 1
fi
if [[ -z "$CONTENT" ]]; then
    die_json "--content is required" 1
fi

# ============================================================================
# Resolve target file
# ============================================================================

TARGET_FILE=""
case "$TARGET" in
    project)
        GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die_json "Not in a git repo; cannot use --target project" 1
        TARGET_FILE="$GIT_ROOT/.claude/memory/project.mv2"
        if [[ ! -f "$TARGET_FILE" ]]; then
            warn "Project memory file not found: $TARGET_FILE — falling back to global"
            TARGET="global"
            TARGET_FILE="$HOME/.claude/memory/global.mv2"
        fi
        ;;
    global)
        TARGET_FILE="$HOME/.claude/memory/global.mv2"
        ;;
    *)
        die_json "Unknown target: $TARGET (expected: global|project)" 1
        ;;
esac

if [[ ! -f "$TARGET_FILE" ]]; then
    die_json "Memory file not found: $TARGET_FILE" 1
fi

# ============================================================================
# Auto-generate tags
# ============================================================================

PROJECT=""
if GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    PROJECT="$(basename "$GIT_ROOT")"
fi

DATE="$(date +%Y-%m-%d)"
# Generate slug from title: lowercase, spaces to hyphens, strip non-alnum
SLUG="$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9 ]//g' | tr ' ' '-' | sed 's/--*/-/g; s/^-//; s/-$//' | cut -c1-60)"

# ============================================================================
# Write content to tmpfile
# ============================================================================

TMPFILE="$(mktemp /tmp/session-XXXXXX.md)"

# Ensure cleanup on exit
cleanup() {
    if [[ -f "$TMPFILE" ]]; then
        if command -v rip &>/dev/null; then
            rip "$TMPFILE" 2>/dev/null || rm -f "$TMPFILE"
        else
            rm -f "$TMPFILE"
        fi
    fi
}
trap cleanup EXIT

printf '%s' "$CONTENT" > "$TMPFILE"

# ============================================================================
# Build memvid put command
# ============================================================================

CMD=(memvid put "$TARGET_FILE"
    --input "$TMPFILE"
    --embedding
    --title "$TITLE"
    --tag "type=$TYPE"
    --uri "$TYPE/$DATE/$SLUG"
)

# Add project tag if available
if [[ -n "$PROJECT" ]]; then
    CMD+=(--tag "project=$PROJECT")
fi

# Add extra tags (comma-separated k=v pairs)
if [[ -n "$EXTRA_TAGS" ]]; then
    IFS=',' read -ra TAG_PAIRS <<< "$EXTRA_TAGS"
    for pair in "${TAG_PAIRS[@]}"; do
        pair="$(echo "$pair" | xargs)"  # trim whitespace
        [[ -n "$pair" ]] && CMD+=(--tag "$pair")
    done
fi

# ============================================================================
# Execute
# ============================================================================

"${CMD[@]}" 2>/dev/null || die_json "memvid put failed" 1
memvid commit "$TARGET_FILE" 2>/dev/null || die_json "memvid commit failed" 1

# ============================================================================
# Output JSON
# ============================================================================

cat <<EOF
{
  "status": "saved",
  "target": $(json_str "$TARGET_FILE"),
  "title": $(json_str "$TITLE"),
  "type": $(json_str "$TYPE")
}
EOF
