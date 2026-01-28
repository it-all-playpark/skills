#!/usr/bin/env bash
# analyze-changes.sh - Analyze staged changes and compute complexity score
# Usage: analyze-changes.sh [--worktree <path>]
#
# Output: JSON with metrics, score, and recommended model

set -euo pipefail

WORKTREE_PATH=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --worktree) WORKTREE_PATH="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: analyze-changes.sh [--worktree <path>]"
            exit 0
            ;;
        *) shift ;;
    esac
done

# Set working directory
if [[ -n "$WORKTREE_PATH" ]]; then
    cd "$WORKTREE_PATH"
fi

# Get staged diff stats
STAT_OUTPUT=$(git diff --staged --stat 2>/dev/null || echo "")

if [[ -z "$STAT_OUTPUT" ]]; then
    echo '{"error":"no_staged_changes","score":0,"model":"self"}'
    exit 0
fi

# Parse metrics
FILES_CHANGED=$(echo "$STAT_OUTPUT" | grep -oE '[0-9]+ file' | grep -oE '[0-9]+' || echo "0")
LINES_CHANGED=$(git diff --staged --numstat 2>/dev/null | awk '{sum+=$1+$2} END {print sum+0}')

# Count directories affected
DIRS_AFFECTED=$(git diff --staged --name-only 2>/dev/null | xargs -I{} dirname {} | sort -u | wc -l | tr -d ' ')

# Detect change types from diff
DIFF_CONTENT=$(git diff --staged 2>/dev/null || echo "")
CHANGE_TYPES=0

# Check for various change patterns
[[ "$DIFF_CONTENT" =~ "function"|"const"|"class"|"def " ]] && ((CHANGE_TYPES+=1)) || true  # feat/code
[[ "$DIFF_CONTENT" =~ "fix"|"bug"|"error"|"issue" ]] && ((CHANGE_TYPES+=1)) || true  # fix
[[ "$DIFF_CONTENT" =~ "refactor"|"rename"|"move" ]] && ((CHANGE_TYPES+=1)) || true  # refactor
[[ "$DIFF_CONTENT" =~ "test"|"spec"|"describe"|"it(" ]] && ((CHANGE_TYPES+=1)) || true  # test
[[ "$DIFF_CONTENT" =~ "README"|"docs"|"comment"|"@param"|"@return" ]] && ((CHANGE_TYPES+=1)) || true  # docs

# Ensure at least 1 change type
[[ $CHANGE_TYPES -eq 0 ]] && CHANGE_TYPES=1

# Calculate complexity score (0-8)
SCORE=0

# Files changed: 1-2 = 0, 3-7 = 1, 8+ = 2
if [[ $FILES_CHANGED -ge 8 ]]; then
    SCORE=$((SCORE + 2))
elif [[ $FILES_CHANGED -ge 3 ]]; then
    SCORE=$((SCORE + 1))
fi

# Lines changed: ≤50 = 0, 51-200 = 1, 200+ = 2
if [[ $LINES_CHANGED -gt 200 ]]; then
    SCORE=$((SCORE + 2))
elif [[ $LINES_CHANGED -gt 50 ]]; then
    SCORE=$((SCORE + 1))
fi

# Directories: 1 = 0, 2-3 = 1, 4+ = 2
if [[ $DIRS_AFFECTED -ge 4 ]]; then
    SCORE=$((SCORE + 2))
elif [[ $DIRS_AFFECTED -ge 2 ]]; then
    SCORE=$((SCORE + 1))
fi

# Change types: 1 = 0, 2 = 1, 3+ = 2
if [[ $CHANGE_TYPES -ge 3 ]]; then
    SCORE=$((SCORE + 2))
elif [[ $CHANGE_TYPES -ge 2 ]]; then
    SCORE=$((SCORE + 1))
fi

# Determine recommended model
if [[ $SCORE -le 1 ]]; then
    MODEL="self"
elif [[ $SCORE -le 4 ]]; then
    MODEL="sonnet"
else
    MODEL="opus"
fi

# Get recent commit style for reference
RECENT_COMMITS=$(git log --oneline -5 2>/dev/null | head -5 || echo "")

# Detect primary scope from changed files
PRIMARY_DIR=$(git diff --staged --name-only 2>/dev/null | head -1 | xargs dirname 2>/dev/null || echo ".")
SCOPE=""
case "$PRIMARY_DIR" in
    src/auth*|**/auth*) SCOPE="auth" ;;
    src/api*|**/api*) SCOPE="api" ;;
    src/ui*|**/ui*|components*) SCOPE="ui" ;;
    lib*) SCOPE="lib" ;;
    test*|__test__*) SCOPE="test" ;;
    docs*) SCOPE="docs" ;;
    *) SCOPE=$(basename "$PRIMARY_DIR" 2>/dev/null || echo "") ;;
esac

# Output JSON
cat <<EOF
{
  "metrics": {
    "files": $FILES_CHANGED,
    "lines": $LINES_CHANGED,
    "directories": $DIRS_AFFECTED,
    "change_types": $CHANGE_TYPES
  },
  "score": $SCORE,
  "model": "$MODEL",
  "suggested_scope": "$SCOPE",
  "recent_commits": $(echo "$RECENT_COMMITS" | jq -R -s 'split("\n") | map(select(length > 0))' 2>/dev/null || echo "[]")
}
EOF
