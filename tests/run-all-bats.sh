#!/usr/bin/env bash
# run-all-bats.sh - Discover and execute all .bats test files in the repo.
#
# Usage: run-all-bats.sh [--strict]
#
# Behavior:
#   - Discovers `**/*.bats` files under the repository root, excluding
#     `.git`, `node_modules`, `.serena`, `.system`, `.agents`, and worktree dirs.
#   - If `bats` is not installed:
#       - Default mode: prints a warning and exits 0 (graceful skip in
#         environments that don't have bats yet).
#       - `--strict` mode: exits 1 (use this in CI to require bats).
#   - If `bats` is installed: runs each .bats file and aggregates results.
#     Exit 0 only if all files pass; exit 1 if any test fails.
#
# Designed to be called from CI (GitHub Actions) after `brew install bats-core`
# (macOS) or `apt install bats` (ubuntu).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STRICT=false
if [[ "${1:-}" == "--strict" ]]; then
    STRICT=true
fi

if ! command -v bats >/dev/null 2>&1; then
    echo "[run-all-bats] bats is not installed." >&2
    echo "[run-all-bats] Install: brew install bats-core (macOS) / apt-get install bats (Ubuntu)" >&2
    if [[ "$STRICT" == true ]]; then
        echo "[run-all-bats] --strict mode: exiting 1." >&2
        exit 1
    fi
    echo "[run-all-bats] Skipping bats tests (non-strict mode)." >&2
    exit 0
fi

# Discover .bats files
mapfile -t BATS_FILES < <(
    find "$REPO_ROOT" \
        -type d \( -name ".git" -o -name "node_modules" -o -name ".serena" \
                -o -name ".system" -o -name ".agents" \) -prune -o \
        -type f -name "*.bats" -print | sort
)

if [[ ${#BATS_FILES[@]} -eq 0 ]]; then
    echo "[run-all-bats] No .bats files found."
    exit 0
fi

echo "[run-all-bats] Discovered ${#BATS_FILES[@]} .bats file(s):"
for f in "${BATS_FILES[@]}"; do
    echo "  - ${f#$REPO_ROOT/}"
done
echo ""

FAILED=()
PASSED=()
for f in "${BATS_FILES[@]}"; do
    echo "=== Running: ${f#$REPO_ROOT/} ==="
    if bats "$f"; then
        PASSED+=("$f")
    else
        FAILED+=("$f")
    fi
    echo ""
done

echo "=================================================="
echo "[run-all-bats] Summary: ${#PASSED[@]} passed, ${#FAILED[@]} failed"
echo "=================================================="

if [[ ${#FAILED[@]} -gt 0 ]]; then
    echo "Failed files:"
    for f in "${FAILED[@]}"; do
        echo "  - ${f#$REPO_ROOT/}"
    done
    exit 1
fi

exit 0
