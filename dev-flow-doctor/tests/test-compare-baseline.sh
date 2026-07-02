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
# Rolling mode tests (--rolling --window <N>d)
# ----------------------------------------------------------------------------

# helper: ISO8601 UTC timestamp N days before now (BSD/GNU dual)
days_ago_iso() {
  local n="$1"
  date -u -v-"${n}"d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
    date -u -d "${n} days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null
}

# gen_entry <dir> <name> <days_ago> <outcome>
gen_entry() {
  local dir="$1" name="$2" days_ago="$3" outcome="$4"
  local ts
  ts=$(days_ago_iso "$days_ago")
  cat > "$dir/$name.json" <<EOF
{"version":"1.0.0","id":"$name","timestamp":"$ts","skill":"pr-iterate","outcome":"$outcome","duration_turns":5,"context":{}}
EOF
}

ROLLING_CONFIG="$WORKDIR/rolling-config.json"
cat > "$ROLLING_CONFIG" <<'EOF'
{"dev-flow-doctor":{"baseline":{"rolling":{"ratio_threshold":1.5,"min_entries_per_window":5}}}}
EOF

run_compare_rolling() {
  "$COMPARE_SH" --config "$ROLLING_CONFIG" "$@"
}

# ----------------------------------------------------------------------------
# Test 7: rolling regression (recent error_count 3x previous) -> exit 1
# ----------------------------------------------------------------------------
printf '\nTest 7: rolling regression (recent error_count 3x previous) -> exit 1\n'
J7="$WORKDIR/journal-rolling-regressed"
mkdir -p "$J7"
gen_entry "$J7" r1 1 failure
gen_entry "$J7" r2 2 failure
gen_entry "$J7" r3 3 failure
gen_entry "$J7" r4 4 success
gen_entry "$J7" r5 5 success
gen_entry "$J7" r6 6 success
gen_entry "$J7" r7 6 success
gen_entry "$J7" p1 8 failure
gen_entry "$J7" p2 9 success
gen_entry "$J7" p3 10 success
gen_entry "$J7" p4 11 success
gen_entry "$J7" p5 12 success
gen_entry "$J7" p6 13 success
gen_entry "$J7" p7 13 success
OUT=$(CLAUDE_JOURNAL_DIR="$J7" run_compare_rolling --rolling --window 7d 2>&1)
EC=$?
if [[ "$EC" -eq 1 ]]; then pass "rolling regression: exit code 1"; else fail "rolling regression: exit code 1" "got $EC / out: $OUT"; fi
MODE=$(echo "$OUT" | jq -r '.mode // ""' 2>/dev/null)
assert_eq "rolling regression: .mode == rolling" "rolling" "$MODE"
FIND_METRIC=$(echo "$OUT" | jq -r '[.findings[] | select(.metric == "error_count") | .metric] | first // ""' 2>/dev/null)
assert_eq "rolling regression: findings has metric == error_count" "error_count" "$FIND_METRIC"
FIND_SEV=$(echo "$OUT" | jq -r '[.findings[] | select(.metric == "error_count") | .severity] | first // ""' 2>/dev/null)
assert_eq "rolling regression: severity == critical" "critical" "$FIND_SEV"
FIND_RATIO=$(echo "$OUT" | jq -r '[.findings[] | select(.metric == "error_count") | .ratio] | first // ""' 2>/dev/null)
assert_eq "rolling regression: ratio == 3" "3" "$FIND_RATIO"

# ----------------------------------------------------------------------------
# Test 8: rolling improved (recent error_count < previous) -> exit 0, direction improved
# ----------------------------------------------------------------------------
printf '\nTest 8: rolling improved (recent error_count < previous) -> exit 0, direction improved\n'
J8="$WORKDIR/journal-rolling-improved"
mkdir -p "$J8"
gen_entry "$J8" r1 1 failure
gen_entry "$J8" r2 2 success
gen_entry "$J8" r3 3 success
gen_entry "$J8" r4 4 success
gen_entry "$J8" r5 5 success
gen_entry "$J8" r6 6 success
gen_entry "$J8" r7 6 success
gen_entry "$J8" p1 8 failure
gen_entry "$J8" p2 9 failure
gen_entry "$J8" p3 10 failure
gen_entry "$J8" p4 11 success
gen_entry "$J8" p5 12 success
gen_entry "$J8" p6 13 success
gen_entry "$J8" p7 13 success
OUT=$(CLAUDE_JOURNAL_DIR="$J8" run_compare_rolling --rolling --window 7d 2>&1)
EC=$?
if [[ "$EC" -eq 0 ]]; then pass "rolling improved: exit code 0"; else fail "rolling improved: exit code 0" "got $EC / out: $OUT"; fi
FIND_LEN=$(echo "$OUT" | jq '.findings | length' 2>/dev/null)
assert_eq "rolling improved: findings empty" "0" "$FIND_LEN"
DIR_VAL=$(echo "$OUT" | jq -r '[.metrics[] | select(.metric == "error_count") | .direction] | first // ""' 2>/dev/null)
assert_eq "rolling improved: error_count direction == improved" "improved" "$DIR_VAL"

# ----------------------------------------------------------------------------
# Test 9: rolling zero-previous smoothing (0 -> 1 does not alert) -> exit 0
# ----------------------------------------------------------------------------
printf '\nTest 9: rolling zero-previous smoothing (0->1 does not alert) -> exit 0\n'
J9="$WORKDIR/journal-rolling-smoothing"
mkdir -p "$J9"
gen_entry "$J9" r1 1 failure
gen_entry "$J9" r2 2 success
gen_entry "$J9" r3 3 success
gen_entry "$J9" r4 4 success
gen_entry "$J9" r5 5 success
gen_entry "$J9" p1 8 success
gen_entry "$J9" p2 9 success
gen_entry "$J9" p3 10 success
gen_entry "$J9" p4 11 success
gen_entry "$J9" p5 12 success
OUT=$(CLAUDE_JOURNAL_DIR="$J9" run_compare_rolling --rolling --window 7d 2>&1)
EC=$?
if [[ "$EC" -eq 0 ]]; then pass "rolling smoothing: exit code 0"; else fail "rolling smoothing: exit code 0" "got $EC / out: $OUT"; fi
FIND_LEN=$(echo "$OUT" | jq '.findings | length' 2>/dev/null)
assert_eq "rolling smoothing: findings empty (add-one smoothing)" "0" "$FIND_LEN"

# ----------------------------------------------------------------------------
# Test 10: rolling insufficient_data (each window < min_entries_per_window) -> exit 0
# ----------------------------------------------------------------------------
printf '\nTest 10: rolling insufficient_data (each window < min_entries_per_window) -> exit 0\n'
J10="$WORKDIR/journal-rolling-sparse"
mkdir -p "$J10"
gen_entry "$J10" r1 1 failure
gen_entry "$J10" r2 2 success
gen_entry "$J10" p1 8 failure
gen_entry "$J10" p2 9 success
# insufficient_data emits a warning line on stderr alongside the JSON on
# stdout — capture separately so the JSON stays parseable.
OUT=$(CLAUDE_JOURNAL_DIR="$J10" run_compare_rolling --rolling --window 7d 2>/dev/null)
EC=$?
if [[ "$EC" -eq 0 ]]; then pass "rolling insufficient_data: exit code 0"; else fail "rolling insufficient_data: exit code 0" "got $EC / out: $OUT"; fi
INSUFF=$(echo "$OUT" | jq -r '.insufficient_data // "MISSING"' 2>/dev/null)
assert_eq "rolling insufficient_data: .insufficient_data == true" "true" "$INSUFF"
FIND_LEN=$(echo "$OUT" | jq '.findings | length' 2>/dev/null)
assert_eq "rolling insufficient_data: findings empty" "0" "$FIND_LEN"

# ----------------------------------------------------------------------------
# Test 11: --rolling combined with --baseline/--current -> exit 2
# ----------------------------------------------------------------------------
printf '\nTest 11: --rolling combined with --baseline -> exit 2\n'
run_compare_rolling --rolling --window 7d --baseline "$FIX/pre-79.json" >/dev/null 2>&1
EC=$?
if [[ "$EC" -eq 2 ]]; then pass "rolling+baseline conflict: exit code 2"; else fail "rolling+baseline conflict: exit code 2" "got $EC"; fi

# ----------------------------------------------------------------------------
# Test 12: --rolling without --window -> exit 2
# ----------------------------------------------------------------------------
printf '\nTest 12: --rolling without --window -> exit 2\n'
run_compare_rolling --rolling >/dev/null 2>&1
EC=$?
if [[ "$EC" -eq 2 ]]; then pass "rolling without window: exit code 2"; else fail "rolling without window: exit code 2" "got $EC"; fi

# ----------------------------------------------------------------------------
# Test 12b: --rolling --window with invalid format -> exit 2
# ----------------------------------------------------------------------------
printf '\nTest 12b: --rolling --window 7x (invalid format) -> exit 2\n'
run_compare_rolling --rolling --window 7x >/dev/null 2>&1
EC=$?
if [[ "$EC" -eq 2 ]]; then pass "rolling invalid window format: exit code 2"; else fail "rolling invalid window format: exit code 2" "got $EC"; fi

# ----------------------------------------------------------------------------
# Test 13: rolling output schema (mode/windows/insufficient_data present)
# ----------------------------------------------------------------------------
printf '\nTest 13: rolling output schema (mode/windows/insufficient_data present)\n'
OUT=$(CLAUDE_JOURNAL_DIR="$J7" run_compare_rolling --rolling --window 7d 2>&1)
for field in mode windows insufficient_data; do
  HAS=$(echo "$OUT" | jq "has(\"$field\")" 2>/dev/null)
  assert_eq "rolling output has field: $field" "true" "$HAS"
done
PREV_TOTAL_TYPE=$(echo "$OUT" | jq -r '.windows.previous.total_entries | type' 2>/dev/null)
assert_eq "windows.previous.total_entries is number" "number" "$PREV_TOTAL_TYPE"

# ----------------------------------------------------------------------------
# Test 14: fixed mode output includes mode == "fixed" (additive)
# ----------------------------------------------------------------------------
printf '\nTest 14: fixed mode output includes mode == "fixed" (additive)\n'
OUT=$(run_compare --baseline "$FIX/pre-79.json" --current "$FIX/post-79-improved.json" 2>&1)
MODE_VAL=$(echo "$OUT" | jq -r '.mode // "MISSING"' 2>/dev/null)
assert_eq "fixed mode: .mode == fixed" "fixed" "$MODE_VAL"

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
printf '\n=== Summary ===\nPASS: %d\nFAIL: %d\n' "$PASS_COUNT" "$FAIL_COUNT"
if [[ "$FAIL_COUNT" -gt 0 ]]; then exit 1; else exit 0; fi
