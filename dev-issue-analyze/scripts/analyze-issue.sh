#!/usr/bin/env bash
# analyze-issue.sh - Fetch and parse GitHub issue

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_gh_auth
require_cmd "jq" "jq is required for JSON parsing. Install: brew install jq"

ISSUE_NUMBER=""
DEPTH="standard"

while [[ $# -gt 0 ]]; do
    case $1 in
        --depth) DEPTH="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: analyze-issue.sh <issue-number> [--depth minimal|standard|comprehensive]"
            exit 0
            ;;
        -*)
            die_json "Unknown option: $1"
            ;;
        *)
            [[ -z "$ISSUE_NUMBER" ]] && ISSUE_NUMBER="$1"
            shift
            ;;
    esac
done

[[ -z "$ISSUE_NUMBER" ]] && die_json "Issue number required"

# Fetch issue
ISSUE_JSON=$(gh issue view "$ISSUE_NUMBER" --json body,title,labels,assignees,milestone,state 2>&1) || \
    die_json "Failed to fetch issue #$ISSUE_NUMBER. Check if issue exists and you have access."

# Extract fields
TITLE=$(echo "$ISSUE_JSON" | jq -r '.title // ""')
STATE=$(echo "$ISSUE_JSON" | jq -r '.state // "unknown"')
BODY=$(echo "$ISSUE_JSON" | jq -r '.body // ""')
LABELS=$(echo "$ISSUE_JSON" | jq -c '[.labels[].name] // []')
MILESTONE=$(echo "$ISSUE_JSON" | jq -r '.milestone.title // null')

# Detect type from labels
detect_type() {
    local labels="$1"
    if echo "$labels" | grep -qi "bug"; then echo "fix"
    elif echo "$labels" | grep -qi "enhancement\|feature"; then echo "feat"
    elif echo "$labels" | grep -qi "refactor"; then echo "refactor"
    elif echo "$labels" | grep -qi "doc"; then echo "docs"
    else echo "feat"
    fi
}

TYPE=$(detect_type "$LABELS")

# Minimal output
if [[ "$DEPTH" == "minimal" ]]; then
    echo "{\"issue_number\":$ISSUE_NUMBER,\"title\":$(json_str "$TITLE"),\"type\":\"$TYPE\",\"state\":\"$STATE\",\"labels\":$LABELS,\"milestone\":$(json_str "$MILESTONE")}"
    exit 0
fi

# Extract AC and requirements
extract_ac() {
    echo "$1" | grep -E '^\s*-\s*\[[ x]\]|^[0-9]+\.\s' | head -20 | json_array
}

extract_requirements() {
    echo "$1" | grep -E '^\s*[-*]\s+[A-Z]' | head -15 | json_array
}

AC=$(extract_ac "$BODY")
REQUIREMENTS=$(extract_requirements "$BODY")

# Standard output
if [[ "$DEPTH" == "standard" ]]; then
    cat <<JSONEOF
{
  "issue_number": $ISSUE_NUMBER,
  "title": $(json_str "$TITLE"),
  "type": "$TYPE",
  "state": "$STATE",
  "labels": $LABELS,
  "milestone": $(json_str "$MILESTONE"),
  "acceptance_criteria": $AC,
  "requirements": $REQUIREMENTS,
  "body_preview": $(printf '%s' "$BODY" | head -c 500 | jq -Rs .)
}
JSONEOF
    exit 0
fi

# Comprehensive
AFFECTED_FILES=$(echo "$BODY" | grep -oE '[a-zA-Z0-9_/-]+\.(ts|tsx|js|jsx|py|go|rs|md)' | sort -u | head -10 | json_array)
COMPONENTS=$(echo "$BODY" | grep -oE '\b[A-Z][a-zA-Z]+Component\b|\b[a-z]+Service\b' | sort -u | head -10 | json_array)

BREAKING="false"
echo "$BODY" | grep -qi "breaking\|incompatible\|migration" && BREAKING="true"

cat <<JSONEOF
{
  "issue_number": $ISSUE_NUMBER,
  "title": $(json_str "$TITLE"),
  "type": "$TYPE",
  "state": "$STATE",
  "labels": $LABELS,
  "milestone": $(json_str "$MILESTONE"),
  "acceptance_criteria": $AC,
  "requirements": $REQUIREMENTS,
  "affected_files": $AFFECTED_FILES,
  "components": $COMPONENTS,
  "breaking_changes": $BREAKING,
  "body_full": $(printf '%s' "$BODY" | jq -Rs .)
}
JSONEOF
