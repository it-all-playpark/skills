#!/usr/bin/env bash
# ensure-committed.sh - Detect and recover uncommitted changes in the cwd git
# worktree (pr-iterate AC-2 / AC-3, issue #437).
#
# Usage:
#   ensure-committed.sh --check-only
#   ensure-committed.sh --pr <positive-int> --iteration <positive-int>
#
# Mode 1 (--check-only): reports whether the cwd git worktree is dirty
# (tracked changes and/or untracked files, via `git status --porcelain`).
# Advisory probe used by pr-iterate at non-lgtm terminal states.
#
#   Output JSON: { "dirty": true|false, "files": N }
#
# Mode 2 (--pr N --iteration I): if the worktree is clean, no-op. If dirty,
# stages+commits+pushes the leftover changes so a fix-loop iteration never
# leaves uncommitted state behind (`git add -A`, Conventional Commits message,
# `git push` with a one-shot `git push -u origin HEAD` fallback). Never
# throws on commit/push failure -- partial failure is reported via the JSON
# booleans so the caller (pr-iterate exec-proxy) can fail-safe on it.
#
#   Output JSON: { "dirty": true|false, "committed": true|false, "pushed": true|false }
#   (committed/pushed omitted from the clean no-op case's semantics -- they
#   are always false there since no commit/push was attempted.)
#
# Exit codes:
#   0 - determined (both modes, including the dirty:false no-op in mode 2)
#   1 - not a git repository, or invalid/missing arguments
#
# stdout carries only the single-line JSON result; nothing else is ever
# printed to stdout (the caller exec-proxy transcribes stdout verbatim).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd git

CHECK_ONLY=0
PR_NUM=""
ITERATION=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check-only) CHECK_ONLY=1; shift ;;
        --pr) PR_NUM="${2:-}"; shift 2 ;;
        --iteration) ITERATION="${2:-}"; shift 2 ;;
        -*) die_json "Unknown option: $1" 1 ;;
        *) die_json "Unknown argument: $1" 1 ;;
    esac
done

git rev-parse --git-dir &>/dev/null || die_json "Not a git repository" 1

if [[ $CHECK_ONLY -eq 1 ]]; then
    porcelain=$(git status --porcelain)
    files=0
    dirty=false
    if [[ -n "$porcelain" ]]; then
        dirty=true
        files=$(printf '%s\n' "$porcelain" | wc -l | tr -d ' ')
    fi
    printf '{"dirty":%s,"files":%s}\n' "$dirty" "$files"
    exit 0
fi

[[ -n "$PR_NUM" ]] || die_json "--pr is required" 1
[[ -n "$ITERATION" ]] || die_json "--iteration is required" 1
[[ "$PR_NUM" =~ ^[0-9]+$ ]] && (( PR_NUM > 0 )) || die_json "Invalid --pr: $PR_NUM. Must be a positive integer" 1
[[ "$ITERATION" =~ ^[0-9]+$ ]] && (( ITERATION > 0 )) || die_json "Invalid --iteration: $ITERATION. Must be a positive integer" 1

porcelain=$(git status --porcelain)
if [[ -z "$porcelain" ]]; then
    echo '{"dirty":false,"committed":false,"pushed":false}'
    exit 0
fi

committed=false
pushed=false

if git add -A && git commit -m "fix(pr-${PR_NUM}): commit leftover review fixes (iteration ${ITERATION})"; then
    committed=true
fi

if [[ "$committed" == true ]]; then
    if git push; then
        pushed=true
    elif git push -u origin HEAD; then
        pushed=true
    fi
fi

printf '{"dirty":true,"committed":%s,"pushed":%s}\n' "$committed" "$pushed"
exit 0
