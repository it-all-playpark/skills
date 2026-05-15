#!/usr/bin/env bash
# create-child-issues.sh - Create child GitHub issues from a parent split plan
#
# Reads a split plan (JSON) describing child issues with title / body / labels,
# creates each child via `gh issue create`, and returns the created issues as
# a JSON array compatible with flow.json v2 `children[]` shape.
#
# Usage:
#   create-child-issues.sh --parent N --plan PATH [--repo OWNER/REPO] [--dry-run]
#
# Plan JSON shape (input):
#   {
#     "children": [
#       {
#         "slug": "schema",
#         "title": "feat(_lib): schema migration",
#         "scope": "Add schema migration logic",
#         "body": "## Context\nfoo\n\n## Tasks\n- ...",
#         "labels": ["enhancement", "child-of-93"]
#       },
#       ...
#     ]
#   }
#
# Output JSON (stdout):
#   {
#     "status": "created|dry-run|failed",
#     "parent": N,
#     "children": [
#       {"issue": M, "slug": "schema", "scope": "...", "status": "pending"}
#     ]
#   }

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

PARENT=""
PLAN_PATH=""
REPO=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --parent) PARENT="$2"; shift 2 ;;
        --plan) PLAN_PATH="$2"; shift 2 ;;
        --repo) REPO="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        -h|--help)
            sed -n '2,30p' "$0"
            exit 0
            ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

[[ -n "$PARENT" ]] || die_json "--parent is required" 1
[[ "$PARENT" =~ ^[0-9]+$ ]] || die_json "--parent must be a positive integer" 1
[[ -n "$PLAN_PATH" ]] || die_json "--plan is required" 1
[[ -f "$PLAN_PATH" ]] || die_json "Plan JSON not found: $PLAN_PATH" 1

jq -e '.children | type == "array" and length > 0' "$PLAN_PATH" >/dev/null \
    || die_json "Plan must contain a non-empty children[] array" 1

# Enforce max_child_issues
SKILLS_REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MAX_HARD=$(jq -r '."dev-decompose".max_child_issues_hard // 12' \
    "$SKILLS_REPO_DIR/skill-config.json" 2>/dev/null || echo 12)
MAX_SOFT=$(jq -r '."dev-decompose".max_child_issues_soft // 8' \
    "$SKILLS_REPO_DIR/skill-config.json" 2>/dev/null || echo 8)

CHILD_COUNT=$(jq '.children | length' "$PLAN_PATH")
if [[ "$CHILD_COUNT" -gt "$MAX_HARD" ]]; then
    die_json "Child count $CHILD_COUNT exceeds max_child_issues_hard ($MAX_HARD)" 1
fi

if ! $DRY_RUN; then
    require_cmd gh
fi

# Iterate children and either dry-run print or actually create
CREATED="[]"
for i in $(seq 0 $((CHILD_COUNT - 1))); do
    CHILD=$(jq ".children[$i]" "$PLAN_PATH")
    SLUG=$(echo "$CHILD" | jq -r '.slug')
    TITLE=$(echo "$CHILD" | jq -r '.title')
    SCOPE=$(echo "$CHILD" | jq -r '.scope // .title')
    BODY=$(echo "$CHILD" | jq -r '.body // empty')
    LABELS=$(echo "$CHILD" | jq -r '.labels // [] | join(",")')

    # Prepend parent reference to body
    FULL_BODY=$(printf "Parent: #%s\n\n%s" "$PARENT" "$BODY")

    if $DRY_RUN; then
        ISSUE_NUM=0
    else
        REPO_ARGS=()
        [[ -n "$REPO" ]] && REPO_ARGS=(--repo "$REPO")
        LABEL_ARGS=()
        [[ -n "$LABELS" ]] && LABEL_ARGS=(--label "$LABELS")
        ISSUE_URL=$(gh issue create \
            "${REPO_ARGS[@]}" \
            "${LABEL_ARGS[@]}" \
            --title "$TITLE" \
            --body "$FULL_BODY" \
            2>&1) || {
            die_json "gh issue create failed for slug=$SLUG: $ISSUE_URL" 1
        }
        # Extract issue number from URL (last path segment)
        ISSUE_NUM=$(echo "$ISSUE_URL" | grep -oE '[0-9]+$' || echo 0)
        [[ "$ISSUE_NUM" =~ ^[0-9]+$ ]] || die_json "Could not parse issue number from: $ISSUE_URL" 1
    fi

    CREATED=$(echo "$CREATED" | jq \
        --argjson n "$ISSUE_NUM" \
        --arg slug "$SLUG" \
        --arg scope "$SCOPE" \
        '. += [{issue: $n, slug: $slug, scope: $scope, status: "pending", pr_number: null, pr_url: null, merged_at: null, error: null}]')
done

# Warning if exceeds soft limit
WARNING=""
if [[ "$CHILD_COUNT" -gt "$MAX_SOFT" ]]; then
    WARNING="child count $CHILD_COUNT exceeds max_child_issues_soft ($MAX_SOFT); consider splitting parent"
fi

STATUS="created"
$DRY_RUN && STATUS="dry-run"

jq -n \
    --arg status "$STATUS" \
    --argjson parent "$PARENT" \
    --argjson children "$CREATED" \
    --arg warning "$WARNING" \
    '{
        status: $status,
        parent: $parent,
        child_count: ($children | length),
        children: $children,
        warning: (if $warning == "" then null else $warning end)
    }'
