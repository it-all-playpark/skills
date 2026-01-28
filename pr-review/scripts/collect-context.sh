#!/usr/bin/env bash
# collect-context.sh - Orchestrate data collection from other skills' scripts
# Usage: collect-context.sh <pr-number-or-url> [--depth quick|standard|deep]
#
# Calls scripts from other skills to maintain SSoT:
# - git-status/scripts/git-status.sh
# - code-review/scripts/get-pr-info.sh
# - dev-build/scripts/detect-build.sh
# - dev-validate/scripts/validate.sh (for test results)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$SCRIPT_DIR/../.."

source "$SKILL_ROOT/_lib/common.sh"

# Parse arguments
PR_REF=""
DEPTH="standard"

while [[ $# -gt 0 ]]; do
    case $1 in
        --depth)
            DEPTH="${2:-standard}"
            shift 2
            ;;
        -*)
            shift
            ;;
        *)
            [[ -z "$PR_REF" ]] && PR_REF="$1"
            shift
            ;;
    esac
done

if [[ -z "$PR_REF" ]]; then
    die_json "PR reference required. Usage: collect-context.sh <pr-number-or-url> [--depth quick|standard|deep]"
fi

require_git_repo
require_cmd "gh" "GitHub CLI (gh) not installed. Install: brew install gh"
# Note: Skip require_gh_auth as it fails with multiple accounts; gh commands will fail if not authenticated

# ============================================================================
# Section 1: Git Status
# ============================================================================
echo "=== Git Status ===" >&2
"$SKILL_ROOT/git-status/scripts/git-status.sh" 2>/dev/null || echo '{"error": "git-status failed"}'

echo ""

# ============================================================================
# Section 2: PR Information (from code-review skill)
# ============================================================================
echo "=== PR Information ===" >&2
"$SCRIPT_DIR/get-pr-info.sh" "$PR_REF" --with-ci 2>/dev/null || echo "PR info fetch failed"

echo ""

# ============================================================================
# Section 3: Build System Detection
# ============================================================================
echo "=== Build System ===" >&2
"$SKILL_ROOT/dev-build/scripts/detect-build.sh" . 2>/dev/null || echo '{"error": "build detection failed"}'

echo ""

# ============================================================================
# Section 4: Test & Validation (depth-dependent)
# ============================================================================
if [[ "$DEPTH" != "quick" ]]; then
    echo "=== Test Results ===" >&2

    # Try to run tests with coverage
    if [[ -f "package.json" ]]; then
        # Detect package manager
        PM="npm"
        [[ -f "yarn.lock" ]] && PM="yarn"
        [[ -f "pnpm-lock.yaml" ]] && PM="pnpm"
        [[ -f "bun.lockb" ]] && PM="bun"

        # Check for test:coverage or test script
        if grep -q '"test:coverage"' package.json 2>/dev/null; then
            $PM run test:coverage 2>&1 | tail -50 || echo "Test coverage failed"
        elif grep -q '"test:run"' package.json 2>/dev/null; then
            $PM run test:run -- --coverage 2>&1 | tail -50 || echo "Test run failed"
        elif grep -q '"test"' package.json 2>/dev/null; then
            $PM test -- --coverage --run 2>&1 | tail -50 || echo "Test failed"
        else
            echo "No test script found in package.json"
        fi
    elif [[ -f "Cargo.toml" ]]; then
        cargo test 2>&1 | tail -30 || echo "Cargo test failed"
    elif [[ -f "go.mod" ]]; then
        go test -cover ./... 2>&1 | tail -30 || echo "Go test failed"
    elif [[ -f "pyproject.toml" ]] || [[ -f "pytest.ini" ]]; then
        pytest --cov 2>&1 | tail -30 || echo "Pytest failed"
    else
        echo "No recognized test framework"
    fi

    echo ""
fi

# ============================================================================
# Section 5: Deep Analysis (only for deep depth)
# ============================================================================
if [[ "$DEPTH" == "deep" ]]; then
    echo "=== Type Check ===" >&2
    if [[ -f "package.json" ]] && grep -q '"typecheck"' package.json 2>/dev/null; then
        PM="npm"
        [[ -f "yarn.lock" ]] && PM="yarn"
        [[ -f "pnpm-lock.yaml" ]] && PM="pnpm"
        $PM run typecheck 2>&1 || echo "Typecheck failed or not configured"
    elif [[ -f "tsconfig.json" ]]; then
        npx tsc --noEmit 2>&1 | tail -30 || echo "TypeScript check failed"
    else
        echo "No type checking available"
    fi

    echo ""

    echo "=== Lint Check ===" >&2
    if [[ -f "package.json" ]] && grep -q '"lint"' package.json 2>/dev/null; then
        PM="npm"
        [[ -f "yarn.lock" ]] && PM="yarn"
        [[ -f "pnpm-lock.yaml" ]] && PM="pnpm"
        $PM run lint 2>&1 | tail -30 || echo "Lint check had issues"
    else
        echo "No lint script available"
    fi
fi

echo "" >&2
echo "=== Context Collection Complete ===" >&2
