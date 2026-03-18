#!/usr/bin/env bash
# init-kickoff.sh - Initialize kickoff state file
# Usage: init-kickoff.sh <issue> <branch> <worktree> [options]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

# Defaults
ISSUE=""
BRANCH=""
WORKTREE=""
BASE_BRANCH="main"
TESTING="tdd"
DESIGN=""
DEPTH="standard"
LANG="ja"
ENV_MODE="hardlink"

# Valid enum values
VALID_TESTING="tdd bdd none"
VALID_DESIGN="ddd"
VALID_DEPTHS="minimal standard comprehensive"
VALID_LANGS="ja en"
VALID_ENV_MODES="hardlink symlink copy none"

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --base) BASE_BRANCH="$2"; shift 2 ;;
        --testing) TESTING="$2"; shift 2 ;;
        --design) DESIGN="$2"; shift 2 ;;
        --depth) DEPTH="$2"; shift 2 ;;
        --lang) LANG="$2"; shift 2 ;;
        --env-mode) ENV_MODE="$2"; shift 2 ;;
        -*)
            die_json "Unknown option: $1" 1
            ;;
        *)
            if [[ -z "$ISSUE" ]]; then
                ISSUE="$1"
            elif [[ -z "$BRANCH" ]]; then
                BRANCH="$1"
            elif [[ -z "$WORKTREE" ]]; then
                WORKTREE="$1"
            fi
            shift
            ;;
    esac
done

[[ -n "$ISSUE" ]] || die_json "Issue number required" 1
[[ -n "$BRANCH" ]] || die_json "Branch name required" 1
[[ -n "$WORKTREE" ]] || die_json "Worktree path required" 1

# Validate ISSUE is numeric only (prevent injection)
if ! [[ "$ISSUE" =~ ^[0-9]+$ ]]; then
    die_json "Issue must be a positive integer" 1
fi

# Validate enum values
if ! echo "$VALID_TESTING" | grep -qw "$TESTING"; then
    die_json "Invalid testing: $TESTING. Must be one of: $VALID_TESTING" 1
fi

if [[ -n "$DESIGN" ]] && ! echo "$VALID_DESIGN" | grep -qw "$DESIGN"; then
    die_json "Invalid design: $DESIGN. Must be one of: $VALID_DESIGN" 1
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

# Validate and resolve worktree path
[[ -d "$WORKTREE" ]] || die_json "Worktree path does not exist: $WORKTREE" 1
WORKTREE=$(cd "$WORKTREE" && pwd) || die_json "Cannot resolve worktree path" 1

# Ensure .claude directory exists in worktree
mkdir -p "$WORKTREE/.claude"

STATE_FILE="$WORKTREE/.claude/kickoff.json"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Create initial state using jq to prevent JSON injection
jq -n \
    --argjson issue "$ISSUE" \
    --arg branch "$BRANCH" \
    --arg worktree "$WORKTREE" \
    --arg base_branch "$BASE_BRANCH" \
    --arg now "$NOW" \
    --arg testing "$TESTING" \
    --arg design "$DESIGN" \
    --arg depth "$DEPTH" \
    --arg lang "$LANG" \
    --arg env_mode "$ENV_MODE" \
    '{
        version: "2.0.0",
        issue: $issue,
        branch: $branch,
        worktree: $worktree,
        base_branch: $base_branch,
        started_at: $now,
        updated_at: $now,
        current_phase: "1_prepare",
        phases: {
            "1_prepare": { status: "done", started_at: $now, completed_at: $now, result: "Worktree created" },
            "2_analyze": { status: "pending" },
            "3_implement": { status: "pending" },
            "4_validate": { status: "pending" },
            "5_commit": { status: "pending" },
            "6_pr": { status: "pending" }
        },
        next_actions: ["Run dev-issue-analyze"],
        decisions: [],
        config: {
            testing: $testing,
            design: (if $design == "" then null else $design end),
            depth: $depth,
            lang: $lang,
            env_mode: $env_mode
        }
    }' > "$STATE_FILE"

echo "{\"status\":\"initialized\",\"state_file\":\"$STATE_FILE\"}"