#!/usr/bin/env bash
# validate-decomposition.sh - Validate subtask decomposition in flow.json
# Checks: no file overlap, no missing files, no circular dependencies, subtask count
# Usage: validate-decomposition.sh --flow-state PATH
#
# Returns JSON with validation result and any errors found.
# Exit code 0 = valid, 1 = validation errors, 2 = script error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common.sh"

require_cmd jq

FLOW_STATE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: validate-decomposition.sh --flow-state PATH"
            exit 0
            ;;
        *) die_json "Unknown option: $1" 2 ;;
    esac
done

[[ -n "$FLOW_STATE" ]] || die_json "flow.json path required (--flow-state)" 2
[[ -f "$FLOW_STATE" ]] || die_json "flow.json not found at: $FLOW_STATE" 2

ERRORS=()
WARNINGS=()

# 1. Check subtask count
SUBTASK_COUNT=$(jq '.subtasks | length' "$FLOW_STATE")
if [[ "$SUBTASK_COUNT" -eq 0 ]]; then
    ERRORS+=("No subtasks defined")
elif [[ "$SUBTASK_COUNT" -eq 1 ]]; then
    WARNINGS+=("Only 1 subtask: consider fallback to single-worktree mode")
fi

# 2. Check each subtask has at least 1 checklist item
EMPTY_CHECKLISTS=$(jq -r '.subtasks[] | select((.checklist | length) == 0) | .id' "$FLOW_STATE")
if [[ -n "$EMPTY_CHECKLISTS" ]]; then
    while IFS= read -r task_id; do
        ERRORS+=("Subtask $task_id has no checklist items")
    done <<< "$EMPTY_CHECKLISTS"
fi

# 3. Check for file overlap between subtasks
DUPLICATES=$(jq -r '
  [.subtasks[].files[]] | group_by(.) | map(select(length > 1)) | map(.[0]) | .[]
' "$FLOW_STATE" 2>/dev/null || echo "")
if [[ -n "$DUPLICATES" ]]; then
    while IFS= read -r file; do
        # Find which subtasks contain this file
        TASKS=$(jq -r --arg f "$file" '.subtasks[] | select(.files[] == $f) | .id' "$FLOW_STATE" | tr '\n' ',' | sed 's/,$//')
        ERRORS+=("File '$file' assigned to multiple subtasks: $TASKS")
    done <<< "$DUPLICATES"
fi

# 4. Check all affected_files are assigned to a subtask
AFFECTED=$(jq -r '.analysis.affected_files[]? // empty' "$FLOW_STATE" | sort)
ASSIGNED=$(jq -r '.subtasks[].files[]' "$FLOW_STATE" | sort)

if [[ -n "$AFFECTED" ]]; then
    MISSING=$(comm -23 <(echo "$AFFECTED") <(echo "$ASSIGNED") 2>/dev/null || echo "")
    if [[ -n "$MISSING" ]]; then
        while IFS= read -r file; do
            [[ -n "$file" ]] && WARNINGS+=("Affected file '$file' not assigned to any subtask")
        done <<< "$MISSING"
    fi
fi

# 5. Check for circular dependencies (using shared topo-sort)
if ! "$SCRIPT_DIR/topo-sort.sh" --flow-state "$FLOW_STATE" >/dev/null 2>&1; then
    ERRORS+=("Circular dependency detected in subtask depends_on")
fi

# 6. Check depends_on references valid subtask IDs
INVALID_DEPS=$(jq -r '
  (.subtasks | map(.id)) as $valid_ids |
  .subtasks[] |
  .id as $task_id |
  (.depends_on // [])[] |
  select(. as $dep | $valid_ids | index($dep) | not) |
  "\($task_id) -> \(.)"
' "$FLOW_STATE" 2>/dev/null || echo "")

if [[ -n "$INVALID_DEPS" ]]; then
    while IFS= read -r dep; do
        [[ -n "$dep" ]] && ERRORS+=("Invalid dependency reference: $dep")
    done <<< "$INVALID_DEPS"
fi

# Build result
ERROR_COUNT=${#ERRORS[@]}
WARNING_COUNT=${#WARNINGS[@]}

if [[ $ERROR_COUNT -eq 0 ]]; then
    VALID="true"
    EXIT_CODE=0
else
    VALID="false"
    EXIT_CODE=1
fi

# Output JSON using jq
ERRORS_JSON="[]"
for err in "${ERRORS[@]}"; do
    ERRORS_JSON=$(echo "$ERRORS_JSON" | jq --arg e "$err" '. += [$e]')
done

WARNINGS_JSON="[]"
for warn in "${WARNINGS[@]}"; do
    WARNINGS_JSON=$(echo "$WARNINGS_JSON" | jq --arg w "$warn" '. += [$w]')
done

jq -n \
    --argjson valid "$VALID" \
    --argjson subtask_count "$SUBTASK_COUNT" \
    --argjson error_count "$ERROR_COUNT" \
    --argjson warning_count "$WARNING_COUNT" \
    --argjson errors "$ERRORS_JSON" \
    --argjson warnings "$WARNINGS_JSON" \
    '{
        valid: $valid,
        subtask_count: $subtask_count,
        error_count: $error_count,
        warning_count: $warning_count,
        errors: $errors,
        warnings: $warnings
    }'

exit $EXIT_CODE
