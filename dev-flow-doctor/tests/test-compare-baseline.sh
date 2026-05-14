#!/usr/bin/env bash
# test-compare-baseline.sh - Unit tests for compare-baseline.sh
# Run: ./dev-flow-doctor/tests/test-compare-baseline.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPARE_SH="$SCRIPT_DIR/../scripts/compare-baseline.sh"
FIX="$SCRIPT_DIR/fixtures/baseline"

WORKDIR="$(mktemp -d -t dffd-cmp-XXXXXX)"
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

# helper: capture exit code separately
run_compare() {
  SKILL_CONFIG_PATH="$EMPTY_CONFIG" "$COMPARE_SH" "$@"
}

printf 'Test suite: compare-baseline.sh\n\n'

# ----------------------------------------------------------------------------
# Test 1: regressed direction when current glue > baseline
# ----------------------------------------------------------------------------
printf 'Test 1: regressed direction (current > baseline)\n'
OUT=$(run_compare --baseline "$FIX/pre-79.json" --current "$FIX/post-79-regressed.json" 2>&1)
EC=$?
DIRECTION=$(echo "$OUT" | jq -r '[.metrics[] | select(.metric == "glue_errors.count") | .direction] | first // ""')
assert_eq "glue_errors direction == regressed" "regressed" "$DIRECTION"
# findings should include critical for glue
FIND_SEV=$(echo "$OUT" | jq -r '[.findings[] | select(.metric == "glue_errors.count") | .severity] | first // ""')
assert_eq "findings[].severity == critical for glue regression" "critical" "$FIND_SEV"
# exit code 1 (regression detected)
if [[ "$EC" -eq 1 ]]; then pass "exit code 1 (regression)"; else fail "exit code 1 (regression)" "got $EC"; fi

# ----------------------------------------------------------------------------
# Test 2: improved direction when current < baseline
# ----------------------------------------------------------------------------
printf '\nTest 2: improved direction (current < baseline)\n'
OUT=$(run_compare --baseline "$FIX/pre-79.json" --current "$FIX/post-79-improved.json" 2>&1)
EC=$?
DIRECTION=$(echo "$OUT" | jq -r '[.metrics[] | select(.metric == "glue_errors.count") | .direction] | first // ""')
assert_eq "glue_errors direction == improved" "improved" "$DIRECTION"
# findings should be empty (no regression)
FIND_LEN=$(echo "$OUT" | jq '.findings | length')
assert_eq "findings[] empty when no regression" "0" "$FIND_LEN"
# exit code 0
if [[ "$EC" -eq 0 ]]; then pass "exit code 0 (no regression)"; else fail "exit code 0 (no regression)" "got $EC"; fi

# ----------------------------------------------------------------------------
# Test 3: unchanged when equal
# ----------------------------------------------------------------------------
printf '\nTest 3: unchanged direction (current == baseline)\n'
OUT=$(run_compare --baseline "$FIX/pre-79.json" --current "$FIX/pre-79.json" 2>&1)
EC=$?
# All metrics direction == unchanged
NON_UNCHANGED=$(echo "$OUT" | jq '[.metrics[] | select(.direction != "unchanged")] | length')
assert_eq "all metrics unchanged when same file compared" "0" "$NON_UNCHANGED"
if [[ "$EC" -eq 0 ]]; then pass "exit code 0 (unchanged)"; else fail "exit code 0 (unchanged)" "got $EC"; fi

# ----------------------------------------------------------------------------
# Test 4: window mismatch detection
# ----------------------------------------------------------------------------
printf '\nTest 4: window mismatch → exit 2, severity=error\n'
MISMATCH="$WORKDIR/post-7d.json"
jq '.window = "7d"' "$FIX/post-79-improved.json" > "$MISMATCH"
OUT=$(run_compare --baseline "$FIX/pre-79.json" --current "$MISMATCH" 2>&1)
EC=$?
if [[ "$EC" -eq 2 ]]; then pass "exit code 2 (window mismatch)"; else fail "exit code 2 (window mismatch)" "got $EC"; fi
ERR_SEV=$(echo "$OUT" | jq -r '[.findings[] | select(.severity == "error")] | length' 2>/dev/null || echo 0)
if [[ "$ERR_SEV" -gt 0 ]]; then pass "findings[].severity == error for window mismatch"; else fail "findings[].severity == error for window mismatch" "got $ERR_SEV"; fi

# ----------------------------------------------------------------------------
# Test 5: corrupt baseline → exit 2
# ----------------------------------------------------------------------------
printf '\nTest 5: corrupt baseline → exit 2\n'
CORRUPT="$WORKDIR/corrupt.json"
echo 'this is not json' > "$CORRUPT"
run_compare --baseline "$CORRUPT" --current "$FIX/post-79-improved.json" >/dev/null 2>&1
EC=$?
if [[ "$EC" -eq 2 ]]; then pass "exit code 2 (corrupt baseline)"; else fail "exit code 2 (corrupt baseline)" "got $EC"; fi

# ----------------------------------------------------------------------------
# Test 6: output schema has window, metrics, findings top-level fields
# ----------------------------------------------------------------------------
printf '\nTest 6: output schema top-level fields\n'
OUT=$(run_compare --baseline "$FIX/pre-79.json" --current "$FIX/post-79-improved.json" 2>&1)
for field in window metrics findings; do
  HAS=$(echo "$OUT" | jq "has(\"$field\")" 2>/dev/null)
  assert_eq "output has field: $field" "true" "$HAS"
done

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
printf '\n=== Summary ===\nPASS: %d\nFAIL: %d\n' "$PASS_COUNT" "$FAIL_COUNT"
if [[ "$FAIL_COUNT" -gt 0 ]]; then exit 1; else exit 0; fi
