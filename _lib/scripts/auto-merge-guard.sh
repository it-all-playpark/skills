#!/usr/bin/env bash
# auto-merge-guard.sh - Guard `gh pr merge --admin` against unsafe base branches
#
# `--admin` bypasses branch protection. To prevent accidental bypass on
# `main` / `dev` / feature branches, this guard checks the target base
# against an allowlist of glob patterns. Only `integration/issue-*` and
# `nightly/*` (or whatever `skill-config.json.auto_merge.allowed_base_patterns`
# defines) are allowed for `--admin` use.
#
# Usage:
#   auto-merge-guard.sh --pr <number>            # resolve base from PR
#   auto-merge-guard.sh --base <branch>          # explicit base
#
# Exit codes:
#   0 = allowed (caller may proceed with --admin merge)
#   1 = refused (do not pass --admin)
#   2 = misuse (missing arg / config error)
#
# Output JSON (stdout):
#   {"status": "allowed|refused", "base": "...", "matched_pattern": "...|null",
#    "allowed_patterns": ["..."], "reason": "..."}

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common.sh"

require_cmd jq

# ============================================================================
# Argument parsing
# ============================================================================

PR_NUMBER=""
BASE_BRANCH=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --pr) PR_NUMBER="$2"; shift 2 ;;
        --base) BASE_BRANCH="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,22p' "$0"
            exit 0
            ;;
        *) die_json "Unknown option: $1" 2 ;;
    esac
done

if [[ -z "$PR_NUMBER" && -z "$BASE_BRANCH" ]]; then
    die_json "Either --pr or --base is required" 2
fi

# ============================================================================
# Resolve base branch from PR if needed
# ============================================================================

if [[ -z "$BASE_BRANCH" && -n "$PR_NUMBER" ]]; then
    require_cmd gh
    BASE_BRANCH=$(gh pr view "$PR_NUMBER" --json baseRefName -q '.baseRefName' 2>/dev/null || echo "")
    if [[ -z "$BASE_BRANCH" ]]; then
        die_json "Could not resolve base branch for PR #$PR_NUMBER" 2
    fi
fi

# ============================================================================
# Load allowlist from skill-config.json
# ============================================================================

# Default if config missing
DEFAULT_PATTERNS='["integration/issue-*","nightly/*"]'

# Look for project skill-config.json
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
CONFIG_PATTERNS="$DEFAULT_PATTERNS"

for cfg in \
    "${SKILL_CONFIG_PATH:-}" \
    "$GIT_ROOT/skill-config.json" \
    "$GIT_ROOT/.claude/skill-config.json" \
    "$HOME/.config/skills/config.json" \
    "$HOME/.claude/skill-config.json"
do
    [[ -n "$cfg" && -f "$cfg" ]] || continue
    PATTERNS=$(jq -c '.auto_merge.allowed_base_patterns // empty' "$cfg" 2>/dev/null)
    if [[ -n "$PATTERNS" && "$PATTERNS" != "null" ]]; then
        CONFIG_PATTERNS="$PATTERNS"
        break
    fi
done

# ============================================================================
# Match base against allowlist (glob, * = greedy)
# ============================================================================

# Convert glob pattern to bash extended pattern; using case/esac for glob match.
MATCHED_PATTERN=""
PATTERN_COUNT=$(echo "$CONFIG_PATTERNS" | jq 'length')
for i in $(seq 0 $((PATTERN_COUNT - 1))); do
    PATTERN=$(echo "$CONFIG_PATTERNS" | jq -r ".[$i]")
    case "$BASE_BRANCH" in
        $PATTERN) MATCHED_PATTERN="$PATTERN"; break ;;
    esac
done

# ============================================================================
# Emit result
# ============================================================================

if [[ -n "$MATCHED_PATTERN" ]]; then
    jq -n \
        --arg base "$BASE_BRANCH" \
        --arg matched "$MATCHED_PATTERN" \
        --argjson patterns "$CONFIG_PATTERNS" \
        '{
            status: "allowed",
            base: $base,
            matched_pattern: $matched,
            allowed_patterns: $patterns,
            reason: "base matches allowed pattern"
        }'
    exit 0
else
    jq -n \
        --arg base "$BASE_BRANCH" \
        --argjson patterns "$CONFIG_PATTERNS" \
        '{
            status: "refused",
            base: $base,
            matched_pattern: null,
            allowed_patterns: $patterns,
            reason: "base does not match any allowed pattern; --admin merge is not permitted"
        }'
    exit 1
fi
