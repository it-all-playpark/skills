#!/usr/bin/env bash
# validate-decomposition.sh - Validate v2 child-split flow.json
#
# Checks:
#   - schema version == 2.0.0 (no v1 fallback — no-backcompat)
#   - parent issue is positive integer
#   - integration_branch.name matches required pattern
#   - children list non-empty and unique by issue number
#   - each child has required fields
#   - batches reference only declared children, with no duplicates
#   - batch numbers are 1-indexed and contiguous (no gaps)
#   - max_child_issues respected (soft / hard from skill-config)
#
# Usage: validate-decomposition.sh --flow-state PATH
# Returns JSON: {valid, version, child_count, batch_count, errors, warnings}
# Exit codes: 0 = valid, 1 = validation errors, 2 = script error

set -uo pipefail

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

# Parse JSON; surface parse errors
if ! jq -e . "$FLOW_STATE" >/dev/null 2>&1; then
    die_json "flow.json is not valid JSON: $FLOW_STATE" 2
fi

ERRORS=()
WARNINGS=()

# ---------------- Schema version (no-backcompat) ----------------

VERSION=$(jq -r '.version // empty' "$FLOW_STATE")
if [[ "$VERSION" != "2.0.0" ]]; then
    ERRORS+=("Schema version must be \"2.0.0\" (got: \"$VERSION\"). v1 format is not supported (no-backcompat).")
fi

# Detect explicit v1 markers and surface a clearer error
if jq -e 'has("subtasks") or has("contract") or has("shared_findings")' "$FLOW_STATE" >/dev/null 2>&1; then
    ERRORS+=("flow.json contains v1-only fields (subtasks / contract / shared_findings). v1 is rejected.")
fi

# ---------------- Required top-level fields ----------------

for f in issue status integration_branch children batches config; do
    if ! jq -e "has(\"$f\")" "$FLOW_STATE" >/dev/null 2>&1; then
        ERRORS+=("Missing required field: $f")
    fi
done

ISSUE=$(jq -r '.issue // empty' "$FLOW_STATE")
if ! [[ "$ISSUE" =~ ^[0-9]+$ ]]; then
    ERRORS+=("Field 'issue' must be a positive integer (got: \"$ISSUE\")")
fi

# ---------------- integration_branch ----------------

IB_NAME=$(jq -r '.integration_branch.name // empty' "$FLOW_STATE")
if [[ -n "$IB_NAME" ]] && [[ ! "$IB_NAME" =~ ^integration/issue-[0-9]+-[a-z0-9-]+$ ]]; then
    ERRORS+=("integration_branch.name does not match pattern integration/issue-{N}-{slug}: $IB_NAME")
fi

IB_BASE=$(jq -r '.integration_branch.base // empty' "$FLOW_STATE")
if [[ -z "$IB_BASE" ]]; then
    ERRORS+=("integration_branch.base is required")
fi

# ---------------- Children ----------------

CHILD_COUNT=$(jq '.children | length' "$FLOW_STATE" 2>/dev/null || echo 0)
if [[ "$CHILD_COUNT" -eq 0 ]]; then
    ERRORS+=("children array must have at least 1 entry")
fi

# Each child must have integer issue, non-empty slug+scope
INVALID_CHILDREN=$(jq -r '
  .children[]? as $c |
  (
    if ($c.issue // null) == null or ($c.issue | type) != "number" then "child missing/invalid issue"
    elif ($c.slug // "") == "" then "child #\($c.issue) missing slug"
    elif ($c.scope // "") == "" then "child #\($c.issue) missing scope"
    elif ($c.status | IN("pending","running","completed","failed") | not) then "child #\($c.issue) invalid status: \($c.status)"
    else empty end
  )
' "$FLOW_STATE" 2>/dev/null || echo "")
if [[ -n "$INVALID_CHILDREN" ]]; then
    while IFS= read -r e; do [[ -n "$e" ]] && ERRORS+=("$e"); done <<< "$INVALID_CHILDREN"
fi

# Duplicate children
DUP_CHILDREN=$(jq -r '[.children[].issue] | group_by(.) | map(select(length > 1) | .[0]) | .[]' "$FLOW_STATE" 2>/dev/null || echo "")
if [[ -n "$DUP_CHILDREN" ]]; then
    while IFS= read -r c; do [[ -n "$c" ]] && ERRORS+=("Duplicate child issue: $c"); done <<< "$DUP_CHILDREN"
fi

# Parent must not be in children list
PARENT_IN_CHILDREN=$(jq -r --argjson p "${ISSUE:-0}" '.children[]? | select(.issue == $p) | .issue' "$FLOW_STATE" 2>/dev/null || echo "")
if [[ -n "$PARENT_IN_CHILDREN" ]]; then
    ERRORS+=("Parent issue #$ISSUE must not appear in children list")
fi

# ---------------- Batches ----------------

BATCH_COUNT=$(jq '.batches | length' "$FLOW_STATE" 2>/dev/null || echo 0)
if [[ "$BATCH_COUNT" -eq 0 ]]; then
    ERRORS+=("batches array must have at least 1 entry")
fi

# Validate batch numbers: 1-indexed, contiguous, unique
BATCH_NUMS=$(jq -r '.batches[]?.batch' "$FLOW_STATE" 2>/dev/null | sort -n | tr '\n' ' ')
if [[ -n "$BATCH_NUMS" ]]; then
    EXPECTED=1
    for n in $BATCH_NUMS; do
        if [[ "$n" != "$EXPECTED" ]]; then
            ERRORS+=("Batch numbers must be 1-indexed and contiguous (expected $EXPECTED, got $n)")
            break
        fi
        EXPECTED=$((EXPECTED + 1))
    done
fi

# Validate batch mode
INVALID_MODES=$(jq -r '.batches[]? | select(.mode | IN("serial","parallel") | not) | "batch \(.batch): invalid mode \"\(.mode)\""' "$FLOW_STATE" 2>/dev/null || echo "")
if [[ -n "$INVALID_MODES" ]]; then
    while IFS= read -r e; do [[ -n "$e" ]] && ERRORS+=("$e"); done <<< "$INVALID_MODES"
fi

# Validate batch children are declared and not duplicated across batches
ALL_CHILDREN_DECLARED=$(jq -r '.children[].issue' "$FLOW_STATE" 2>/dev/null | sort -n)
ALL_CHILDREN_IN_BATCHES=$(jq -r '.batches[]?.children[]?' "$FLOW_STATE" 2>/dev/null | sort -n)

# Children referenced in batches must exist in children[]
UNDECLARED=$(comm -23 <(echo "$ALL_CHILDREN_IN_BATCHES" | sort -u) <(echo "$ALL_CHILDREN_DECLARED" | sort -u) 2>/dev/null || echo "")
if [[ -n "$UNDECLARED" ]]; then
    while IFS= read -r c; do [[ -n "$c" ]] && ERRORS+=("Batch references child #$c not in children[]"); done <<< "$UNDECLARED"
fi

# All declared children must be in some batch
MISSING_BATCH=$(comm -23 <(echo "$ALL_CHILDREN_DECLARED" | sort -u) <(echo "$ALL_CHILDREN_IN_BATCHES" | sort -u) 2>/dev/null || echo "")
if [[ -n "$MISSING_BATCH" ]]; then
    while IFS= read -r c; do [[ -n "$c" ]] && WARNINGS+=("Child #$c is declared but not assigned to any batch"); done <<< "$MISSING_BATCH"
fi

# Children must not appear in multiple batches
DUP_IN_BATCHES=$(echo "$ALL_CHILDREN_IN_BATCHES" | sort -n | uniq -d)
if [[ -n "$DUP_IN_BATCHES" ]]; then
    while IFS= read -r c; do [[ -n "$c" ]] && ERRORS+=("Child #$c appears in multiple batches"); done <<< "$DUP_IN_BATCHES"
fi

# ---------------- max_child_issues (soft / hard) ----------------

MAX_SOFT=$(jq -r '."dev-decompose".max_child_issues_soft // 8' \
    "${SKILLS_DIR:-}/skill-config.json" 2>/dev/null || echo 8)
MAX_HARD=$(jq -r '."dev-decompose".max_child_issues_hard // 12' \
    "${SKILLS_DIR:-}/skill-config.json" 2>/dev/null || echo 12)

if [[ "$CHILD_COUNT" -gt "$MAX_HARD" ]]; then
    ERRORS+=("Child count $CHILD_COUNT exceeds max_child_issues_hard ($MAX_HARD)")
elif [[ "$CHILD_COUNT" -gt "$MAX_SOFT" ]]; then
    WARNINGS+=("Child count $CHILD_COUNT exceeds max_child_issues_soft ($MAX_SOFT); consider splitting parent")
fi

# ---------------- Result ----------------

ERROR_COUNT=${#ERRORS[@]}
WARNING_COUNT=${#WARNINGS[@]}

if [[ $ERROR_COUNT -eq 0 ]]; then
    VALID="true"
    EXIT_CODE=0
else
    VALID="false"
    EXIT_CODE=1
fi

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
    --arg version "$VERSION" \
    --argjson child_count "$CHILD_COUNT" \
    --argjson batch_count "$BATCH_COUNT" \
    --argjson error_count "$ERROR_COUNT" \
    --argjson warning_count "$WARNING_COUNT" \
    --argjson errors "$ERRORS_JSON" \
    --argjson warnings "$WARNINGS_JSON" \
    '{
        valid: $valid,
        version: $version,
        child_count: $child_count,
        batch_count: $batch_count,
        error_count: $error_count,
        warning_count: $warning_count,
        errors: $errors,
        warnings: $warnings
    }'

exit $EXIT_CODE
