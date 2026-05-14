#!/usr/bin/env bash
# test-ci-workflow-no-glue-errors.sh - Verify lint.yml contains no-glue-errors job (AC5)
# Run: ./dev-flow-doctor/tests/test-ci-workflow-no-glue-errors.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/lint.yml"

FAIL_COUNT=0
PASS_COUNT=0

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

printf 'Test suite: CI workflow lint.yml — no-glue-errors job (AC5)\n\n'

# ----------------------------------------------------------------------------
# Test 1: workflow file exists
# ----------------------------------------------------------------------------
printf 'Test 1: workflow file present\n'
if [[ -f "$WORKFLOW" ]]; then pass "lint.yml exists"; else fail "lint.yml exists at $WORKFLOW"; fi

# ----------------------------------------------------------------------------
# Test 2: workflow contains no-glue-errors job name
# ----------------------------------------------------------------------------
printf '\nTest 2: lint.yml contains no-glue-errors job\n'
if grep -qE 'no[-_]glue[-_]errors' "$WORKFLOW" 2>/dev/null; then
  pass "lint.yml references no-glue-errors"
else
  fail "lint.yml references no-glue-errors"
fi

# ----------------------------------------------------------------------------
# Test 3: workflow invokes tests/no-glue-errors.sh
# ----------------------------------------------------------------------------
printf '\nTest 3: workflow invokes tests/no-glue-errors.sh\n'
if grep -qE 'tests/no-glue-errors\.sh' "$WORKFLOW" 2>/dev/null; then
  pass "workflow runs tests/no-glue-errors.sh"
else
  fail "workflow runs tests/no-glue-errors.sh"
fi

# ----------------------------------------------------------------------------
# Test 4: workflow sets BASELINE_FILE env to templates fallback
# ----------------------------------------------------------------------------
printf '\nTest 4: workflow sets BASELINE_FILE to templates fallback\n'
if grep -qE 'BASELINE_FILE.*templates/baseline-pre-79\.example\.json' "$WORKFLOW" 2>/dev/null; then
  pass "BASELINE_FILE references templates fallback"
else
  fail "BASELINE_FILE references templates fallback"
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
printf '\n=== Summary ===\nPASS: %d\nFAIL: %d\n' "$PASS_COUNT" "$FAIL_COUNT"
if [[ "$FAIL_COUNT" -gt 0 ]]; then exit 1; else exit 0; fi
