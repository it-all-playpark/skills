#!/usr/bin/env bash
# test-pr.sh - Checkout and test a PR
# Usage: test-pr.sh <pr-number>
# Output: JSON with test results

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Args
# ============================================================================

PR_NUMBER="${1:-}"
[[ -n "$PR_NUMBER" ]] || die_json "Usage: test-pr.sh <pr-number>" 1
[[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || die_json "PR number must be numeric: $PR_NUMBER" 1

# ============================================================================
# Helpers
# ============================================================================

require_gh_auth
require_git_repo

ORIGINAL_BRANCH=$(git_current_branch)
ERRORS="[]"

# Ensure we return to the original branch on exit
cleanup() {
    local current
    current=$(git_current_branch)
    if [[ "$current" != "$ORIGINAL_BRANCH" ]]; then
        git checkout "$ORIGINAL_BRANCH" >&2 2>&1 || true
    fi
}
trap cleanup EXIT

add_error() {
    local phase="$1"
    local msg="$2"
    ERRORS=$(echo "$ERRORS" | jq --arg p "$phase" --arg m "$msg" '. + [{"phase": $p, "message": $m}]')
}

run_phase() {
    local phase_name="$1"
    shift
    local output
    local exit_code=0

    output=$("$@" 2>&1) || exit_code=$?

    if [[ $exit_code -ne 0 ]]; then
        # Truncate long output for JSON
        local truncated
        truncated=$(echo "$output" | tail -50)
        add_error "$phase_name" "$truncated"
        echo "fail"
    else
        echo "pass"
    fi
}

# ============================================================================
# Main
# ============================================================================

# Phase: Checkout PR
gh pr checkout "$PR_NUMBER" >&2 2>&1 || die_json "Failed to checkout PR #$PR_NUMBER" 1

# Phase: Install dependencies
DETECT_SCRIPT="$SKILLS_DIR/dev-env-setup/scripts/detect-and-install.sh"
if [[ -x "$DETECT_SCRIPT" ]]; then
    "$DETECT_SCRIPT" --path . >&2 2>&1 || warn "detect-and-install.sh returned non-zero"
else
    # Fallback: npm install if package.json exists
    if [[ -f "package.json" ]]; then
        npm install >&2 2>&1 || warn "npm install returned non-zero"
    fi
fi

# Phase: Build
BUILD_RESULT="skipped"
if [[ -f "package.json" ]] && jq -e '.scripts.build' package.json &>/dev/null; then
    BUILD_RESULT=$(run_phase "build" npm run build)
fi

# Phase: Test
TEST_RESULT="skipped"
if [[ -f "package.json" ]] && jq -e '.scripts.test' package.json &>/dev/null; then
    TEST_RESULT=$(run_phase "test" npm test)
fi

# Phase: Type check
TYPECHECK_RESULT="skipped"
if [[ -f "tsconfig.json" ]]; then
    TYPECHECK_RESULT=$(run_phase "typecheck" npx tsc --noEmit)
fi

# Determine overall result
OVERALL="pass"
if [[ "$BUILD_RESULT" == "fail" ]] || [[ "$TEST_RESULT" == "fail" ]] || [[ "$TYPECHECK_RESULT" == "fail" ]]; then
    OVERALL="fail"
fi

echo "{\"pr\":$PR_NUMBER,\"build\":$(json_str "$BUILD_RESULT"),\"test\":$(json_str "$TEST_RESULT"),\"typecheck\":$(json_str "$TYPECHECK_RESULT"),\"overall\":$(json_str "$OVERALL"),\"errors\":$ERRORS}"
