#!/usr/bin/env bash
# merge-subtasks.sh - Merge subtask branches in dependency order
# Usage: merge-subtasks.sh --flow-state PATH [--worktree PATH]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq
require_git_repo

FLOW_STATE=""
WORKTREE=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        --worktree) WORKTREE="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: merge-subtasks.sh --flow-state PATH [--worktree PATH]"
            exit 0
            ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

[[ -n "$FLOW_STATE" ]] || die_json "flow.json path required (--flow-state)" 1
[[ -f "$FLOW_STATE" ]] || die_json "flow.json not found at: $FLOW_STATE" 1

# Change to worktree if specified
if [[ -n "$WORKTREE" ]]; then
    [[ -d "$WORKTREE" ]] || die_json "Worktree path does not exist: $WORKTREE" 1
    cd "$WORKTREE"
fi

# ============================================================================
# Verify all subtasks are completed
# ============================================================================

INCOMPLETE=$(jq -r '.subtasks[] | select(.status != "completed") | .id' "$FLOW_STATE")
if [[ -n "$INCOMPLETE" ]]; then
    INCOMPLETE_LIST=$(echo "$INCOMPLETE" | tr '\n' ',' | sed 's/,$//')
    die_json "Subtasks not completed: $INCOMPLETE_LIST" 1
fi

# ============================================================================
# Topological sort: compute merge order from depends_on
# ============================================================================

LIB_DIR="$(cd "$SCRIPT_DIR/../../_lib/scripts" && pwd)"
MERGE_ORDER=$("$LIB_DIR/topo-sort.sh" --flow-state "$FLOW_STATE")

TASK_COUNT=$(echo "$MERGE_ORDER" | jq 'length')
if [[ "$TASK_COUNT" -eq 0 ]]; then
    die_json "No subtasks found for merging" 1
fi

# ============================================================================
# Merge each subtask branch
# ============================================================================

MERGE_RESULTS="[]"
OVERALL_STATUS="success"
MERGED_COUNT=0
CONFLICT_COUNT=0

for i in $(seq 0 $((TASK_COUNT - 1))); do
    TASK_ID=$(echo "$MERGE_ORDER" | jq -r ".[$i].id")
    TASK_BRANCH=$(echo "$MERGE_ORDER" | jq -r ".[$i].branch")
    TASK_SCOPE=$(echo "$MERGE_ORDER" | jq -r ".[$i].scope // \"\"")

    # Validate branch exists
    if ! git show-ref --verify --quiet "refs/heads/$TASK_BRANCH" 2>/dev/null && \
       ! git show-ref --verify --quiet "refs/remotes/origin/$TASK_BRANCH" 2>/dev/null; then
        MERGE_RESULTS=$(echo "$MERGE_RESULTS" | jq \
            --arg id "$TASK_ID" \
            --arg branch "$TASK_BRANCH" \
            '. += [{"task_id": $id, "branch": $branch, "status": "error", "error": "branch not found"}]')
        OVERALL_STATUS="failed"
        continue
    fi

    # Attempt merge
    MERGE_MSG="merge: integrate $TASK_ID ($TASK_SCOPE)"
    if git merge --no-ff "$TASK_BRANCH" -m "$MERGE_MSG" 2>/dev/null; then
        MERGED_COUNT=$((MERGED_COUNT + 1))
        MERGE_RESULTS=$(echo "$MERGE_RESULTS" | jq \
            --arg id "$TASK_ID" \
            --arg branch "$TASK_BRANCH" \
            '. += [{"task_id": $id, "branch": $branch, "status": "merged"}]')
    else
        # Merge conflict detected
        CONFLICT_FILES=$(git diff --name-only --diff-filter=U 2>/dev/null || echo "")
        CONFLICT_COUNT=$((CONFLICT_COUNT + 1))

        if [[ -z "$CONFLICT_FILES" ]]; then
            # Merge failed but no conflict markers -- unexpected error
            git merge --abort 2>/dev/null || true
            MERGE_RESULTS=$(echo "$MERGE_RESULTS" | jq \
                --arg id "$TASK_ID" \
                --arg branch "$TASK_BRANCH" \
                '. += [{"task_id": $id, "branch": $branch, "status": "error", "error": "merge failed unexpectedly"}]')
            OVERALL_STATUS="failed"
            continue
        fi

        # Attempt auto-resolution for non-code files (configs, lock files, etc.)
        AUTO_RESOLVED=true
        while IFS= read -r conflict_file; do
            [[ -z "$conflict_file" ]] && continue
            case "$conflict_file" in
                *.lock|*.sum|package-lock.json|yarn.lock|pnpm-lock.yaml)
                    # Accept theirs for lock files
                    git checkout --theirs "$conflict_file" 2>/dev/null && \
                        git add "$conflict_file" 2>/dev/null || AUTO_RESOLVED=false
                    ;;
                *)
                    # Cannot auto-resolve code files
                    AUTO_RESOLVED=false
                    ;;
            esac
        done <<< "$CONFLICT_FILES"

        if [[ "$AUTO_RESOLVED" == true ]]; then
            # All conflicts auto-resolved, complete the merge
            git commit --no-edit 2>/dev/null || true
            MERGE_RESULTS=$(echo "$MERGE_RESULTS" | jq \
                --arg id "$TASK_ID" \
                --arg branch "$TASK_BRANCH" \
                --arg files "$CONFLICT_FILES" \
                '. += [{"task_id": $id, "branch": $branch, "status": "merged_auto_resolved", "conflict_files": ($files | split("\n") | map(select(. != "")))}]')
        else
            # Unresolvable conflicts -- abort and report
            CONFLICT_JSON=$(echo "$CONFLICT_FILES" | json_array)
            git merge --abort 2>/dev/null || true
            MERGE_RESULTS=$(echo "$MERGE_RESULTS" | jq \
                --arg id "$TASK_ID" \
                --arg branch "$TASK_BRANCH" \
                --argjson files "$CONFLICT_JSON" \
                '. += [{"task_id": $id, "branch": $branch, "status": "conflict", "conflict_files": $files}]')
            OVERALL_STATUS="failed"

            # Stop on unresolvable conflict -- user intervention needed
            break
        fi
    fi
done

# ============================================================================
# Output results
# ============================================================================

jq -n \
    --arg status "$OVERALL_STATUS" \
    --argjson merged "$MERGED_COUNT" \
    --argjson conflicts "$CONFLICT_COUNT" \
    --argjson total "$TASK_COUNT" \
    --argjson results "$MERGE_RESULTS" \
    '{
        status: $status,
        total_subtasks: $total,
        merged: $merged,
        conflicts: $conflicts,
        results: $results
    }'
