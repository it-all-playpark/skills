#!/usr/bin/env bash
# test-no-glue-errors-threshold.sh - Tests for tests/no-glue-errors.sh threshold mode
# Run: ./dev-flow-doctor/tests/test-no-glue-errors-threshold.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
NGE_SH="$REPO_ROOT/tests/no-glue-errors.sh"
FIX_BASELINE="$SCRIPT_DIR/fixtures/baseline"
JOURNAL_CLEAN="$SCRIPT_DIR/fixtures/journal-glue/clean"
JOURNAL_REGRESSED="$SCRIPT_DIR/fixtures/journal-glue/regressed"

WORKDIR="$(mktemp -d -t dffd-nge-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

EMPTY_CONFIG="$WORKDIR/empty-config.json"
echo '{}' > "$EMPTY_CONFIG"

FAIL_COUNT=0
PASS_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  \033[32mPASS\033[0m %s\n' "$1"
}
fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '  \033[31mFAIL\033[0m %s\n' "$1"
  if [[ -n "${2:-}" ]]; then printf '        %s\n' "$2"; fi
}
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label" "expected='$expected' actual='$actual'"; fi
}

printf 'Test suite: tests/no-glue-errors.sh threshold mode\n\n'

# ----------------------------------------------------------------------------
# Test 1: No baseline → exit 0 (graceful degradation)
# ----------------------------------------------------------------------------
printf 'Test 1: no baseline file → exit 0 (graceful degradation)\n'
BASELINE_FILE="$WORKDIR/non-existent.json" \
CLAUDE_JOURNAL_DIR="$JOURNAL_CLEAN" \
SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
  "$NGE_SH" >/dev/null 2>&1
EC=$?
assert_eq "exit 0 when baseline missing" "0" "$EC"

# ----------------------------------------------------------------------------
# Test 2: Baseline matches current (no regression) → exit 0
# ----------------------------------------------------------------------------
printf '\nTest 2: baseline matches current → exit 0\n'
BASELINE_FILE="$FIX_BASELINE/pre-79.json" \
CLAUDE_JOURNAL_DIR="$JOURNAL_CLEAN" \
SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
  "$NGE_SH" >/dev/null 2>&1
EC=$?
assert_eq "exit 0 when no regression" "0" "$EC"

# ----------------------------------------------------------------------------
# Test 3: Current > baseline by max_regression+1 → exit 1
# ----------------------------------------------------------------------------
printf '\nTest 3: current > baseline + max_regression → exit 1\n'
# Use a baseline with count=0 so any regressed fixture exceeds it
BASE_ZERO="$WORKDIR/baseline-zero.json"
jq '.glue_errors.count = 0 | .glue_errors.samples = []' "$FIX_BASELINE/pre-79.json" > "$BASE_ZERO"
BASELINE_FILE="$BASE_ZERO" \
CLAUDE_JOURNAL_DIR="$JOURNAL_REGRESSED" \
SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
  "$NGE_SH" >/dev/null 2>&1
EC=$?
assert_eq "exit 1 when regression detected" "1" "$EC"

# ----------------------------------------------------------------------------
# Test 4: Error message includes baseline / current counts
# ----------------------------------------------------------------------------
printf '\nTest 4: error message includes baseline / current counts\n'
OUT=$(BASELINE_FILE="$BASE_ZERO" \
      CLAUDE_JOURNAL_DIR="$JOURNAL_REGRESSED" \
      SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
      "$NGE_SH" 2>&1)
if echo "$OUT" | grep -qiE "baseline.*[0-9].*current.*[0-9]|current.*[0-9].*baseline.*[0-9]"; then
  pass "output mentions baseline & current numbers"
else
  fail "output mentions baseline & current numbers" "got: $OUT"
fi

# ----------------------------------------------------------------------------
# Test 5: window is taken from baseline.window
# ----------------------------------------------------------------------------
printf '\nTest 5: window driven by baseline.window field (not hardcoded 7d)\n'
# Baseline with 30d window → no-glue-errors must invoke snapshot with --window 30d.
# We assert: output mentions "30d" (the baseline's window), not "7 days" hardcoded
OUT=$(BASELINE_FILE="$FIX_BASELINE/pre-79.json" \
      CLAUDE_JOURNAL_DIR="$JOURNAL_CLEAN" \
      SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
      "$NGE_SH" 2>&1)
if echo "$OUT" | grep -qE "30d|30 days"; then
  pass "output mentions baseline.window (30d)"
else
  fail "output mentions baseline.window (30d)" "got: $OUT"
fi

# ----------------------------------------------------------------------------
# Test 6: corrupt baseline → warning + exit 0 (compare exit 2 fallback)
# ----------------------------------------------------------------------------
printf '\nTest 6: corrupt baseline → warning + exit 0 (compare exit 2 fallback)\n'
CORRUPT="$WORKDIR/corrupt.json"
echo 'not json' > "$CORRUPT"
BASELINE_FILE="$CORRUPT" \
CLAUDE_JOURNAL_DIR="$JOURNAL_CLEAN" \
SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
  "$NGE_SH" >/dev/null 2>&1
EC=$?
assert_eq "exit 0 when baseline is corrupt (fallback)" "0" "$EC"

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
printf '\n=== Summary ===\nPASS: %d\nFAIL: %d\n' "$PASS_COUNT" "$FAIL_COUNT"
if [[ "$FAIL_COUNT" -gt 0 ]]; then exit 1; else exit 0; fi
