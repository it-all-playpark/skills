#!/usr/bin/env bash
# create-pr.sh - Create GitHub PR with structured description
# Usage: create-pr.sh <issue-number> [options]
#
# Options:
#   --base <branch>     Base branch (default: dev)
#   --worktree <path>   Worktree path
#
# Output: JSON with PR URL and details

set -euo pipefail

# Defaults
ISSUE_NUMBER=""
BASE_BRANCH="dev"
WORKTREE_PATH=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --base) BASE_BRANCH="$2"; shift 2 ;;
        --worktree) WORKTREE_PATH="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: create-pr.sh <issue-number> [--base <branch>] [--worktree <path>]"
            exit 0
            ;;
        -*)
            echo "Error: Unknown option $1" >&2
            exit 1
            ;;
        *)
            if [[ -z "$ISSUE_NUMBER" ]]; then
                ISSUE_NUMBER="$1"
            fi
            shift
            ;;
    esac
done

# Validate
if [[ -z "$ISSUE_NUMBER" ]]; then
    echo '{"error":"issue_number_required"}'
    exit 1
fi

# Set working directory
if [[ -n "$WORKTREE_PATH" ]]; then
    cd "$WORKTREE_PATH"
fi

WORK_DIR=$(pwd)
BRANCH_NAME=$(git branch --show-current)

# Get issue info
ISSUE_JSON=$(gh issue view "$ISSUE_NUMBER" --json title,labels 2>/dev/null || echo '{"title":"","labels":[]}')
ISSUE_TITLE=$(echo "$ISSUE_JSON" | jq -r '.title // ""')

# Determine PR title prefix from labels
LABELS=$(echo "$ISSUE_JSON" | jq -r '.labels[].name // empty' 2>/dev/null || echo "")
PREFIX="✨"
if echo "$LABELS" | grep -qi "bug"; then
    PREFIX="🐛 fix:"
elif echo "$LABELS" | grep -qi "enhancement"; then
    PREFIX="✨ feat:"
elif echo "$LABELS" | grep -qi "refactor"; then
    PREFIX="♻️ refactor:"
elif echo "$LABELS" | grep -qi "docs"; then
    PREFIX="📝 docs:"
fi

TITLE="$PREFIX $ISSUE_TITLE (#$ISSUE_NUMBER)"

PR_BODY=$(cat <<EOF
## 🎯 対応Issue
Fixes #$ISSUE_NUMBER

## 📋 変更内容
- **ブランチ**: $BRANCH_NAME

## ✅ チェックリスト
- [ ] テストが通過している
- [ ] コード品質が検証されている
- [ ] ドキュメントが更新されている（必要な場合）
- [ ] レビュー準備完了
EOF
)

# Create PR
PR_URL=$(gh pr create \
    --title "$TITLE" \
    --body "$PR_BODY" \
    --base "$BASE_BRANCH" \
    --head "$BRANCH_NAME" \
    --assignee @me \
    2>&1) || {
    echo "{\"error\":\"pr_creation_failed\",\"message\":\"$PR_URL\"}"
    exit 1
}

# Output JSON result
cat <<EOF
{
  "status": "created",
  "pr_url": "$PR_URL",
  "title": "$TITLE",
  "branch": "$BRANCH_NAME",
  "base": "$BASE_BRANCH",
  "issue": $ISSUE_NUMBER,
  "worktree": "$WORK_DIR"
}
EOF
