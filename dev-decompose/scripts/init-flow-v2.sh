#!/usr/bin/env bash
# init-flow-v2.sh - Initialize v2 flow.json for child-split orchestration
#
# Usage:
#   init-flow-v2.sh <parent-issue> --flow-state PATH \
#     --integration-branch BRANCH --integration-base BRANCH \
#     [--strategy tdd] [--depth standard] [--lang ja] [--env-mode hardlink] \
#     [--children-json PATH] [--batches-json PATH]
#
# Generates a v2 flow.json. If --children-json / --batches-json are provided,
# they're embedded directly. Otherwise empty arrays are written (caller must
# subsequently populate via jq edits or by overwriting the file).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

# Defaults
ISSUE=""
FLOW_STATE=""
INTEGRATION_BRANCH=""
INTEGRATION_BASE=""
STRATEGY="tdd"
DEPTH="standard"
LANG="ja"
ENV_MODE="hardlink"
CHILDREN_JSON=""
BATCHES_JSON=""

VALID_STRATEGIES="tdd bdd ddd none"
VALID_DEPTHS="minimal standard comprehensive"
VALID_LANGS="ja en"
VALID_ENV_MODES="hardlink symlink copy none"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        --integration-branch) INTEGRATION_BRANCH="$2"; shift 2 ;;
        --integration-base) INTEGRATION_BASE="$2"; shift 2 ;;
        --strategy) STRATEGY="$2"; shift 2 ;;
        --depth) DEPTH="$2"; shift 2 ;;
        --lang) LANG="$2"; shift 2 ;;
        --env-mode) ENV_MODE="$2"; shift 2 ;;
        --children-json) CHILDREN_JSON="$2"; shift 2 ;;
        --batches-json) BATCHES_JSON="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,15p' "$0"
            exit 0
            ;;
        -*) die_json "Unknown option: $1" 1 ;;
        *)
            if [[ -z "$ISSUE" ]]; then ISSUE="$1"
            else die_json "Unexpected argument: $1" 1
            fi
            shift
            ;;
    esac
done

[[ -n "$ISSUE" ]] || die_json "Parent issue number required" 1
[[ "$ISSUE" =~ ^[0-9]+$ ]] || die_json "Issue must be a positive integer, got: $ISSUE" 1
[[ -n "$FLOW_STATE" ]] || die_json "--flow-state required" 1
[[ -n "$INTEGRATION_BRANCH" ]] || die_json "--integration-branch required" 1
[[ -n "$INTEGRATION_BASE" ]] || die_json "--integration-base required" 1

echo "$VALID_STRATEGIES" | grep -qw "$STRATEGY" || die_json "Invalid strategy: $STRATEGY (valid: $VALID_STRATEGIES)" 1
echo "$VALID_DEPTHS" | grep -qw "$DEPTH" || die_json "Invalid depth: $DEPTH (valid: $VALID_DEPTHS)" 1
echo "$VALID_LANGS" | grep -qw "$LANG" || die_json "Invalid lang: $LANG (valid: $VALID_LANGS)" 1
echo "$VALID_ENV_MODES" | grep -qw "$ENV_MODE" || die_json "Invalid env-mode: $ENV_MODE (valid: $VALID_ENV_MODES)" 1

# Resolve absolute paths
FLOW_DIR="$(dirname "$FLOW_STATE")"
mkdir -p "$FLOW_DIR" || die_json "Cannot create directory: $FLOW_DIR" 1
FLOW_DIR="$(cd "$FLOW_DIR" && pwd)"
FLOW_STATE="${FLOW_DIR}/$(basename "$FLOW_STATE")"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Load optional children / batches inputs
if [[ -n "$CHILDREN_JSON" ]]; then
    [[ -f "$CHILDREN_JSON" ]] || die_json "Children JSON not found: $CHILDREN_JSON" 1
    CHILDREN=$(cat "$CHILDREN_JSON")
else
    CHILDREN="[]"
fi

if [[ -n "$BATCHES_JSON" ]]; then
    [[ -f "$BATCHES_JSON" ]] || die_json "Batches JSON not found: $BATCHES_JSON" 1
    BATCHES=$(cat "$BATCHES_JSON")
else
    BATCHES="[]"
fi

# Generate flow.json
jq -n \
    --arg version "2.0.0" \
    --argjson issue "$ISSUE" \
    --arg status "decomposing" \
    --arg integ_name "$INTEGRATION_BRANCH" \
    --arg integ_base "$INTEGRATION_BASE" \
    --argjson children "$CHILDREN" \
    --argjson batches "$BATCHES" \
    --arg strategy "$STRATEGY" \
    --arg depth "$DEPTH" \
    --arg lang "$LANG" \
    --arg env_mode "$ENV_MODE" \
    --arg now "$NOW" \
    '{
        version: $version,
        issue: $issue,
        status: $status,
        integration_branch: {
            name: $integ_name,
            base: $integ_base,
            created_at: $now
        },
        children: $children,
        batches: $batches,
        final_pr: null,
        config: {
            strategy: $strategy,
            depth: $depth,
            lang: $lang,
            base_branch: $integ_base,
            env_mode: $env_mode
        },
        created_at: $now,
        updated_at: $now
    }' > "$FLOW_STATE" || die_json "Failed to write flow.json to: $FLOW_STATE" 1

jq -n \
    --arg status "initialized" \
    --arg flow_state "$FLOW_STATE" \
    --argjson issue "$ISSUE" \
    --arg integration_branch "$INTEGRATION_BRANCH" \
    '{
        status: $status,
        flow_state: $flow_state,
        issue: $issue,
        integration_branch: $integration_branch
    }'
