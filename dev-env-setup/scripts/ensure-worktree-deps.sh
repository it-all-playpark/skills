#!/usr/bin/env bash
# ensure-worktree-deps.sh - Non-blocking install wrapper for worktree setup (issue #120)
#
# Purpose: Called after a worktree is confirmed (WT established), attempts dependency
# installation without blocking the dev-flow Setup phase. Even if install fails, this
# script exits 0 — the failure is visible in the JSON output (status partial/failed),
# and the downstream Validate (test-green) loop acts as the second safety net.
#
# Usage: ensure-worktree-deps.sh --path <dir>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ============================================================================
# Args
# ============================================================================

TARGET_PATH=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --path) TARGET_PATH="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

if [[ -z "$TARGET_PATH" ]]; then
    echo "--path is required" >&2
    exit 2
fi

# ============================================================================
# Delegate to detect-and-install.sh (single source of truth for install logic)
# Idempotency, pm detection, and already_installed checks are all in that script.
# ============================================================================

output="$("$SCRIPT_DIR/detect-and-install.sh" --path "$TARGET_PATH" 2>/dev/null || true)"

printf '%s\n' "$output"

exit 0
