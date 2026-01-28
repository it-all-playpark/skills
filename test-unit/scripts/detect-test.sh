#!/usr/bin/env bash
# detect-test.sh - Detect test framework and commands
# Shared by all test-* skills

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

DIR="${1:-.}"
cd "$DIR" || die_json "Cannot access directory: $DIR"

FRAMEWORK="" RUNNER="" UNIT_CMD="" COVERAGE_CMD="" E2E_CMD="" WATCH_CMD=""
HAS_PLAYWRIGHT="false" HAS_CYPRESS="false"

if [[ -f "package.json" ]]; then
    PM="npm"
    [[ -f "pnpm-lock.yaml" ]] && PM="pnpm"
    [[ -f "yarn.lock" ]] && PM="yarn"
    [[ -f "bun.lockb" ]] && PM="bun"

    if [[ -f "vitest.config.ts" ]] || [[ -f "vitest.config.js" ]] || grep -q '"vitest"' package.json 2>/dev/null; then
        FRAMEWORK="vitest" RUNNER="$PM run test" UNIT_CMD="$PM run test"
        COVERAGE_CMD="$PM run test -- --coverage" WATCH_CMD="$PM run test -- --watch"
    elif [[ -f "jest.config.ts" ]] || [[ -f "jest.config.js" ]] || grep -q '"jest"' package.json 2>/dev/null; then
        FRAMEWORK="jest" RUNNER="$PM test" UNIT_CMD="$PM test"
        COVERAGE_CMD="$PM test -- --coverage" WATCH_CMD="$PM test -- --watch"
    elif grep -q '"test"' package.json 2>/dev/null; then
        FRAMEWORK="npm-script" RUNNER="$PM test" UNIT_CMD="$PM test"
    fi

    if [[ -f "playwright.config.ts" ]] || [[ -f "playwright.config.js" ]] || grep -q '"@playwright/test"' package.json 2>/dev/null; then
        HAS_PLAYWRIGHT="true" E2E_CMD="$PM exec playwright test"
    elif [[ -f "cypress.config.ts" ]] || [[ -f "cypress.config.js" ]] || grep -q '"cypress"' package.json 2>/dev/null; then
        HAS_CYPRESS="true" E2E_CMD="$PM exec cypress run"
    fi
elif [[ -f "Cargo.toml" ]]; then
    FRAMEWORK="cargo" RUNNER="cargo test" UNIT_CMD="cargo test --lib"
    COVERAGE_CMD="cargo tarpaulin" WATCH_CMD="cargo watch -x test"
elif [[ -f "go.mod" ]]; then
    FRAMEWORK="go" RUNNER="go test" UNIT_CMD="go test ./..."
    COVERAGE_CMD="go test -cover ./..." WATCH_CMD="go test ./... -v"
elif [[ -f "pytest.ini" ]] || [[ -f "pyproject.toml" ]] || [[ -f "setup.py" ]]; then
    FRAMEWORK="pytest" RUNNER="pytest" UNIT_CMD="pytest"
    COVERAGE_CMD="pytest --cov" WATCH_CMD="pytest-watch"
elif [[ -f "Makefile" ]] && grep -q "^test:" Makefile 2>/dev/null; then
    FRAMEWORK="make" RUNNER="make test" UNIT_CMD="make test"
fi

[[ -z "$FRAMEWORK" ]] && die_json "No test framework detected in $(pwd)"

cat <<JSONEOF
{
  "framework": "$FRAMEWORK",
  "runner": $(json_str "$RUNNER"),
  "commands": {
    "unit": $(json_str "$UNIT_CMD"),
    "coverage": $(json_str "$COVERAGE_CMD"),
    "e2e": $(json_str "$E2E_CMD"),
    "watch": $(json_str "$WATCH_CMD")
  },
  "has_playwright": $HAS_PLAYWRIGHT,
  "has_cypress": $HAS_CYPRESS,
  "directory": "$(pwd)"
}
JSONEOF
