#!/usr/bin/env bash
# fixer-finish.sh - pr-fixer の commit+push 決定論部。変更検出→commit→(push)。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_git_repo

NO_PUSH=0; MSG="fix: address review feedback"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-push) NO_PUSH=1; shift ;;
    --message) [[ $# -ge 2 ]] || die_json "--message requires a value" 1; MSG="$2"; shift 2 ;;
    *) die_json "Unknown option: $1" 1 ;;
  esac
done

if git diff --quiet && git diff --cached --quiet; then
  echo '{"result":"no_changes"}'; exit 0
fi

git add -A
git commit -qm "$MSG"
if [[ "$NO_PUSH" -eq 0 ]]; then
  git push 2>/dev/null || die_json "push failed" 1
fi
echo '{"result":"committed"}'
