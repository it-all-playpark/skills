#!/usr/bin/env bash
#
# unlink-agent-skills.sh
# link-agent-skills.sh の逆操作。
# 全外部スキル symlink を削除し、.gitignore の managed セクションもクリーンアップする。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GITIGNORE="$REPO_ROOT/.gitignore"

MARKER_BEGIN="# --- external skills (auto-managed) ---"
MARKER_END="# --- end external skills ---"

# --- helpers ---

get_managed_entries() {
  if ! grep -qF "$MARKER_BEGIN" "$GITIGNORE" 2>/dev/null; then
    return
  fi
  awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" \
    '$0 == begin { found=1; next } $0 == end { found=0; next } found && /^[^#]/ && NF { print }' \
    "$GITIGNORE"
}

remove_managed_section() {
  if ! grep -qF "$MARKER_BEGIN" "$GITIGNORE" 2>/dev/null; then
    return
  fi
  awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" \
    '$0 == begin { skip=1; next } $0 == end { skip=0; next } !skip { print }' \
    "$GITIGNORE" > "$GITIGNORE.tmp"
  mv "$GITIGNORE.tmp" "$GITIGNORE"
  # 末尾の空行を除去（sed -i のOS差異を回避するポータブル実装）
  if [[ -s "$GITIGNORE" ]]; then
    local content
    content="$(cat "$GITIGNORE")"
    printf '%s\n' "$content" > "$GITIGNORE"
  fi
}

# --- main ---

removed=0
while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue
  link="$REPO_ROOT/$entry"
  if [[ -L "$link" ]]; then
    rm "$link"
    echo "removed: $link"
    removed=$((removed + 1))
  fi
done < <(get_managed_entries)

remove_managed_section

echo "done: $removed symlink(s) removed. .gitignore section cleaned."
