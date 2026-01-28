#!/usr/bin/env bash
# pr-finish.sh - Validate, commit, and push PR fixes
# Usage: pr-finish.sh [--no-push]

set -euo pipefail

source "$(dirname "$0")/../../_lib/common.sh"

NO_PUSH=false
[[ "${1:-}" == "--no-push" ]] && NO_PUSH=true

require_git_repo

echo "=== Validate ===" >&2
if [[ -f "package.json" ]]; then
    npm test 2>&1 || { echo "Tests failed" >&2; exit 1; }
    npm run lint 2>&1 || echo "Lint warnings (non-blocking)" >&2
elif [[ -f "Makefile" ]]; then
    make test 2>&1 || { echo "Tests failed" >&2; exit 1; }
fi

echo ""
echo "=== Commit ===" >&2
if ! git_is_clean; then
    git add -A
    git commit -m "fix: address review feedback"
    echo "Committed changes"
else
    echo "No changes to commit"
fi

if [[ "$NO_PUSH" == false ]]; then
    echo ""
    echo "=== Push ===" >&2
    git push --force-with-lease
    echo "Pushed"
else
    echo "Skipped push (--no-push)"
fi
