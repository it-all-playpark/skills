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

# 5. Check for circular dependencies (topological sort via DFS)
CIRCULAR=$(jq -r '
  def has_cycle:
    . as $tasks |
    ($tasks | map({(.id): .depends_on}) | add // {}) as $deps |
    ($tasks | map(.id)) as $all_ids |
    # Check each node for cycles via path tracking
    reduce $all_ids[] as $start (
      {has_cycle: false, cycle_path: []};
      if .has_cycle then .
      else
        # BFS-style cycle detection
        {visited: [], stack: [$start], has_cycle: false, cycle_path: []} |
        until(.stack | length == 0 or .has_cycle;
          .stack[-1] as $current |
          if (.visited | index($current)) != null then
            .has_cycle = true | .cycle_path = .visited + [$current]
          else
            .visited += [$current] |
            .stack = .stack[:-1] + ($deps[$current] // [])
          end
        )
      end
    ) | .has_cycle;
  .subtasks | has_cycle
' "$FLOW_STATE" 2>/dev/null || echo "false")

if [[ "$CIRCULAR" == "true" ]]; then
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

# Output JSON
{
    echo "{"
    echo "  \"valid\": $VALID,"
    echo "  \"subtask_count\": $SUBTASK_COUNT,"
    echo "  \"error_count\": $ERROR_COUNT,"
    echo "  \"warning_count\": $WARNING_COUNT,"

    # Errors array
    echo -n "  \"errors\": ["
    for i in "${!ERRORS[@]}"; do
        [[ $i -gt 0 ]] && echo -n ","
        printf '%s' "$(json_escape "${ERRORS[$i]}")"
    done
    echo "],"

    # Warnings array
    echo -n "  \"warnings\": ["
    for i in "${!WARNINGS[@]}"; do
        [[ $i -gt 0 ]] && echo -n ","
        printf '%s' "$(json_escape "${WARNINGS[$i]}")"
    done
    echo "]"

    echo "}"
}

exit $EXIT_CODE
