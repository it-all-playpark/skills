#!/usr/bin/env bash
# flow-read.sh - Read and query flow.json state
# Usage: flow-read.sh [--field JQPATH] [--subtask ID] [--flow-state PATH]
#
# Examples:
#   flow-read.sh --flow-state /path/to/flow.json
#   flow-read.sh --flow-state /path/to/flow.json --field .status
#   flow-read.sh --flow-state /path/to/flow.json --subtask task1
#   flow-read.sh --flow-state /path/to/flow.json --field '.subtasks[] | select(.status == "pending")'

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common.sh"

require_cmd jq

FLOW_STATE=""
FIELD=""
SUBTASK_ID=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        --field) FIELD="$2"; shift 2 ;;
        --subtask) SUBTASK_ID="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: flow-read.sh [--flow-state PATH] [--field JQPATH] [--subtask ID]"
            exit 0
            ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

# Find flow.json
if [[ -z "$FLOW_STATE" ]]; then
    # Try to find in parent .claude directory
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

# Query modes
if [[ -n "$SUBTASK_ID" ]]; then
    # Return specific subtask
    jq --arg id "$SUBTASK_ID" '.subtasks[] | select(.id == $id)' "$FLOW_STATE"
elif [[ -n "$FIELD" ]]; then
    # Return specific field
    jq "$FIELD" "$FLOW_STATE"
else
    # Return full state
    jq '.' "$FLOW_STATE"
fi
