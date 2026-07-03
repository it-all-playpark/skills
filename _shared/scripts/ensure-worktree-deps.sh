#!/usr/bin/env bash
# ensure-worktree-deps.sh - Non-blocking install wrapper for worktree setup (issue #120)
#
# Purpose: Called after a worktree is confirmed (WT established), attempts dependency
# installation without blocking the dev-flow Setup phase. Even if install fails, this
# script exits 0 — the failure is visible in the JSON output (status partial/failed),
# and the downstream Validate (test-green) loop acts as the second safety net.
#
# Usage: ensure-worktree-deps.sh --path <dir> [--lockfile-only] [--skip-custom]
#
# --lockfile-only / --skip-custom are forwarded verbatim to detect-and-install.sh
# (see that script for semantics). dev-flow's Setup phase calls this wrapper as
# `ensure-worktree-deps.sh --path <WT> --lockfile-only --skip-custom` — this flag
# name is a fixed contract, do not rename (issue #291).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=../../_lib/common.sh
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Args
# ============================================================================

TARGET_PATH=""
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --path) TARGET_PATH="$2"; shift 2 ;;
        --lockfile-only) EXTRA_ARGS+=("--lockfile-only"); shift ;;
        --skip-custom) EXTRA_ARGS+=("--skip-custom"); shift ;;
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
#
# Error handling:
#   - Temporarily disable set -e to prevent this wrapper from aborting on
#     a non-zero exit from the delegate (non-blocking contract).
#   - Capture stdout, stderr, and exit code separately via temp files.
#   - If the delegate hard-crashes (nonexistent path, missing jq, etc.) and
#     emits empty or non-JSON output, emit a structured fallback JSON so
#     dev-runner always receives a valid ENVSETUP schema payload.
#   - Re-emit stderr as a diagnostic warning (never silently swallowed).
# ============================================================================

stdout_tmp="$(mktemp)"
stderr_tmp="$(mktemp)"
exit_tmp="$(mktemp)"

# set +e so a non-zero exit from detect-and-install.sh does not propagate to us.
set +e
"$SCRIPT_DIR/detect-and-install.sh" --path "$TARGET_PATH" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} >"$stdout_tmp" 2>"$stderr_tmp"
printf '%d' $? >"$exit_tmp"
set -e

output="$(cat "$stdout_tmp")"
delegate_exit="$(cat "$exit_tmp")"
stderr_content="$(cat "$stderr_tmp")"
rm -f "$stdout_tmp" "$stderr_tmp" "$exit_tmp"

# Re-emit stderr as a diagnostic warn on fd2 so it is visible in logs.
if [[ -n "$stderr_content" ]]; then
    printf '[ensure-worktree-deps] detect-and-install stderr: %s\n' "$stderr_content" >&2
fi

# Validate that output looks like JSON (starts with '{'), regardless of exit code.
# The delegate may exit non-zero but still emit structured error JSON — pass it through.
# Only synthesize a fallback when output is empty or non-JSON (i.e., the delegate
# hard-crashed before it could write anything useful).
if [[ -z "$output" ]] || [[ "${output:0:1}" != "{" ]]; then
    error_detail="${stderr_content:-exit code ${delegate_exit}}"
    # Use json_escape (jq -Rs . with fallback) to safely handle newlines,
    # backslashes, and control characters that may appear in delegate stderr.
    printf '{"status":"failed","path":%s,"error":%s}\n' \
        "$(json_escape "$TARGET_PATH")" \
        "$(json_escape "$error_detail")"
    exit 0
fi

printf '%s\n' "$output"

exit 0
