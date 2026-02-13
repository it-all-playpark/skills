#!/usr/bin/env bash
#
# link-agent-skills.sh
# .agents/skills/ 配下の外部スキルを repo root にsymlink し、
# .gitignore で管理することで git status を汚さないようにする。
#
# 冪等: 何度実行しても同じ結果になる。
# 不要になった stale symlink も自動クリーンアップする。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_SKILLS_DIR="$REPO_ROOT/.agents/skills"
GITIGNORE="$REPO_ROOT/.gitignore"

MARKER_BEGIN="# --- external skills (auto-managed) ---"
MARKER_END="# --- end external skills ---"

# --- helpers ---

# .gitignore のマーカーセクション内のエントリを配列で返す
get_managed_entries() {
  if ! grep -qF "$MARKER_BEGIN" "$GITIGNORE" 2>/dev/null; then
    return
  fi
  awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" \
    '$0 == begin { found=1; next } $0 == end { found=0; next } found && /^[^#]/ && NF { print }' \
    "$GITIGNORE"
}

# .gitignore のマーカーセクションを新しい内容で置換（なければ追記）
write_managed_section() {
  local entries=("$@")

  # 既存セクションを除去（awk で安全に処理）
  if grep -qF "$MARKER_BEGIN" "$GITIGNORE" 2>/dev/null; then
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
  fi

  # エントリがなければセクション自体を書かない
  if [[ ${#entries[@]} -eq 0 ]]; then
    return
  fi

  # 末尾に改行を確保してからセクションを追記
  if [[ -s "$GITIGNORE" ]] && [[ "$(tail -c1 "$GITIGNORE")" != "" ]]; then
    echo "" >> "$GITIGNORE"
  fi
  {
    echo ""
    echo "$MARKER_BEGIN"
    printf '%s\n' "${entries[@]}"
    echo "$MARKER_END"
  } >> "$GITIGNORE"
}

# --- main ---

if [[ ! -d "$AGENTS_SKILLS_DIR" ]]; then
  echo "info: $AGENTS_SKILLS_DIR が存在しません。処理をスキップします。"
  exit 0
fi

# 1. .agents/skills/ 配下のディレクトリを収集
desired=()
for skill_dir in "$AGENTS_SKILLS_DIR"/*/; do
  [[ -d "$skill_dir" ]] || continue
  name="$(basename "$skill_dir")"
  desired+=("$name")
done

if [[ ${#desired[@]} -eq 0 ]]; then
  echo "info: .agents/skills/ にスキルが見つかりません。"
fi

# 2. 必要な symlink を作成
created=()
for name in "${desired[@]}"; do
  target="$AGENTS_SKILLS_DIR/$name"
  link="$REPO_ROOT/$name"

  if [[ -L "$link" ]]; then
    # 既存 symlink のリンク先を確認
    current_target="$(readlink "$link")"
    expected=".agents/skills/$name"
    if [[ "$current_target" == "$expected" || "$current_target" == "$target" ]]; then
      created+=("$name")
      continue
    fi
    echo "warn: $link は別のリンク先を指しています ($current_target)。スキップします。"
    continue
  elif [[ -e "$link" ]]; then
    echo "warn: $link が既に存在します（symlink ではありません）。スキップします。"
    continue
  fi

  # 相対パスで symlink を作成
  ln -s ".agents/skills/$name" "$link"
  echo "created: $link -> .agents/skills/$name"
  created+=("$name")
done

# 3. stale symlink のクリーンアップ
#    以前の managed entries のうち、desired に含まれないものを削除
while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue
  link="$REPO_ROOT/$entry"
  if [[ -L "$link" ]]; then
    # desired に含まれるか確認
    is_desired=false
    for name in "${desired[@]}"; do
      if [[ "$name" == "$entry" ]]; then
        is_desired=true
        break
      fi
    done
    if [[ "$is_desired" == false ]]; then
      rm "$link"
      echo "removed stale: $link"
    fi
  fi
done < <(get_managed_entries)

# 4. .gitignore の managed セクションを更新
write_managed_section "${created[@]}"

echo "done: ${#created[@]} skill(s) linked."
