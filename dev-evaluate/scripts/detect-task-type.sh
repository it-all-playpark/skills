#!/usr/bin/env bash
# detect-task-type.sh - Detect task type from issue type and diff patterns
# Usage: detect-task-type.sh --worktree <path> [--issue-type <type>]
# Output: JSON { "task_type": "frontend|api|refactor|infrastructure|generic", "source": "issue|diff" }

set -euo pipefail

WORKTREE=""
ISSUE_TYPE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree) WORKTREE="$2"; shift 2 ;;
        --issue-type) ISSUE_TYPE="$2"; shift 2 ;;
        *) shift ;;
    esac
done

[[ -n "$WORKTREE" ]] || { echo '{"task_type":"generic","source":"default"}'; exit 0; }

# Priority 1: Issue type from dev-issue-analyze
if [[ -n "$ISSUE_TYPE" ]]; then
    case "$ISSUE_TYPE" in
        refactor*) echo '{"task_type":"refactor","source":"issue"}'; exit 0 ;;
    esac
fi

# Priority 2: Diff file pattern analysis
cd "$WORKTREE" 2>/dev/null || { echo '{"task_type":"generic","source":"default"}'; exit 0; }

DIFF_FILES=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only HEAD 2>/dev/null || echo "")

if [[ -z "$DIFF_FILES" ]]; then
    echo '{"task_type":"generic","source":"default"}'
    exit 0
fi

# Count files matching each pattern
FRONTEND_COUNT=$(echo "$DIFF_FILES" | grep -cE '(components/|\.tsx$|\.vue$|\.svelte$|\.css$|\.scss$)' || echo 0)
API_COUNT=$(echo "$DIFF_FILES" | grep -cE '(routes/|api/|controller|handler|endpoint|\.resolver\.)' || echo 0)
INFRA_COUNT=$(echo "$DIFF_FILES" | grep -cE '(Dockerfile|\.tf$|\.ya?ml$|\.toml$|helm/|k8s/|\.github/)' || echo 0)

# Determine by majority
if [[ "$FRONTEND_COUNT" -gt 0 && "$FRONTEND_COUNT" -ge "$API_COUNT" && "$FRONTEND_COUNT" -ge "$INFRA_COUNT" ]]; then
    echo '{"task_type":"frontend","source":"diff"}'
elif [[ "$API_COUNT" -gt 0 && "$API_COUNT" -ge "$FRONTEND_COUNT" && "$API_COUNT" -ge "$INFRA_COUNT" ]]; then
    echo '{"task_type":"api","source":"diff"}'
elif [[ "$INFRA_COUNT" -gt 0 && "$INFRA_COUNT" -ge "$FRONTEND_COUNT" && "$INFRA_COUNT" -ge "$API_COUNT" ]]; then
    echo '{"task_type":"infrastructure","source":"diff"}'
else
    echo '{"task_type":"generic","source":"diff"}'
fi
