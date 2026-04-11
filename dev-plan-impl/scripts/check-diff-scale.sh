#!/usr/bin/env bash
# check-diff-scale.sh - Measure diff scale between previous and current impl-plan.md
#
# Purpose: In evaluator-optimizer Plan-Review Loop (iteration > 1),
# dev-plan-impl should perform "differential revise" — editing only the
# problematic sections, not rewriting the whole plan from scratch.
# This script mechanically verifies that by measuring the ratio of
# changed lines to total lines and emitting a warning when it exceeds
# the configured threshold (default 0.5).
#
# Usage:
#   check-diff-scale.sh --current <file> --previous <file> [--worktree <path>] [--max-ratio <float>]
#
# Options:
#   --current <file>    Path to newly written plan (required)
#   --previous <file>   Path to previous plan (required; if missing on disk,
#                       returns status="skipped")
#   --worktree <path>   Worktree path used to resolve config.plan_review.max_diff_ratio
#                       from .claude/kickoff.json (optional)
#   --max-ratio <float> Override threshold (CLI > config > default 0.5)
#
# Output JSON (stdout):
#   {
#     "status": "ok" | "warning" | "skipped",
#     "added": <int>,
#     "removed": <int>,
#     "total_lines": <int>,
#     "ratio": <float>,
#     "max_ratio": <float>,
#     "message": "..."
#   }
#
# Always exits 0 on normal completion (warning is non-blocking).
# Non-zero exit only on invalid arguments or missing commands.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd git
require_cmd jq
require_cmd awk
require_cmd wc

CURRENT=""
PREVIOUS=""
WORKTREE=""
MAX_RATIO_CLI=""
DEFAULT_MAX_RATIO="0.5"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --current) CURRENT="$2"; shift 2 ;;
        --previous) PREVIOUS="$2"; shift 2 ;;
        --worktree) WORKTREE="$2"; shift 2 ;;
        --max-ratio) MAX_RATIO_CLI="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,30p' "$0"
            exit 0
            ;;
        *)
            die_json "Unknown option: $1" 1
            ;;
    esac
done

if [[ -z "$CURRENT" ]] || [[ -z "$PREVIOUS" ]]; then
    die_json "--current and --previous are required" 1
fi

# Skipped: previous plan missing (first iteration)
if [[ ! -f "$PREVIOUS" ]]; then
    jq -n --arg msg "Previous plan not found; skipping diff-scale check (first iteration)" \
        '{status:"skipped", added:0, removed:0, total_lines:0, ratio:0, max_ratio:null, message:$msg}'
    exit 0
fi

# Current must exist (but allow empty)
if [[ ! -f "$CURRENT" ]]; then
    die_json "Current plan not found: $CURRENT" 1
fi

# Resolve max_ratio: CLI > kickoff.json config > default
MAX_RATIO="$DEFAULT_MAX_RATIO"
if [[ -n "$WORKTREE" ]] && [[ -f "$WORKTREE/.claude/kickoff.json" ]]; then
    CFG_VAL=$(jq -r '.config.plan_review.max_diff_ratio // empty' "$WORKTREE/.claude/kickoff.json" 2>/dev/null || true)
    if [[ -n "$CFG_VAL" ]]; then
        MAX_RATIO="$CFG_VAL"
    fi
fi
if [[ -n "$MAX_RATIO_CLI" ]]; then
    MAX_RATIO="$MAX_RATIO_CLI"
fi

# Compute added/removed using git diff --numstat --no-index
# Note: --no-index exits with status 1 when diff is non-empty (not an error).
NUMSTAT=$(git diff --no-index --numstat -- "$PREVIOUS" "$CURRENT" 2>/dev/null || true)

if [[ -z "$NUMSTAT" ]]; then
    ADDED=0
    REMOVED=0
else
    # numstat format: "<added>\t<removed>\t<file>"
    ADDED=$(echo "$NUMSTAT" | awk 'BEGIN{s=0} {if ($1 ~ /^[0-9]+$/) s += $1} END{print s+0}')
    REMOVED=$(echo "$NUMSTAT" | awk 'BEGIN{s=0} {if ($2 ~ /^[0-9]+$/) s += $2} END{print s+0}')
fi

TOTAL_LINES=$(wc -l < "$CURRENT" | awk '{print $1+0}')

# ratio = (added + removed) / total_lines (0 if total_lines == 0)
CHANGED=$((ADDED + REMOVED))
RATIO=$(awk -v c="$CHANGED" -v t="$TOTAL_LINES" 'BEGIN { if (t+0 == 0) print 0; else printf "%.4f", c / t }')

# Compare ratio to max_ratio with awk for float comparison
EXCEEDS=$(awk -v r="$RATIO" -v m="$MAX_RATIO" 'BEGIN { print (r+0 > m+0) ? "1" : "0" }')

if [[ "$EXCEEDS" == "1" ]]; then
    STATUS="warning"
    MSG=$(printf 'diff ratio %s exceeds max %s (possible full rewrite, expected differential revise)' "$RATIO" "$MAX_RATIO")
    warn "$MSG"
else
    STATUS="ok"
    MSG=$(printf 'diff ratio %s within max %s' "$RATIO" "$MAX_RATIO")
fi

jq -n \
    --arg status "$STATUS" \
    --argjson added "$ADDED" \
    --argjson removed "$REMOVED" \
    --argjson total_lines "$TOTAL_LINES" \
    --argjson ratio "$RATIO" \
    --argjson max_ratio "$MAX_RATIO" \
    --arg message "$MSG" \
    '{status:$status, added:$added, removed:$removed, total_lines:$total_lines, ratio:$ratio, max_ratio:$max_ratio, message:$message}'

exit 0
