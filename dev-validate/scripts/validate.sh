#!/usr/bin/env bash
# validate.sh - Run tests and quality checks with auto-detection

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

FIX_MODE=false STRICT_MODE=false WORKTREE_PATH=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --fix) FIX_MODE=true; shift ;;
        --strict) STRICT_MODE=true; shift ;;
        --worktree) WORKTREE_PATH="$2"; shift 2 ;;
        -h|--help) echo "Usage: validate.sh [--fix] [--strict] [--worktree <path>]"; exit 0 ;;
        *) shift ;;
    esac
done

[[ -n "$WORKTREE_PATH" ]] && cd "$WORKTREE_PATH"
WORK_DIR=$(pwd)

require_git_repo

# Check for changes
CHANGES=$(git status --short 2>/dev/null | wc -l | tr -d ' ')
if [[ "$CHANGES" -eq 0 ]]; then
    echo '{"status":"no_changes","exit_code":3}'
    exit 3
fi

# Get change stats
STATS=$(git diff --stat 2>/dev/null | tail -1 || echo "0 files")
FILES_CHANGED=$(echo "$STATS" | grep -oE '[0-9]+ file' | grep -oE '[0-9]+' || echo "0")
INSERTIONS=$(echo "$STATS" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo "0")
DELETIONS=$(echo "$STATS" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo "0")

# Run tests (suppress output, capture result only)
TEST_RESULT="skipped" TEST_EXIT=0

run_tests() {
    if [[ -f "package.json" ]]; then
        if grep -q '"test"' package.json 2>/dev/null; then
            local pm="npm"
            [[ -f "yarn.lock" ]] && pm="yarn"
            [[ -f "pnpm-lock.yaml" ]] && pm="pnpm"
            $pm test >/dev/null 2>&1 && TEST_RESULT="passed" || { TEST_RESULT="failed"; TEST_EXIT=1; }
        else
            TEST_RESULT="no_test_script"
        fi
    elif [[ -f "Cargo.toml" ]]; then
        cargo test >/dev/null 2>&1 && TEST_RESULT="passed" || { TEST_RESULT="failed"; TEST_EXIT=1; }
    elif [[ -f "go.mod" ]]; then
        go test ./... >/dev/null 2>&1 && TEST_RESULT="passed" || { TEST_RESULT="failed"; TEST_EXIT=1; }
    elif [[ -f "pytest.ini" ]] || [[ -f "pyproject.toml" ]]; then
        pytest >/dev/null 2>&1 && TEST_RESULT="passed" || { TEST_RESULT="failed"; TEST_EXIT=1; }
    elif [[ -f "Makefile" ]] && grep -q "^test:" Makefile 2>/dev/null; then
        make test >/dev/null 2>&1 && TEST_RESULT="passed" || { TEST_RESULT="failed"; TEST_EXIT=1; }
    fi
}

# Run lint (suppress output)
LINT_RESULT="skipped" LINT_EXIT=0

run_lint() {
    if [[ -f "package.json" ]]; then
        if grep -q '"lint"' package.json 2>/dev/null; then
            local pm="npm"
            [[ -f "yarn.lock" ]] && pm="yarn"
            [[ -f "pnpm-lock.yaml" ]] && pm="pnpm"
            
            if $FIX_MODE && grep -q '"lint:fix"' package.json 2>/dev/null; then
                $pm run lint:fix >/dev/null 2>&1 && LINT_RESULT="passed" || { LINT_RESULT="failed"; LINT_EXIT=2; }
            else
                $pm run lint >/dev/null 2>&1 && LINT_RESULT="passed" || { LINT_RESULT="failed"; LINT_EXIT=2; }
            fi
        fi
    elif [[ -f "Cargo.toml" ]]; then
        cargo clippy >/dev/null 2>&1 && LINT_RESULT="passed" || { LINT_RESULT="failed"; LINT_EXIT=2; }
    elif [[ -f "go.mod" ]] && command -v golangci-lint &>/dev/null; then
        golangci-lint run >/dev/null 2>&1 && LINT_RESULT="passed" || { LINT_RESULT="failed"; LINT_EXIT=2; }
    elif [[ -f "pyproject.toml" ]] && command -v ruff &>/dev/null; then
        if $FIX_MODE; then
            ruff check --fix . >/dev/null 2>&1 && LINT_RESULT="passed" || { LINT_RESULT="failed"; LINT_EXIT=2; }
        else
            ruff check . >/dev/null 2>&1 && LINT_RESULT="passed" || { LINT_RESULT="failed"; LINT_EXIT=2; }
        fi
    fi
}

run_tests
run_lint

# Determine overall status
OVERALL="pass" EXIT_CODE=0
[[ "$TEST_EXIT" -ne 0 ]] && { OVERALL="fail"; EXIT_CODE=1; }
[[ "$LINT_EXIT" -ne 0 ]] && { OVERALL="fail"; EXIT_CODE=2; }
[[ "$STRICT_MODE" == "true" && "$LINT_RESULT" == "skipped" ]] && { OVERALL="fail"; EXIT_CODE=2; }

cat <<JSONEOF
{
  "worktree": "$WORK_DIR",
  "changes": {"files": $FILES_CHANGED, "insertions": $INSERTIONS, "deletions": $DELETIONS},
  "tests": "$TEST_RESULT",
  "lint": "$LINT_RESULT",
  "overall": "$OVERALL",
  "exit_code": $EXIT_CODE
}
JSONEOF

exit $EXIT_CODE
