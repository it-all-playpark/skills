#!/usr/bin/env bash
# flow-read.sh - Read and query v2 flow.json state
#
# Usage: flow-read.sh [--field JQPATH] [--child ISSUE] [--batch N] [--flow-state PATH]
#
# SECURITY: --field accepts arbitrary jq expressions. Do NOT invoke with untrusted input.
#
# Examples:
#   flow-read.sh --flow-state /path/to/flow.json
#   flow-read.sh --flow-state /path/to/flow.json --field .status
#   flow-read.sh --flow-state /path/to/flow.json --child 101
#   flow-read.sh --flow-state /path/to/flow.json --batch 2
#   flow-read.sh --flow-state /path/to/flow.json --field '.children[] | select(.status == "pending")'

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common.sh"

require_cmd jq

FLOW_STATE=""
FIELD=""
CHILD_ISSUE=""
BATCH_NUM=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        --field) FIELD="$2"; shift 2 ;;
        --child) CHILD_ISSUE="$2"; shift 2 ;;
        --batch) BATCH_NUM="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: flow-read.sh [--flow-state PATH] [--field JQPATH] [--child ISSUE] [--batch N]"
            exit 0
            ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

# Locate flow.json if path not provided
if [[ -z "$FLOW_STATE" ]]; then
    GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
    if [[ -n "$GIT_ROOT" ]]; then
        PARENT_DIR=$(dirname "$GIT_ROOT")
        if [[ -f "$PARENT_DIR/.claude/flow.json" ]]; then
            FLOW_STATE="$PARENT_DIR/.claude/flow.json"
        fi
    fi
fi

[[ -n "$FLOW_STATE" ]] || die_json "flow.json not found. Use --flow-state PATH" 1
[[ -f "$FLOW_STATE" ]] || die_json "flow.json not found at: $FLOW_STATE" 1

# Enforce v2 (no-backcompat)
VERSION=$(jq -r '.version // empty' "$FLOW_STATE")
if [[ "$VERSION" != "2.0.0" ]]; then
    die_json "flow.json schema version must be 2.0.0 (got: \"$VERSION\"). v1 is not supported (no-backcompat)." 1
fi

# Query modes
if [[ -n "$CHILD_ISSUE" ]]; then
    jq --argjson i "$CHILD_ISSUE" '.children[] | select(.issue == $i)' "$FLOW_STATE"
elif [[ -n "$BATCH_NUM" ]]; then
    jq --argjson b "$BATCH_NUM" '.batches[] | select(.batch == $b)' "$FLOW_STATE"
elif [[ -n "$FIELD" ]]; then
    jq "$FIELD" "$FLOW_STATE"
else
    jq '.' "$FLOW_STATE"
fi
