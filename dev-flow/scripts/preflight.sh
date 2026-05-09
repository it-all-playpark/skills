#!/usr/bin/env bash
# preflight.sh - Verify dev-flow prerequisites before mode decision
# Read-only checks: issue exists & open, gh auth valid
# Does NOT call git-prepare or modify any state
#
# Usage: preflight.sh <issue-number> [--strict|--warn-only] [--repo OWNER/REPO]
#
# Exit codes:
#   0  = all checks passed (or --warn-only with warnings)
#   1  = generic failure
#   10 = issue check failed (--strict only)
#   11 = gh auth check failed (--strict only)
#
# Output: single-line JSON to stdout
#   {"status":"ok|warn|error","mode":"strict|warn-only","checks":{...},"warnings":[...],"errors":[...]}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

ISSUE_NUMBER=""
MODE="warn-only"
REPO=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --strict) MODE="strict"; shift ;;
        --warn-only) MODE="warn-only"; shift ;;
        --repo) REPO="$2"; shift 2 ;;
        -h|--help)
            cat <<EOF
Usage: preflight.sh <issue-number> [--strict|--warn-only] [--repo OWNER/REPO]

Read-only verification of dev-flow prerequisites.

Options:
  --warn-only  (default) emit warnings but exit 0
  --strict     exit non-zero on any failure
  --repo       override repository (default: current repo)
EOF
            exit 0
            ;;
        -*) die_json "Unknown option: $1" 1 ;;
        *)
            [[ -z "$ISSUE_NUMBER" ]] && ISSUE_NUMBER="$1"
            shift
            ;;
    esac
done

[[ -z "$ISSUE_NUMBER" ]] && die_json "Issue number required" 1
[[ "$ISSUE_NUMBER" =~ ^[0-9]+$ ]] || die_json "Issue number must be numeric: $ISSUE_NUMBER" 1

WARNINGS=()
ERRORS=()
GH_AUTH_OK=false
ISSUE_EXISTS=false
ISSUE_OPEN=false
ISSUE_TITLE=""
ISSUE_STATE=""

# ----------------------------------------------------------------------------
# Check 1: gh auth
# ----------------------------------------------------------------------------
if ! command -v gh &>/dev/null; then
    ERRORS+=("gh CLI not installed (brew install gh)")
elif gh auth token &>/dev/null; then
    GH_AUTH_OK=true
else
    ERRORS+=("gh CLI not authenticated (run: gh auth login)")
fi

# ----------------------------------------------------------------------------
# Check 2: issue exists & open
# Skipped if gh auth failed (cannot query without auth)
# ----------------------------------------------------------------------------
if [[ "$GH_AUTH_OK" == true ]]; then
    GH_ARGS=(issue view "$ISSUE_NUMBER" --json state,title)
    [[ -n "$REPO" ]] && GH_ARGS+=(--repo "$REPO")

    if ISSUE_JSON=$(gh "${GH_ARGS[@]}" 2>/dev/null); then
        ISSUE_EXISTS=true
        ISSUE_STATE=$(echo "$ISSUE_JSON" | jq -r '.state // ""')
        ISSUE_TITLE=$(echo "$ISSUE_JSON" | jq -r '.title // ""')
        if [[ "$ISSUE_STATE" == "OPEN" ]]; then
            ISSUE_OPEN=true
        else
            WARNINGS+=("Issue #$ISSUE_NUMBER is $ISSUE_STATE (not OPEN)")
        fi
    else
        ERRORS+=("Issue #$ISSUE_NUMBER not found or inaccessible")
    fi
else
    WARNINGS+=("Issue check skipped due to gh auth failure")
fi

# ----------------------------------------------------------------------------
# Compose result
# ----------------------------------------------------------------------------
HAS_ERRORS=$([ ${#ERRORS[@]} -gt 0 ] && echo true || echo false)
HAS_WARNINGS=$([ ${#WARNINGS[@]} -gt 0 ] && echo true || echo false)

if [[ "$HAS_ERRORS" == true ]]; then
    STATUS="error"
elif [[ "$HAS_WARNINGS" == true ]]; then
    STATUS="warn"
else
    STATUS="ok"
fi

# Build JSON output
warnings_json=$(printf '%s\n' "${WARNINGS[@]:-}" | jq -R . | jq -s 'map(select(. != ""))')
errors_json=$(printf '%s\n' "${ERRORS[@]:-}" | jq -R . | jq -s 'map(select(. != ""))')

jq -n \
    --arg status "$STATUS" \
    --arg mode "$MODE" \
    --arg issue "$ISSUE_NUMBER" \
    --arg issue_title "$ISSUE_TITLE" \
    --arg issue_state "$ISSUE_STATE" \
    --argjson gh_auth_ok "$GH_AUTH_OK" \
    --argjson issue_exists "$ISSUE_EXISTS" \
    --argjson issue_open "$ISSUE_OPEN" \
    --argjson warnings "$warnings_json" \
    --argjson errors "$errors_json" \
    '{
        status: $status,
        mode: $mode,
        checks: {
            gh_auth: $gh_auth_ok,
            issue_exists: $issue_exists,
            issue_open: $issue_open,
            issue_state: $issue_state,
            issue_title: $issue_title,
            issue: ($issue | tonumber)
        },
        warnings: $warnings,
        errors: $errors
    }'

# ----------------------------------------------------------------------------
# Exit code
# ----------------------------------------------------------------------------
if [[ "$MODE" == "strict" && "$HAS_ERRORS" == true ]]; then
    if [[ "$GH_AUTH_OK" != true ]]; then
        exit 11
    else
        exit 10
    fi
fi

exit 0
