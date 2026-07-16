#!/usr/bin/env bash
# run-node-tests.sh - Run the vitest suite (`**/*.test.mjs`) via node_modules/.bin/vitest.
#
# Usage: run-node-tests.sh [--strict]
#
# Behavior (post issue #356 vitest migration):
#   - Test discovery (include/exclude) is owned by `vitest.config.mjs`
#     (include `**/*.test.mjs`, excluding `.git`, `node_modules`, `.serena`,
#     `.system`, `.agents`, and `.claude/worktrees` to avoid double-running
#     tests in shared worktrees). This script no longer discovers files
#     itself.
#   - If `node` is not installed:
#       - Default mode: prints a warning and exits 0 (graceful skip in
#         environments that don't have node yet).
#       - `--strict` mode: exits 1 (use this in CI to require node).
#   - If `node_modules/.bin/vitest` is not installed (e.g. `npm ci` was
#     never run):
#       - Default mode: prints a warning and exits 0 (graceful skip).
#       - `--strict` mode: exits 1 (use this in CI to require vitest).
#     There is no fallback to `node --test` — after the vitest migration,
#     that path is unmaintained and would silently mask an unresolved
#     dependency install.
#   - Otherwise: `exec`s `node_modules/.bin/vitest run`, passing through its
#     exit code as-is.
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

VITEST_BIN="$REPO_ROOT/node_modules/.bin/vitest"

if [[ ! -x "$VITEST_BIN" ]]; then
    echo "[run-node-tests] vitest is not installed. Run 'npm ci' to enable tests." >&2
    if [[ "$STRICT" == true ]]; then
        echo "[run-node-tests] --strict mode: exiting 1." >&2
        exit 1
    fi
    echo "[run-node-tests] skipping (non-strict mode)." >&2
    exit 0
fi

# vitest resolves its config/root relative to the process cwd, not to
# $REPO_ROOT, so this script must cd into $REPO_ROOT itself before
# invoking it (callers may run this script from any cwd via an absolute
# path). Without this, vitest.config.mjs's include/exclude denylist would
# be bypassed entirely in favor of vitest's own defaults.
cd "$REPO_ROOT" || exit 1

exec "$VITEST_BIN" run
