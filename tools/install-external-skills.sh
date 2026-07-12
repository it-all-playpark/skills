#!/usr/bin/env bash
# Restore external skills into .agents/skills/ (gitignored) from tools/external-skills.tsv.
# Usage: tools/install-external-skills.sh [--dry-run]
#
# `npx skills add <repo> -y` は repo 単位でインストールするため、マニフェスト記載外の
# スキルが同じ repo から追加で入ることがある（skills CLI の仕様）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${MANIFEST:-$SCRIPT_DIR/external-skills.tsv}"
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
while IFS=$'\t' read -r name source _; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  if [[ -z "$source" || "$source" == "-" ]]; then
    skipped+=("$name")
    continue
  fi
  skills+=("$name")
  dup=0
  if ((${#sources[@]})); then
    for s in "${sources[@]}"; do
      [[ "$s" == "$source" ]] && { dup=1; break; }
    done
  fi
  ((dup)) || sources+=("$source")
done <"$MANIFEST"

if ((${#skipped[@]})); then
  echo "skipped (no recorded source): ${skipped[*]}" >&2
fi

if ((${#sources[@]} == 0)); then
  echo "no installable sources in manifest" >&2
  exit 1
fi

echo "install sources (${#sources[@]}):"
printf '  %s\n' "${sources[@]}"

if ((DRY_RUN)); then
  printf 'npx skills add %s -y\n' "${sources[@]}"
  exit 0
fi

command -v npx >/dev/null 2>&1 || { echo "npx not found" >&2; exit 1; }
for source in "${sources[@]}"; do
  npx skills add "$source" -y
done

repo_root="$(cd "$SCRIPT_DIR/.." && pwd)"
missing=0
for name in "${skills[@]}"; do
  if [[ ! -d "$repo_root/.agents/skills/$name" ]]; then
    echo "MISSING after install: $name" >&2
    missing=1
  fi
done
exit "$missing"
