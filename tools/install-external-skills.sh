#!/usr/bin/env bash
# Restore external skills into .agents/skills/ (gitignored) from tools/external-skills.tsv.
# Usage: tools/install-external-skills.sh [--dry-run]
#
# per-skill 構文 (`npx skills add <repo>@<skill> -y`) でインストールするため、
# 数百スキルを収録する repo が取得元でも manifest 記載分しか入らない。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${MANIFEST:-$SCRIPT_DIR/external-skills.tsv}"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

[[ -f "$MANIFEST" ]] || { echo "manifest not found: $MANIFEST" >&2; exit 1; }

skills=()
sources=()
skipped=()
while IFS=$'\t' read -r name source _ || [[ -n "$name" ]]; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  if [[ -z "$source" || "$source" == "-" ]]; then
    skipped+=("$name")
    continue
  fi
  skills+=("$name")
  sources+=("$source")
done <"$MANIFEST"

if ((${#skipped[@]})); then
  echo "skipped (no recorded source): ${skipped[*]}" >&2
fi

if ((${#skills[@]} == 0)); then
  echo "no installable sources in manifest" >&2
  exit 1
fi

echo "install skills (${#skills[@]}):"
for i in "${!skills[@]}"; do
  echo "  ${sources[$i]}@${skills[$i]}"
done

if ((DRY_RUN)); then
  for i in "${!skills[@]}"; do
    echo "npx skills add ${sources[$i]}@${skills[$i]} -y"
  done
  exit 0
fi

command -v npx >/dev/null 2>&1 || { echo "npx not found" >&2; exit 1; }
# npx skills add は cwd 基準でインストールするため repo root に固定する
cd "$REPO_ROOT"
for i in "${!skills[@]}"; do
  npx skills add "${sources[$i]}@${skills[$i]}" -y
done

missing=0
for name in "${skills[@]}"; do
  if [[ ! -d "$REPO_ROOT/.agents/skills/$name" ]]; then
    echo "MISSING after install: $name" >&2
    missing=1
  fi
done
exit "$missing"
