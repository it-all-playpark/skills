#!/usr/bin/env bash
# init-flow.sh - Initialize flow.json for parallel subtask orchestration
# Usage: init-flow.sh <issue> --flow-state PATH [--base main] [--strategy tdd] [--depth standard] [--lang ja] [--env-mode hardlink]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

# ============================================================================
# Defaults
# ============================================================================

ISSUE=""
FLOW_STATE=""
BASE_BRANCH="main"
STRATEGY="tdd"
DEPTH="standard"
LANG="ja"
ENV_MODE="hardlink"

# Valid enum values
VALID_STRATEGIES="tdd bdd ddd none"
VALID_DEPTHS="minimal standard comprehensive"
VALID_LANGS="ja en"
VALID_ENV_MODES="hardlink symlink copy none"

# ============================================================================
# Argument Parsing
# ============================================================================

while [[ $# -gt 0 ]]; do
    case "$1" in
        --flow-state)
            [[ -n "${2:-}" ]] || die_json "--flow-state requires a path argument" 1
            FLOW_STATE="$2"; shift 2
            ;;
        --base)
            [[ -n "${2:-}" ]] || die_json "--base requires a branch argument" 1
            BASE_BRANCH="$2"; shift 2
            ;;
        --strategy)
            [[ -n "${2:-}" ]] || die_json "--strategy requires a value" 1
            STRATEGY="$2"; shift 2
            ;;
        --depth)
            [[ -n "${2:-}" ]] || die_json "--depth requires a value" 1
            DEPTH="$2"; shift 2
            ;;
        --lang)
            [[ -n "${2:-}" ]] || die_json "--lang requires a value" 1
            LANG="$2"; shift 2
            ;;
        --env-mode)
            [[ -n "${2:-}" ]] || die_json "--env-mode requires a value" 1
            ENV_MODE="$2"; shift 2
            ;;
        -h|--help)
            echo "Usage: init-flow.sh <issue> --flow-state PATH [--base main] [--strategy tdd] [--depth standard] [--lang ja] [--env-mode hardlink]"
            exit 0
            ;;
        -*)
            die_json "Unknown option: $1" 1
            ;;
        *)
            if [[ -z "$ISSUE" ]]; then
                ISSUE="$1"
            else
                die_json "Unexpected argument: $1" 1
            fi
            shift
            ;;
    esac
done

# ============================================================================
# Validation
# ============================================================================

[[ -n "$ISSUE" ]] || die_json "Issue number required" 1
[[ -n "$FLOW_STATE" ]] || die_json "--flow-state path required" 1

# Validate ISSUE is numeric (prevent injection)
if ! [[ "$ISSUE" =~ ^[0-9]+$ ]]; then
    die_json "Issue must be a positive integer, got: $ISSUE" 1
fi

# Validate enum values
if ! echo "$VALID_STRATEGIES" | grep -qw "$STRATEGY"; then
    die_json "Invalid strategy: $STRATEGY. Must be one of: $VALID_STRATEGIES" 1
fi

if ! echo "$VALID_DEPTHS" | grep -qw "$DEPTH"; then
    die_json "Invalid depth: $DEPTH. Must be one of: $VALID_DEPTHS" 1
fi

if ! echo "$VALID_LANGS" | grep -qw "$LANG"; then
    die_json "Invalid lang: $LANG. Must be one of: $VALID_LANGS" 1
fi

if ! echo "$VALID_ENV_MODES" | grep -qw "$ENV_MODE"; then
    die_json "Invalid env-mode: $ENV_MODE. Must be one of: $VALID_ENV_MODES" 1
fi

# ============================================================================
# Directory Setup
# ============================================================================

FLOW_DIR="$(dirname "$FLOW_STATE")"

# Create the parent directory for flow.json (typically .claude/)
if ! mkdir -p "$FLOW_DIR" 2>/dev/null; then
    die_json "Cannot create directory: $FLOW_DIR" 1
fi

# Resolve to absolute path after creation
FLOW_DIR="$(cd "$FLOW_DIR" && pwd)" || die_json "Cannot resolve directory: $FLOW_DIR" 1
FLOW_STATE="${FLOW_DIR}/$(basename "$FLOW_STATE")"

# ============================================================================
# Generate flow.json
# ============================================================================

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

jq -n \
    --arg version "2.0.0" \
    --argjson issue "$ISSUE" \
    --arg status "decomposing" \
    --arg contract_branch "feature/issue-${ISSUE}-contract" \
    --arg base_branch "$BASE_BRANCH" \
    --arg strategy "$STRATEGY" \
    --arg depth "$DEPTH" \
    --arg lang "$LANG" \
    --arg env_mode "$ENV_MODE" \
    --arg now "$NOW" \
    '{
        version: $version,
        issue: $issue,
        status: $status,
        subtasks: [],
        contract: {
            files: [],
            branch: $contract_branch
        },
        config: {
            base_branch: $base_branch,
            strategy: $strategy,
            depth: $depth,
            lang: $lang,
            env_mode: $env_mode
        },
        created_at: $now,
        updated_at: $now
    }' > "$FLOW_STATE" || die_json "Failed to write flow.json to: $FLOW_STATE" 1

# ============================================================================
# Output
# ============================================================================

jq -n \
    --arg status "initialized" \
    --arg flow_state "$FLOW_STATE" \
    --argjson issue "$ISSUE" \
    --arg contract_branch "feature/issue-${ISSUE}-contract" \
    '{
        status: $status,
        flow_state: $flow_state,
        issue: $issue,
        contract_branch: $contract_branch
    }'
