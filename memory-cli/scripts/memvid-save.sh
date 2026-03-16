#!/usr/bin/env bash
set -euo pipefail

# memvid-save.sh - Wrapper ensuring put→commit pattern is always followed
# Usage: memvid-save.sh --target global|project --title "TITLE" --content "CONTENT" [--type TYPE] [--tags "k=v,..."] [--uri URI]
# Output: JSON with save result

source "$(dirname "$0")/../../_lib/common.sh"

# ============================================================================
# Defaults & Args
# ============================================================================

TARGET=""
TITLE=""
CONTENT=""
TYPE="reference"
EXTRA_TAGS=""
URI=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)  TARGET="$2"; shift 2 ;;
    --title)   TITLE="$2"; shift 2 ;;
    --content) CONTENT="$2"; shift 2 ;;
    --type)    TYPE="$2"; shift 2 ;;
    --tags)    EXTRA_TAGS="$2"; shift 2 ;;
    --uri)     URI="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: memvid-save.sh --target global|project --title \"TITLE\" --content \"CONTENT\" [--type TYPE] [--tags \"k=v,...\"] [--uri URI]"
      exit 0
      ;;
    *) die_json "Unknown argument: $1" 1 ;;
  esac
done

# ============================================================================
# Validation
# ============================================================================

[[ -z "$TARGET" ]] && die_json "--target is required (global|project)" 1
[[ -z "$TITLE" ]]  && die_json "--title is required" 1
[[ -z "$CONTENT" ]] && die_json "--content is required" 1
[[ "$TARGET" != "global" && "$TARGET" != "project" ]] && die_json "--target must be 'global' or 'project'" 1

require_cmd "memvid" "memvid CLI is required. Install from: https://github.com/memvid/memvid"

# ============================================================================
# Resolve target file
# ============================================================================

GLOBAL_MV2="${HOME}/.claude/memory/global.mv2"

if [[ "$TARGET" == "global" ]]; then
  TARGET_FILE="$GLOBAL_MV2"
else
  # Project target: resolve from git root
  GIT_ROOT=$(git_root)
  if [[ -z "$GIT_ROOT" ]]; then
    warn "Not in a git repository, falling back to global target"
    TARGET_FILE="$GLOBAL_MV2"
    TARGET="global"
  else
    TARGET_FILE="${GIT_ROOT}/.claude/memory/project.mv2"
    if [[ ! -f "$TARGET_FILE" ]]; then
      mkdir -p "$(dirname "$TARGET_FILE")"
      if ! memvid create "$TARGET_FILE" 2>/dev/null; then
        die_json "Failed to create project memory at ${TARGET_FILE}" 1
      fi
      warn "Created project memory at ${TARGET_FILE}"
    fi
  fi
fi

if [[ ! -f "$TARGET_FILE" ]]; then
  die_json "Target memory file not found: ${TARGET_FILE}" 1
fi

# ============================================================================
# Auto-generate project tag
# ============================================================================

PROJECT_TAG=""
GIT_ROOT=$(git_root)
if [[ -n "$GIT_ROOT" ]]; then
  PROJECT_TAG=$(basename "$GIT_ROOT")
fi

# ============================================================================
# Create tmpfile and write content
# ============================================================================

TMPFILE=$(mktemp /tmp/memory-XXXXXX.md)

# Ensure cleanup on exit
cleanup() {
  if [[ -f "$TMPFILE" ]]; then
    if command -v rip &>/dev/null; then
      rip "$TMPFILE" 2>/dev/null || true
    else
      rm -f "$TMPFILE" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT

printf '%s' "$CONTENT" > "$TMPFILE"

# ============================================================================
# Build memvid put command
# ============================================================================

PUT_ARGS=( put "$TARGET_FILE" --input "$TMPFILE" --embedding --title "$TITLE" )
PUT_ARGS+=( --tag "type=$TYPE" )

if [[ -n "$PROJECT_TAG" ]]; then
  PUT_ARGS+=( --tag "project=$PROJECT_TAG" )
fi

# Parse extra tags (comma-separated k=v pairs)
if [[ -n "$EXTRA_TAGS" ]]; then
  IFS=',' read -ra TAG_PAIRS <<< "$EXTRA_TAGS"
  for pair in "${TAG_PAIRS[@]}"; do
    pair=$(echo "$pair" | xargs)  # trim whitespace
    [[ -n "$pair" ]] && PUT_ARGS+=( --tag "$pair" )
  done
fi

if [[ -n "$URI" ]]; then
  PUT_ARGS+=( --uri "$URI" )
fi

# ============================================================================
# Execute: put (memvid V2 persists directly, no separate commit needed)
# ============================================================================

if ! memvid "${PUT_ARGS[@]}" 2>/dev/null; then
  die_json "memvid put failed for ${TARGET_FILE}" 1
fi

# ============================================================================
# Output
# ============================================================================

if has_jq; then
  jq -n \
    --arg status "saved" \
    --arg target "$TARGET_FILE" \
    --arg title "$TITLE" \
    --arg type "$TYPE" \
    '{status: $status, target: $target, title: $title, type: $type}'
else
  echo "{\"status\":\"saved\",\"target\":$(json_str "$TARGET_FILE"),\"title\":$(json_str "$TITLE"),\"type\":$(json_str "$TYPE")}"
fi
