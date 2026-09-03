#!/usr/bin/env bash
#
# link-agent-skills.sh
# plugins/playpark-skills/.agents/skills/ 配下の外部スキルを
# plugins/playpark-skills/ 直下に symlink し、.gitignore で管理することで
# git status を汚さないようにする。
#
# 実体を plugin 配下に置く理由:
#   `claude plugin install`（mode: link）は、plugin ディレクトリの外を指す
#   top-level entry を見つけると install 自体を拒否する。実体を repo root の
#   .agents/ に置くと symlink が plugin の外へ脱出するため、この安全ガードに
#   引っかかって playpark-skills が install できなくなる。
#   実体を plugin 配下に移せば symlink が plugin 内で完結し、実体は 1 箇所のまま
#   （コピーによる二重管理なし）install が通る。
#
# 外部スキルの復元は plugins/playpark-skills/ を CWD にして実行する:
#   cd plugins/playpark-skills && npx skills experimental_install
#
# 冪等: 何度実行しても同じ結果になる。
# 不要になった stale symlink も自動クリーンアップする。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SKILLS_PLUGIN_REL="plugins/playpark-skills"
AGENTS_SKILLS_DIR="$REPO_ROOT/$SKILLS_PLUGIN_REL/.agents/skills"
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

# 1. 旧配置の symlink を掃除する
#     .agents/skills/ の存在確認より前に、かつ 3 の作成より前に実行する。
#     存在確認より後に置くと、実体を plugin 配下へ移す前のマシンでは早期 return して
#     掃除に到達せず、脱出 symlink が残って plugin install がブロックされたままになる。
#     作成より後に回すと、旧 symlink が残っている状態では 3 が
#     「別のリンク先を指しています」として skip し、その後で削除されるだけになり、
#     1 回の実行では新しい symlink が張られない（次回実行まで外部スキルが 0 件になる）。
#     4 の stale 掃除は「desired に含まれない」ものしか消さないため、同名スキルが
#     .agents/skills/ に存在する限り旧配置の symlink はそちらでは消えない。
#     - repo root 直下: plugins/playpark-skills/ へ移行する前の配置。残ると merge 後に
#       untracked として git status に現れる。
#     - plugins/playpark-skills/ 直下で repo root の .agents/ を指すもの: plugin の外へ
#       脱出するため `claude plugin install` に拒否される。
#     readlink が厳密に一致するものだけを消す（nix store 等の絶対パスを指す手動リンクは対象外）。
for link in "$REPO_ROOT"/*; do
  [[ -L "$link" ]] || continue
  name="$(basename "$link")"
  if [[ "$(readlink "$link")" == ".agents/skills/$name" ]]; then
    rm "$link"
    echo "removed legacy root symlink: $link"
  fi
done

for link in "$REPO_ROOT/$SKILLS_PLUGIN_REL"/*; do
  [[ -L "$link" ]] || continue
  name="$(basename "$link")"
  if [[ "$(readlink "$link")" == "../../.agents/skills/$name" ]]; then
    rm "$link"
    echo "removed escaping symlink: $link"
  fi
done

if [[ ! -d "$AGENTS_SKILLS_DIR" ]]; then
  echo "info: $AGENTS_SKILLS_DIR が存在しません。処理をスキップします。"
  exit 0
fi

# 2. .agents/skills/ 配下のディレクトリを収集
desired=()
for skill_dir in "$AGENTS_SKILLS_DIR"/*/; do
  [[ -d "$skill_dir" ]] || continue
  name="$(basename "$skill_dir")"
  desired+=("$name")
done

if [[ ${#desired[@]} -eq 0 ]]; then
  echo "info: .agents/skills/ にスキルが見つかりません。"
fi

# 3. 必要な symlink を作成
created=()
for name in "${desired[@]}"; do
  target="$AGENTS_SKILLS_DIR/$name"
  link="$REPO_ROOT/$SKILLS_PLUGIN_REL/$name"

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

  # 相対パスで symlink を作成（plugin ディレクトリ内で完結させる）
  ln -s ".agents/skills/$name" "$link"
  echo "created: $link -> .agents/skills/$name"
  created+=("$name")
done

# 4. stale symlink のクリーンアップ
#    以前の managed entries のうち、desired に含まれないものを削除
while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue
  entry_name="$(basename "$entry")"
  link="$REPO_ROOT/$entry"
  if [[ -L "$link" ]]; then
    # desired に含まれるか確認（basename で比較）
    is_desired=false
    for name in "${desired[@]}"; do
      if [[ "$name" == "$entry_name" ]]; then
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

# 5. .gitignore の managed セクションを更新
managed_entries=()
for name in "${created[@]}"; do
  managed_entries+=("$SKILLS_PLUGIN_REL/$name")
done
write_managed_section "${managed_entries[@]}"

echo "done: ${#created[@]} skill(s) linked."
