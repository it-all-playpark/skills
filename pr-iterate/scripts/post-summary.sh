#!/usr/bin/env bash
# post-summary.sh - Post iteration summary to PR comment
# Usage: post-summary.sh [--worktree PATH] [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

WORKTREE=""
DRY_RUN=false

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree) WORKTREE="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        -*)
            die_json "Unknown option: $1" 1
            ;;
        *)
            shift
            ;;
    esac
done

# Find state file (Priority: --worktree > kickoff.json auto-detect > current dir)
if [[ -n "$WORKTREE" ]]; then
    [[ -d "$WORKTREE" ]] || die_json "Worktree path does not exist: $WORKTREE" 1
    WORKTREE=$(cd "$WORKTREE" && pwd) || die_json "Cannot resolve worktree path" 1
    STATE_FILE="$WORKTREE/.claude/iterate.json"
else
    GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")

    if [[ -n "$GIT_ROOT" && -f "$GIT_ROOT/.claude/iterate.json" ]]; then
        STATE_FILE="$GIT_ROOT/.claude/iterate.json"
        WORKTREE="$GIT_ROOT"
    elif [[ -n "$GIT_ROOT" && -f "$GIT_ROOT/.claude/kickoff.json" ]]; then
        DETECTED_WORKTREE=$(jq -r '.worktree // empty' "$GIT_ROOT/.claude/kickoff.json" 2>/dev/null || echo "")
        if [[ -n "$DETECTED_WORKTREE" && -f "$DETECTED_WORKTREE/.claude/iterate.json" ]]; then
            STATE_FILE="$DETECTED_WORKTREE/.claude/iterate.json"
            WORKTREE="$DETECTED_WORKTREE"
        else
            die_json "State file not found. Use --worktree or initialize with init-iterate.sh" 1
        fi
    else
        die_json "State file not found. Use --worktree or initialize with init-iterate.sh" 1
    fi
fi

[[ -f "$STATE_FILE" ]] || die_json "State file not found: $STATE_FILE" 1

# Check if already posted
POSTED_AT=$(jq -r '.summary_posted_at // empty' "$STATE_FILE")
if [[ -n "$POSTED_AT" ]]; then
    echo "{\"status\":\"skipped\",\"reason\":\"already_posted\",\"posted_at\":\"$POSTED_AT\"}"
    exit 0
fi

# Check status is lgtm
STATUS=$(jq -r '.status' "$STATE_FILE")
if [[ "$STATUS" != "lgtm" ]]; then
    die_json "Cannot post summary: status is '$STATUS', expected 'lgtm'" 1
fi

# Extract data from state file
PR_NUMBER=$(jq -r '.pr_number' "$STATE_FILE")
TOTAL_ITERATIONS=$(jq -r '.current_iteration' "$STATE_FILE")
COMPLETED_AT=$(jq -r '.updated_at' "$STATE_FILE")

# Build iteration history
ITERATION_HISTORY=""
ITERATIONS_COUNT=$(jq '.iterations | length' "$STATE_FILE")

for ((i=0; i<ITERATIONS_COUNT; i++)); do
    ITER_NUM=$((i + 1))
    DECISION=$(jq -r ".iterations[$i].review.decision // \"N/A\"" "$STATE_FILE")
    SUMMARY=$(jq -r ".iterations[$i].review.summary // \"\"" "$STATE_FILE")
    ISSUES_JSON=$(jq -c ".iterations[$i].review.issues // []" "$STATE_FILE")
    FIXES_JSON=$(jq -c ".iterations[$i].fixes_applied // []" "$STATE_FILE")
    CI_STATUS=$(jq -r ".iterations[$i].ci_status // \"N/A\"" "$STATE_FILE")

    ITERATION_HISTORY+="#### Iteration ${ITER_NUM}
"

    # Review decision
    case "$DECISION" in
        approved) DECISION_EMOJI="✅" ;;
        request-changes) DECISION_EMOJI="🔧" ;;
        comment) DECISION_EMOJI="💬" ;;
        *) DECISION_EMOJI="⏳" ;;
    esac
    ITERATION_HISTORY+="- **レビュー結果**: ${DECISION_EMOJI} ${DECISION}
"

    # Summary if exists
    if [[ -n "$SUMMARY" && "$SUMMARY" != "null" ]]; then
        ITERATION_HISTORY+="- **概要**: ${SUMMARY}
"
    fi

    # Issues if any
    ISSUES_COUNT=$(echo "$ISSUES_JSON" | jq 'length')
    if [[ "$ISSUES_COUNT" -gt 0 ]]; then
        ITERATION_HISTORY+="- **指摘事項**:
"
        while IFS= read -r issue; do
            ITERATION_HISTORY+="  - ${issue}
"
        done < <(echo "$ISSUES_JSON" | jq -r '.[]')
    fi

    # Fixes if any
    FIXES_COUNT=$(echo "$FIXES_JSON" | jq 'length')
    if [[ "$FIXES_COUNT" -gt 0 ]]; then
        ITERATION_HISTORY+="- **適用した修正**:
"
        while IFS= read -r fix; do
            ITERATION_HISTORY+="  - ${fix}
"
        done < <(echo "$FIXES_JSON" | jq -r '.[]')
    fi

    # CI status
    case "$CI_STATUS" in
        passed) CI_EMOJI="✅" ;;
        failed) CI_EMOJI="❌" ;;
        *) CI_EMOJI="⏳" ;;
    esac
    ITERATION_HISTORY+="- **CI**: ${CI_EMOJI} ${CI_STATUS}

"
done

# Get final decision reason from last iteration
FINAL_DECISION=$(jq -r ".iterations[-1].review.summary // \"コード品質が承認基準を満たしました。\"" "$STATE_FILE")
if [[ "$FINAL_DECISION" == "null" || -z "$FINAL_DECISION" ]]; then
    FINAL_DECISION="コード品質が承認基準を満たしました。"
fi

# Build summary from template
TEMPLATE_FILE="$SCRIPT_DIR/../references/summary-template.md"
if [[ ! -f "$TEMPLATE_FILE" ]]; then
    die_json "Template file not found: $TEMPLATE_FILE" 1
fi

# Read template and substitute variables
SUMMARY_CONTENT=$(cat "$TEMPLATE_FILE")
SUMMARY_CONTENT="${SUMMARY_CONTENT//\$\{PR_NUMBER\}/$PR_NUMBER}"
SUMMARY_CONTENT="${SUMMARY_CONTENT//\$\{TOTAL_ITERATIONS\}/$TOTAL_ITERATIONS}"
SUMMARY_CONTENT="${SUMMARY_CONTENT//\$\{STATUS\}/$STATUS}"
SUMMARY_CONTENT="${SUMMARY_CONTENT//\$\{COMPLETED_AT\}/$COMPLETED_AT}"
SUMMARY_CONTENT="${SUMMARY_CONTENT//\$\{ITERATION_HISTORY\}/$ITERATION_HISTORY}"
SUMMARY_CONTENT="${SUMMARY_CONTENT//\$\{FINAL_DECISION\}/$FINAL_DECISION}"

if [[ "$DRY_RUN" == true ]]; then
    echo "{\"status\":\"dry_run\",\"pr_number\":$PR_NUMBER,\"summary_preview\":true}"
    echo "---"
    echo "$SUMMARY_CONTENT"
    exit 0
fi

# Check gh auth before posting (not needed for dry-run)
require_gh_auth

# Post comment to PR
if gh pr comment "$PR_NUMBER" --body "$SUMMARY_CONTENT" 2>/dev/null; then
    # Update state file with posted_at timestamp
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    TMP_FILE=$(mktemp)
    if jq --arg now "$NOW" '.summary_posted_at = $now' "$STATE_FILE" > "$TMP_FILE"; then
        mv "$TMP_FILE" "$STATE_FILE"
    else
        rm -f "$TMP_FILE"
    fi
    echo "{\"status\":\"posted\",\"pr_number\":$PR_NUMBER,\"posted_at\":\"$NOW\"}"
else
    # Post failed but don't fail the whole process
    echo "{\"status\":\"post_failed\",\"pr_number\":$PR_NUMBER,\"error\":\"Failed to post comment to PR\"}"
    exit 0
fi
