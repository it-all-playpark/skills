#!/usr/bin/env bash
# validate-kickoff.sh - Check kickoff.json feature_list immutability.
# Warns (non-fatal) if feature_list[i].id or desc changed from initial commit.
# Usage: validate-kickoff.sh [--worktree PATH]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

WORKTREE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree) WORKTREE="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: validate-kickoff.sh [--worktree <path>]"
            exit 0
            ;;
        *) shift ;;
    esac
done

[[ -n "$WORKTREE" ]] || WORKTREE=$(pwd)
[[ -d "$WORKTREE" ]] || { echo '{"status":"skipped","reason":"worktree not found"}'; exit 0; }
WORKTREE=$(cd "$WORKTREE" && pwd)

STATE_FILE="$WORKTREE/.claude/kickoff.json"

# Silent pass if kickoff.json is absent (standalone invocation)
if [[ ! -f "$STATE_FILE" ]]; then
    echo '{"status":"skipped","reason":"kickoff.json not found"}'
    exit 0
fi

# Silent pass if feature_list is empty or missing (backward compat)
FEATURE_COUNT=$(jq '(.feature_list // []) | length' "$STATE_FILE" 2>/dev/null || echo 0)
if [[ "$FEATURE_COUNT" -eq 0 ]]; then
    echo '{"status":"skipped","reason":"feature_list is empty"}'
    exit 0
fi

cd "$WORKTREE" || exit 0

# Find the commit where kickoff.json was first introduced in this branch
FIRST_COMMIT=$(git log --diff-filter=A --format=%H -- .claude/kickoff.json 2>/dev/null | tail -1)

if [[ -z "$FIRST_COMMIT" ]]; then
    # kickoff.json is untracked or never committed — we cannot compare baseline
    echo '{"status":"skipped","reason":"kickoff.json has no git history yet"}'
    exit 0
fi

# Extract baseline feature_list from the first-commit version
BASELINE=$(git show "${FIRST_COMMIT}:.claude/kickoff.json" 2>/dev/null | jq -c '.feature_list // []' 2>/dev/null || echo "[]")
CURRENT=$(jq -c '.feature_list // []' "$STATE_FILE")

# If baseline is empty, no comparison possible
if [[ "$BASELINE" == "[]" ]]; then
    echo '{"status":"skipped","reason":"baseline feature_list empty"}'
    exit 0
fi

# Compare: for each id in baseline, check desc is unchanged in current
DIFF=$(jq -n \
    --argjson baseline "$BASELINE" \
    --argjson current "$CURRENT" \
    '
    [
      $baseline[] as $b
      | ($current | map(select(.id == $b.id)) | first) as $c
      | if $c == null then
          {id: $b.id, kind: "removed", baseline_desc: $b.desc}
        elif $c.desc != $b.desc then
          {id: $b.id, kind: "desc_changed", baseline_desc: $b.desc, current_desc: $c.desc}
        else empty end
    ]
    ')

VIOLATION_COUNT=$(echo "$DIFF" | jq 'length')

if [[ "$VIOLATION_COUNT" -eq 0 ]]; then
    echo '{"status":"pass","warnings":0}'
    exit 0
fi

# Emit warnings to stderr (non-fatal)
echo "WARNING: kickoff.json feature_list immutability violations detected:" >&2
echo "$DIFF" | jq -r '.[] | "  - \(.id): \(.kind) (baseline: \"\(.baseline_desc)\"\(if .current_desc then ", current: \"" + .current_desc + "\"" else "" end))"' >&2

# Exit 0 (warning-only, non-fatal per design)
jq -n --argjson warnings "$VIOLATION_COUNT" --argjson diff "$DIFF" \
    '{status: "warning", warnings: $warnings, violations: $diff}'
exit 0
