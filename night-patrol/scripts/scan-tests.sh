#!/usr/bin/env bash
# scan-tests.sh - Detect failing and skipped tests
# Usage: scan-tests.sh [--dir PATH]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Args
# ============================================================================

TARGET_DIR="."

while [[ $# -gt 0 ]]; do
    case $1 in
        --dir) TARGET_DIR="$2"; shift 2 ;;
        -h|--help) echo "Usage: scan-tests.sh [--dir PATH]"; exit 0 ;;
        *) shift ;;
    esac
done

cd "$TARGET_DIR"
require_git_repo

# ============================================================================
# Project type detection
# ============================================================================

PROJECT_TYPE="unknown"
PKG_MANAGER="npm"

if [[ -f "package.json" ]]; then
    PROJECT_TYPE="node"
    [[ -f "yarn.lock" ]]      && PKG_MANAGER="yarn"
    [[ -f "pnpm-lock.yaml" ]] && PKG_MANAGER="pnpm"
elif [[ -f "Cargo.toml" ]]; then
    PROJECT_TYPE="rust"
elif [[ -f "go.mod" ]]; then
    PROJECT_TYPE="go"
elif [[ -f "pyproject.toml" ]] || [[ -f "requirements.txt" ]]; then
    PROJECT_TYPE="python"
fi

# ============================================================================
# Run tests (allow failure — we want output)
# ============================================================================

TEST_OUTPUT=""
FINDINGS=()

run_tests() {
    case "$PROJECT_TYPE" in
        node)
            if grep -q '"test"' package.json 2>/dev/null; then
                TEST_OUTPUT=$($PKG_MANAGER test 2>&1 || true)
            fi
            ;;
        rust)
            TEST_OUTPUT=$(cargo test 2>&1 || true)
            ;;
        go)
            TEST_OUTPUT=$(go test ./... 2>&1 || true)
            ;;
        python)
            if command -v pytest &>/dev/null; then
                TEST_OUTPUT=$(pytest -v 2>&1 || true)
            fi
            ;;
    esac
}

# ============================================================================
# Parse failing tests from output
# ============================================================================

parse_failing_tests() {
    [[ -z "$TEST_OUTPUT" ]] && return

    case "$PROJECT_TYPE" in
        node)
            # Jest / Vitest: "● Test suite name > test name"
            while IFS= read -r line; do
                if [[ "$line" =~ ^[[:space:]]*●[[:space:]]+(.*) ]]; then
                    local test_name="${BASH_REMATCH[1]}"
                    # Find next non-empty line as error context
                    local error_line=""
                    local found=false
                    while IFS= read -r next; do
                        if $found; then
                            [[ -n "${next// }" ]] && { error_line="$next"; break; }
                        fi
                        [[ "$next" == "$line" ]] && found=true
                    done <<< "$TEST_OUTPUT"
                    FINDINGS+=("{\"type\":\"failing\",\"test\":$(json_str "$test_name"),\"error\":$(json_str "$error_line")}")
                fi
            done <<< "$TEST_OUTPUT"
            ;;
        rust)
            # "test path::to::test_name ... FAILED"
            while IFS= read -r line; do
                if [[ "$line" =~ ^test[[:space:]](.+)[[:space:]]\\.\\.\\.[[:space:]]FAILED ]]; then
                    local test_name="${BASH_REMATCH[1]}"
                    FINDINGS+=("{\"type\":\"failing\",\"test\":$(json_str "$test_name"),\"error\":$(json_str "FAILED")}")
                fi
            done <<< "$TEST_OUTPUT"
            ;;
        go)
            # "--- FAIL: TestName (0.00s)"
            while IFS= read -r line; do
                if [[ "$line" =~ ^---[[:space:]]FAIL:[[:space:]]([^[:space:]]+) ]]; then
                    local test_name="${BASH_REMATCH[1]}"
                    FINDINGS+=("{\"type\":\"failing\",\"test\":$(json_str "$test_name"),\"error\":$(json_str "FAIL")}")
                fi
            done <<< "$TEST_OUTPUT"
            ;;
        python)
            # "FAILED tests/test_foo.py::test_bar - AssertionError: ..."
            while IFS= read -r line; do
                if [[ "$line" =~ ^FAILED[[:space:]]([^[:space:]]+)[[:space:]]-[[:space:]](.+) ]]; then
                    local test_name="${BASH_REMATCH[1]}"
                    local error_line="${BASH_REMATCH[2]}"
                    FINDINGS+=("{\"type\":\"failing\",\"test\":$(json_str "$test_name"),\"error\":$(json_str "$error_line")}")
                elif [[ "$line" =~ ^FAILED[[:space:]]([^[:space:]]+) ]]; then
                    local test_name="${BASH_REMATCH[1]}"
                    FINDINGS+=("{\"type\":\"failing\",\"test\":$(json_str "$test_name"),\"error\":null}")
                fi
            done <<< "$TEST_OUTPUT"
            ;;
    esac
}

# ============================================================================
# Grep source files for skipped tests
# ============================================================================

scan_skipped_tests() {
    local patterns=('\.skip\b' '\.todo\b' '\bxit\(' '\bxdescribe\(')
    local extensions=("js" "ts" "jsx" "tsx" "mjs" "cjs" "spec.js" "test.js")

    # Build file extensions glob
    local ext_pattern="\.(js|ts|jsx|tsx|mjs|cjs)$"

    while IFS= read -r filepath; do
        [[ -f "$filepath" ]] || continue
        local lineno=0
        while IFS= read -r content_line; do
            lineno=$((lineno + 1))
            for pat in "${patterns[@]}"; do
                if echo "$content_line" | grep -qE "$pat" 2>/dev/null; then
                    local rel_path
                    rel_path=$(realpath --relative-to="$(pwd)" "$filepath" 2>/dev/null || echo "$filepath")
                    FINDINGS+=("{\"type\":\"skipped\",\"file\":$(json_str "$rel_path"),\"line\":$lineno,\"content\":$(json_str "${content_line// /}")}")
                    break
                fi
            done
        done < "$filepath"
    done < <(git ls-files 2>/dev/null | grep -E "$ext_pattern" || true)

    # Also check Python test files for skip markers
    while IFS= read -r filepath; do
        [[ -f "$filepath" ]] || continue
        local lineno=0
        while IFS= read -r content_line; do
            lineno=$((lineno + 1))
            if echo "$content_line" | grep -qE '@pytest\.mark\.skip|unittest\.skip\b|\.skip\b' 2>/dev/null; then
                local rel_path
                rel_path=$(realpath --relative-to="$(pwd)" "$filepath" 2>/dev/null || echo "$filepath")
                FINDINGS+=("{\"type\":\"skipped\",\"file\":$(json_str "$rel_path"),\"line\":$lineno,\"content\":$(json_str "${content_line// /}")}")
            fi
        done < "$filepath"
    done < <(git ls-files 2>/dev/null | grep -E "\.(py)$" || true)
}

# ============================================================================
# Main
# ============================================================================

run_tests
parse_failing_tests
scan_skipped_tests

# Output JSON array
if [[ ${#FINDINGS[@]} -eq 0 ]]; then
    echo "[]"
else
    echo "["
    for i in "${!FINDINGS[@]}"; do
        if [[ $i -lt $((${#FINDINGS[@]} - 1)) ]]; then
            echo "  ${FINDINGS[$i]},"
        else
            echo "  ${FINDINGS[$i]}"
        fi
    done
    echo "]"
fi
