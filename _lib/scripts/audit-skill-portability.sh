#!/usr/bin/env bash
# audit-skill-portability.sh — survey Claude Code 拡張 frontmatter usage across SKILL.md files
# Output: stdout の集計 + claudedocs/skill-portability-audit-<date>.md
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATE="$(date +%Y%m%d-%H%M%S)"
REPORT="$REPO_ROOT/claudedocs/skill-portability-audit-$DATE.md"
mkdir -p "$(dirname "$REPORT")"

# Claude Code 拡張 frontmatter フィールド (SKILL.md open spec の portable subset 外)
CLAUDE_EXT_FIELDS=(
  "allowed-tools"
  "model"
  "effort"
  "context"
  "agent"
  "hooks"
  "disable-model-invocation"
  "user-invocable"
  "argument-hint"
  "arguments"
  "paths"
  "shell"
)

# portable subset (SKILL.md open spec 標準)
PORTABLE_FIELDS=(
  "name"
  "description"
  "version"
  "author"
  "tags"
  "agents"
  "license"
  "metadata"
)

# 検索対象: リポ内 + .agents/skills/ 配下 (symlink 経由含むが重複排除)
mapfile -t SKILL_FILES < <(
  find "$REPO_ROOT" -name 'SKILL.md' \
    -not -path '*/node_modules/*' \
    -not -path '*/.git/*' \
    -not -path '*/claudedocs/*' \
    2>/dev/null \
    | sort -u
)

TOTAL=${#SKILL_FILES[@]}

# 集計
declare -A FIELD_COUNT
declare -A FIELD_FILES
for f in "${CLAUDE_EXT_FIELDS[@]}"; do FIELD_COUNT[$f]=0; FIELD_FILES[$f]=""; done

# SKILL.md ごとに frontmatter (--- から --- まで) を抽出して各フィールドを grep
audit_one() {
  local file="$1"
  # frontmatter のみ抽出
  local frontmatter
  frontmatter=$(awk '/^---$/{c++; if(c==2)exit; next} c==1' "$file" 2>/dev/null || true)
  [ -z "$frontmatter" ] && return 0

  local short
  short="${file#$REPO_ROOT/}"

  for field in "${CLAUDE_EXT_FIELDS[@]}"; do
    # 行頭で field: を grep (block scalar / indent はゆるく許容)
    if echo "$frontmatter" | grep -qE "^${field}:" ; then
      FIELD_COUNT[$field]=$((FIELD_COUNT[$field] + 1))
      FIELD_FILES[$field]="${FIELD_FILES[$field]}\n  - $short"
    fi
  done
}

for skill in "${SKILL_FILES[@]}"; do
  audit_one "$skill"
done

# レポート出力
{
  echo "# SKILL.md Portability Audit — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo "## Scope"
  echo ""
  echo "- Total SKILL.md files scanned: **$TOTAL**"
  echo "- Repo root: \`$REPO_ROOT\`"
  echo ""
  echo "## Claude Code 拡張 frontmatter 使用頻度"
  echo ""
  echo "| Field | Count | % | Portable? |"
  echo "|---|---|---|---|"
  for field in "${CLAUDE_EXT_FIELDS[@]}"; do
    local_count=${FIELD_COUNT[$field]}
    pct=$(awk "BEGIN{printf \"%.0f\", $local_count*100/$TOTAL}")
    printf "| \`%s\` | %d | %s%% | ❌ (Claude 拡張) |\n" "$field" "$local_count" "$pct"
  done
  echo ""
  echo "## 各 field を使ってる skill 一覧"
  echo ""
  for field in "${CLAUDE_EXT_FIELDS[@]}"; do
    if [ "${FIELD_COUNT[$field]}" -gt 0 ]; then
      echo "### \`$field\` (${FIELD_COUNT[$field]} skills)"
      echo ""
      echo -e "${FIELD_FILES[$field]}"
      echo ""
    fi
  done
  echo "## Risk Categories"
  echo ""
  echo "- **High risk (即 portable 化必要)**: \`allowed-tools\`, \`hooks\`, \`context\`, \`agent\`, \`disable-model-invocation\`, \`user-invocable\` — Codex/agy parser が知らないフィールド"
  echo "- **Medium risk**: \`model\`, \`effort\` — 機能としては portable subset 外、ただし parser は通る可能性"
  echo "- **Low risk**: \`argument-hint\`, \`arguments\`, \`paths\`, \`shell\` — semantic は失われるが parse は通る"
  echo ""
  echo "## 推奨: 移行優先度"
  echo ""
  echo "1. 使用頻度の高いフィールド (上記表) を adapter overlay 化"
  echo "2. \`allowed-tools\` を使う skill は **Bash 制限を AGENTS.md に転記** (\`## Tool restrictions\` セクション)"
  echo "3. \`hooks\` を使う skill は **portable hook 機構を別途検討** (settings.json adapter)"
  echo "4. \`context: fork\` / \`agent: <type>\` は **bash で別 process spawn 化** (CLI 経由)"
} > "$REPORT"

echo "Report written: $REPORT"
echo ""
echo "=== Summary ==="
echo "Total SKILL.md scanned: $TOTAL"
echo ""
echo "Claude 拡張 frontmatter usage:"
for field in "${CLAUDE_EXT_FIELDS[@]}"; do
  printf "  %-30s %4d  (%s%%)\n" "$field" "${FIELD_COUNT[$field]}" "$(awk "BEGIN{printf \"%.0f\", ${FIELD_COUNT[$field]}*100/$TOTAL}")"
done
