#!/usr/bin/env bash
# structural-classify.sh - dev-flow structural vs format-only diff classification (issue #350).
#
# Purpose: For each file changed between <base-ref> and the working tree at <worktree-path>,
# classify it as "structural" (a real, semantic code change) or "format_only" (e.g. whitespace /
# quote-style-only change) using `difft --check-only --exit-code` (difftastic). Only the process
# EXIT CODE is used for the decision -- difftastic's JSON output mode is experimental and is
# NEVER parsed. This is advisory pre-processing for the dev-flow Evaluate phase: failures here
# must never block the pipeline (fail-open at the caller), so this script itself always exits 0
# on every expected path and only emits {"ok":false,...} + non-zero exit for truly unexpected
# usage errors (missing args, bad worktree path, no merge-base).
#
# Usage: structural-classify.sh <worktree-path> <base-ref>
# Output (stdout, JSON 1 line):
#   Normal:          {"ok":true,"available":true,"structural":["path1",...],"format_only":["path2",...]}
#   difft missing:   {"ok":true,"available":false,"structural":[],"format_only":[],"reason":"difft_not_installed"}
#   Usage/git error: {"ok":false,"error":"..."}
# Exit: 0 on all expected paths (including "difft not installed"). Non-zero only on unexpected
#       errors (missing args, invalid worktree path, no merge-base between HEAD and base-ref).
#
# Classification rules:
#   - Added (A) / Deleted (D) / Typechange (T) tracked files: always "structural" (no comparable
#     "old" version exists for a format-only judgement).
#   - Untracked new files: always "structural" (same reasoning; old side does not exist).
#   - Modified (M) tracked files: run `difft --check-only --exit-code <old-blob> <new-file>` per
#     file. Exit 0 -> "format_only". Exit 1 -> "structural". Any other exit code (binary file,
#     difft internal error, etc.) -> "structural" (fail-safe: default to the side that gets
#     audited by the evaluator).
#   - Renames are never seen as such: `git diff --no-renames` forces them to A+D pairs, which
#     collapses the 3-field (status\0old\0new\0) rename record into the same fixed 2-field
#     (status\0path\0) record as every other status, and both resulting entries are "structural"
#     regardless (a rename alone is never format-only).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=../../_lib/common.sh
source "$SCRIPT_DIR/../../_lib/common.sh"

die_json() {
    local msg="$1"
    local code="${2:-1}"
    printf '{"ok":false,"error":%s}\n' "$(json_str "$msg")"
    exit "$code"
}

# ============================================================================
# Args
# ============================================================================

wt="${1:-}"
base="${2:-}"

if [[ -z "$wt" || -z "$base" ]]; then
    die_json "usage: structural-classify.sh <worktree-path> <base-ref>" 2
fi

if [[ ! -d "$wt" ]]; then
    die_json "worktree path does not exist: $wt" 2
fi

if ! git -C "$wt" rev-parse --git-dir &>/dev/null; then
    die_json "not a git repository: $wt" 2
fi

# ============================================================================
# 1. difft availability check (fallback, NOT an error)
# ============================================================================

if ! command -v difft &>/dev/null; then
    printf '%s\n' '{"ok":true,"available":false,"structural":[],"format_only":[],"reason":"difft_not_installed"}'
    exit 0
fi

# ============================================================================
# 2. merge-base (same working-tree diff anchor as diff-risk-classify.sh --working-tree
#    / realized-diff: merge-base(base, HEAD), not the two-dot base itself)
# ============================================================================

set +e
MB="$(git -C "$wt" merge-base HEAD "$base" 2>/dev/null)"
_MB_RC=$?
set -e
if [[ "$_MB_RC" -ne 0 || -z "$MB" ]]; then
    die_json "no merge-base between HEAD and $base" 2
fi

# ============================================================================
# Working area for old-side blobs. Full relative path is preserved under
# "$tmp/old/<relpath>" (not basename) so that same-basename files in different
# directories (e.g. a/foo.js and b/foo.js) never collide, and the extension is
# preserved for difft's language detection.
# ============================================================================

tmp="$(mktemp -d "${TMPDIR:-/tmp}/structural-classify.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

structural=""
format_only=""

# ============================================================================
# 3-5. Tracked changes: --no-renames --name-status -z -> status\0path\0 pairs
# ============================================================================
# --no-renames forces renames into A+D pairs so every record is a fixed
# 2-field (status\0path\0) tuple; a variable 3-field rename record
# (R100\0old\0new\0) would desync every subsequent read if mis-parsed.
#
# NOTE: this MUST be read via process substitution (`< <(...)`), NOT captured
# into a shell variable via command substitution first. Bash command
# substitution silently strips embedded NUL bytes ("ignored null byte in
# input"), which would corrupt the -z record boundaries and desync every
# status/path pair. Process substitution streams the raw bytes directly into
# `read -d ''` without ever passing through a NUL-truncating variable, and
# (unlike a pipe) does not run the while-loop body in a subshell, so
# structural/format_only accumulate correctly across iterations.

while IFS= read -r -d '' status && IFS= read -r -d '' path; do
    [[ -z "$status" ]] && continue

    if [[ "$status" == "M" ]]; then
        # Per-file completed processing: write old blob -> run difft -> classify,
        # before moving to the next file (avoids any cross-file state).
        mkdir -p "$tmp/old/$(dirname "$path")"
        if git -C "$wt" show "${MB}:${path}" > "$tmp/old/$path" 2>/dev/null; then
            set +e
            difft --check-only --exit-code "$tmp/old/$path" "$wt/$path" >/dev/null 2>&1
            _rc=$?
            set -e
            if [[ "$_rc" -eq 0 ]]; then
                format_only="${format_only}${path}"$'\n'
            else
                # exit 1 (structural) as well as any other exit code
                # (binary file, difft internal error, etc.) -> fail-safe structural.
                structural="${structural}${path}"$'\n'
            fi
        else
            # Could not materialize the old blob (unexpected) -- fail-safe structural.
            structural="${structural}${path}"$'\n'
        fi
    else
        # A / D / T (and any unrecognized status): no comparable "old" pairing
        # for a format-only judgement -- always structural.
        structural="${structural}${path}"$'\n'
    fi
done < <(git -C "$wt" diff --no-renames --name-status -z "$MB" 2>/dev/null)

# ============================================================================
# 6. Untracked files: no "old" side exists -> always structural.
# ============================================================================
# Same process-substitution rationale as above (NUL-safety + no variable
# truncation).

while IFS= read -r -d '' path; do
    [[ -z "$path" ]] && continue
    structural="${structural}${path}"$'\n'
done < <(git -C "$wt" ls-files --others --exclude-standard -z 2>/dev/null)

# ============================================================================
# 7. JSON emission (same escaping strategy as diff-risk-classify.sh: jq preferred,
#    json_escape fallback).
# ============================================================================

structural="${structural%$'\n'}"
format_only="${format_only%$'\n'}"

json_path_array() {
    local list="$1"
    if [[ -z "$list" ]]; then
        printf '[]'
        return
    fi
    if has_jq; then
        printf '%s\n' "$list" | jq -c -R -s 'split("\n") | map(select(length > 0))'
    else
        local result="[" first=true line
        # Process substitution (not a here-string) to avoid depending on
        # heredoc temp-file creation, which can fail under a restricted PATH
        # (e.g. resolving to an older system bash instead of a modern one).
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            if [[ "$first" == true ]]; then
                first=false
            else
                result="${result},"
            fi
            result="${result}$(json_escape "$line")"
        done < <(printf '%s\n' "$list")
        result="${result}]"
        printf '%s' "$result"
    fi
}

structural_json="$(json_path_array "$structural")"
format_only_json="$(json_path_array "$format_only")"

printf '{"ok":true,"available":true,"structural":%s,"format_only":%s}\n' "$structural_json" "$format_only_json"
exit 0
