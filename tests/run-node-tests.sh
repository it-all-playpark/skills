#!/usr/bin/env bash
# run-node-tests.sh - Discover and execute all *.test.mjs files in the repo.
#
# Usage: run-node-tests.sh [--strict]
#
# Behavior:
#   - Discovers `**/*.test.mjs` files under the repository root, excluding
#     `.git`, `node_modules`, `.serena`, `.system`, `.agents`, and
#     `.claude/worktrees` (to avoid double-running tests in shared worktrees).
#   - If `node` is not installed:
#       - Default mode: prints a warning and exits 0 (graceful skip in
#         environments that don't have node yet).
#       - `--strict` mode: exits 1 (use this in CI to require node).
#   - If `node` is installed: runs `node --test` on all discovered files.
#     Exit 0 only if all tests pass; exit 1 if any test fails.
#
# Designed to be called from CI (GitHub Actions) with Node 24.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STRICT=false
if [[ "${1:-}" == "--strict" ]]; then
    STRICT=true
fi

if ! command -v node >/dev/null 2>&1; then
    echo "[run-node-tests] node is not installed." >&2
    if [[ "$STRICT" == true ]]; then
        echo "[run-node-tests] --strict mode: exiting 1." >&2
        exit 1
    fi
    echo "[run-node-tests] skipping (non-strict mode)." >&2
    exit 0
fi

# Discover *.test.mjs files, excluding dirs that should not be scanned
mapfile -t FILES < <(
    find "$REPO_ROOT" \
        -path '*/.git' -prune -o \
        -path '*/node_modules' -prune -o \
        -path '*/.serena' -prune -o \
        -path '*/.system' -prune -o \
        -path '*/.agents' -prune -o \
        -path '*/.claude/worktrees' -prune -o \
        -name '*.test.mjs' -print | sort
)

if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "[run-node-tests] no *.test.mjs found."
    exit 0
fi

echo "[run-node-tests] Discovered ${#FILES[@]} *.test.mjs file(s):"
for f in "${FILES[@]}"; do
    echo "  - ${f#$REPO_ROOT/}"
done
echo ""

node --test "${FILES[@]}"
