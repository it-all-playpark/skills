#!/bin/bash
# Zenn Publish Script
# Usage: publish.sh <file-path> [--slug <slug>]
# Publishes article as draft via GitHub integration, or falls back to clipboard

set -e

# Load .env from skill directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$SKILL_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

FILE_PATH=""
SLUG=""

# Parse arguments
while [ $# -gt 0 ]; do
  case $1 in
    --slug)
      SLUG="$2"
      shift 2
      ;;
    *)
      if [ -z "$FILE_PATH" ]; then
        FILE_PATH="$1"
      fi
      shift
      ;;
  esac
done

# Validation
if [ -z "$FILE_PATH" ]; then
  echo '{"status": "error", "message": "File path required"}' >&2
  exit 1
fi

if [ ! -f "$FILE_PATH" ]; then
  echo '{"status": "error", "message": "File not found: '"$FILE_PATH"'"}' >&2
  exit 1
fi

# Generate slug from filename if not provided
if [ -z "$SLUG" ]; then
  SLUG=$(basename "$FILE_PATH" .md | head -c 50)
fi

# Ensure published: false in frontmatter
CONTENT=$(cat "$FILE_PATH")
if echo "$CONTENT" | grep -q "^published: true"; then
  CONTENT=$(echo "$CONTENT" | sed 's/^published: true/published: false/')
fi

# ---- GitHub Integration Mode ----
if [ -n "$ZENN_REPO_PATH" ] && [ -d "$ZENN_REPO_PATH" ]; then
  ARTICLES_DIR="$ZENN_REPO_PATH/articles"

  if [ ! -d "$ARTICLES_DIR" ]; then
    echo '{"status": "error", "message": "articles/ directory not found in ZENN_REPO_PATH: '"$ZENN_REPO_PATH"'"}' >&2
    exit 1
  fi

  # Write article file
  DEST="$ARTICLES_DIR/${SLUG}.md"
  echo "$CONTENT" > "$DEST"

  # Git add, commit, push
  cd "$ZENN_REPO_PATH"
  git add "articles/${SLUG}.md"
  git commit -m "feat: add draft article ${SLUG}" 2>/dev/null || {
    echo '{"status": "error", "message": "Git commit failed. File may already exist with same content."}' >&2
    exit 1
  }
  git push origin main 2>/dev/null || git push origin master 2>/dev/null || {
    echo '{"status": "error", "message": "Git push failed. Check remote configuration."}' >&2
    exit 1
  }

  echo "{"
  echo "  \"status\": \"success\","
  echo "  \"mode\": \"github\","
  echo "  \"file\": \"articles/${SLUG}.md\","
  echo "  \"published\": false,"
  echo "  \"message\": \"Draft pushed to Zenn repo. Zenn will auto-sync as draft.\""
  echo "}"

# ---- Fallback: Clipboard Mode ----
else
  echo "$CONTENT" | pbcopy
  open "https://zenn.dev/dashboard"

  echo "{"
  echo "  \"status\": \"success\","
  echo "  \"mode\": \"clipboard\","
  echo "  \"published\": false,"
  echo "  \"message\": \"Content copied to clipboard (published: false). Zenn editor opened. Paste with Cmd+V.\","
  echo "  \"hint\": \"Set ZENN_REPO_PATH in .env for auto-draft via GitHub integration.\""
  echo "}"
fi
