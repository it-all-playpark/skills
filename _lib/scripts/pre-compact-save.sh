#!/usr/bin/env bash
# pre-compact-save.sh - Save state before auto-compact
# Called by Claude Code PreCompact hook
# Reads current kickoff/iterate state and updates docs/STATE.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common.sh"

# Find git root (could be main repo or worktree)
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
[[ -n "$GIT_ROOT" ]] || exit 0  # Not in git repo, skip silently

STATE_DIR="$GIT_ROOT/.claude"
KICKOFF_STATE="$STATE_DIR/kickoff.json"
ITERATE_STATE="$STATE_DIR/iterate.json"
STATE_MD="$GIT_ROOT/docs/STATE.md"

# Check if any state exists
[[ -f "$KICKOFF_STATE" || -f "$ITERATE_STATE" ]] || exit 0

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Ensure docs directory exists
mkdir -p "$(dirname "$STATE_MD")"

# Generate STATE.md from JSON states
{
    echo "# Development State"
    echo ""
    echo "_Auto-generated at $NOW - DO NOT EDIT MANUALLY_"
    echo ""

    # Kickoff state
    if [[ -f "$KICKOFF_STATE" ]] && command -v jq &>/dev/null; then
        echo "## Kickoff Status"
        echo ""

        ISSUE=$(jq -r '.issue' "$KICKOFF_STATE")
        BRANCH=$(jq -r '.branch' "$KICKOFF_STATE")
        CURRENT=$(jq -r '.current_phase' "$KICKOFF_STATE")

        echo "- **Issue**: #$ISSUE"
        echo "- **Branch**: \`$BRANCH\`"
        echo "- **Current Phase**: \`$CURRENT\`"
        echo ""

        echo "### Phase Progress"
        echo ""
        echo "| Phase | Status |"
        echo "|-------|--------|"

        for phase in 1_prepare 2_analyze 3_implement 4_validate 5_commit 6_pr; do
            status=$(jq -r ".phases.\"$phase\".status // \"pending\"" "$KICKOFF_STATE")
            result=$(jq -r ".phases.\"$phase\".result // \"\"" "$KICKOFF_STATE")

            case "$status" in
                done) emoji="✅" ;;
                in_progress) emoji="🔄" ;;
                failed) emoji="❌" ;;
                skipped) emoji="⏭️" ;;
                *) emoji="⏳" ;;
            esac

            if [[ -n "$result" && "$result" != "null" ]]; then
                echo "| $phase | $emoji $status - $result |"
            else
                echo "| $phase | $emoji $status |"
            fi
        done
        echo ""

        # Next actions
        ACTIONS=$(jq -r '.next_actions[]? // empty' "$KICKOFF_STATE" 2>/dev/null)
        if [[ -n "$ACTIONS" ]]; then
            echo "### Next Actions"
            echo ""
            echo "$ACTIONS" | while read -r action; do
                echo "- [ ] $action"
            done
            echo ""
        fi

        # Decisions
        DECISIONS=$(jq -r '.decisions | length' "$KICKOFF_STATE" 2>/dev/null)
        if [[ "$DECISIONS" -gt 0 ]]; then
            echo "### Decisions Made"
            echo ""
            jq -r '.decisions[] | "- **Q**: \(.question)\n  **A**: \(.answer)"' "$KICKOFF_STATE"
            echo ""
        fi
    fi

    # Iterate state
    if [[ -f "$ITERATE_STATE" ]] && command -v jq &>/dev/null; then
        echo "## PR Iterate Status"
        echo ""

        PR=$(jq -r '.pr_number' "$ITERATE_STATE")
        ITERATION=$(jq -r '.current_iteration' "$ITERATE_STATE")
        STATUS=$(jq -r '.status' "$ITERATE_STATE")

        echo "- **PR**: #$PR"
        echo "- **Iteration**: $ITERATION"
        echo "- **Status**: $STATUS"
        echo ""

        ITER_COUNT=$(jq -r '.iterations | length' "$ITERATE_STATE" 2>/dev/null)
        if [[ "$ITER_COUNT" -gt 0 ]]; then
            echo "### Iteration History"
            echo ""
            echo "| # | Review | CI |"
            echo "|---|--------|-----|"
            jq -r '.iterations[] | "| \(.number) | \(.review.decision // "pending") | \(.ci_status // "unknown") |"' "$ITERATE_STATE"
            echo ""
        fi
    fi

    echo "---"
    echo ""
    echo "## Recovery Instructions"
    echo ""
    echo "If resuming after auto-compact:"
    echo ""
    echo "1. Read \`.claude/kickoff.json\` or \`.claude/iterate.json\`"
    echo "2. Check \`current_phase\` and \`next_actions\`"
    echo "3. Continue from where you left off"

} > "$STATE_MD"

echo "{\"status\":\"saved\",\"state_md\":\"$STATE_MD\",\"timestamp\":\"$NOW\"}"
