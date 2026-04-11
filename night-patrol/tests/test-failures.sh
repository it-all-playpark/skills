#!/usr/bin/env bash
# test-failures.sh - TDD tests for night-patrol failures.sh helper
#
# Usage: ./test-failures.sh
# Exit: 0 on success, non-zero on failure

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILURES_SH="$SCRIPT_DIR/../scripts/failures.sh"

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------

TMPDIR_BASE=$(mktemp -d -t night-patrol-failures-test.XXXXXX)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

export NIGHT_PATROL_FAILURES_PATH="$TMPDIR_BASE/failures.json"

TESTS_RUN=0
TESTS_FAILED=0

assert_eq() {
    local actual="$1"
    local expected="$2"
    local msg="${3:-}"
    TESTS_RUN=$((TESTS_RUN + 1))
    if [[ "$actual" != "$expected" ]]; then
        TESTS_FAILED=$((TESTS_FAILED + 1))
        echo "FAIL: $msg"
        echo "  expected: $expected"
        echo "  actual:   $actual"
    else
        echo "PASS: $msg"
    fi
}

reset_state() {
    rm -f "$NIGHT_PATROL_FAILURES_PATH"
}

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

echo "=== Test: get on missing file returns count: 0 ==="
reset_state
out=$("$FAILURES_SH" get 41)
count=$(echo "$out" | jq -r '.count')
assert_eq "$count" "0" "get on fresh state returns count: 0"

echo "=== Test: incr creates file and increments count ==="
reset_state
out=$("$FAILURES_SH" incr 41 --reason "tests failed")
count=$(echo "$out" | jq -r '.count')
escalated=$(echo "$out" | jq -r '.escalated')
assert_eq "$count" "1" "first incr returns count: 1"
assert_eq "$escalated" "false" "first incr not escalated"

echo "=== Test: second incr escalates (max_failures=2) ==="
out=$("$FAILURES_SH" incr 41 --reason "tests failed again")
count=$(echo "$out" | jq -r '.count')
escalated=$(echo "$out" | jq -r '.escalated')
assert_eq "$count" "2" "second incr returns count: 2"
assert_eq "$escalated" "true" "second incr escalated"

echo "=== Test: get after incr returns last_reason ==="
out=$("$FAILURES_SH" get 41)
count=$(echo "$out" | jq -r '.count')
reason=$(echo "$out" | jq -r '.last_reason')
assert_eq "$count" "2" "get returns count: 2"
assert_eq "$reason" "tests failed again" "last_reason persisted"

echo "=== Test: reset clears count ==="
out=$("$FAILURES_SH" reset 41)
status=$(echo "$out" | jq -r '.status')
assert_eq "$status" "reset" "reset returns status: reset"

out=$("$FAILURES_SH" get 41)
count=$(echo "$out" | jq -r '.count')
assert_eq "$count" "0" "get after reset returns count: 0"

echo "=== Test: independent issues tracked separately ==="
reset_state
"$FAILURES_SH" incr 10 --reason "r1" > /dev/null
"$FAILURES_SH" incr 20 --reason "r2" > /dev/null
"$FAILURES_SH" incr 20 --reason "r2 again" > /dev/null
out10=$("$FAILURES_SH" get 10)
out20=$("$FAILURES_SH" get 20)
assert_eq "$(echo "$out10" | jq -r '.count')" "1" "issue 10 count: 1"
assert_eq "$(echo "$out20" | jq -r '.count')" "2" "issue 20 count: 2"

echo "=== Test: list returns all issues ==="
out=$("$FAILURES_SH" list)
has_10=$(echo "$out" | jq -r '.issues["10"].count')
has_20=$(echo "$out" | jq -r '.issues["20"].count')
assert_eq "$has_10" "1" "list contains issue 10"
assert_eq "$has_20" "2" "list contains issue 20"

echo "=== Test: max_failures override via env ==="
reset_state
export NIGHT_PATROL_MAX_FAILURES=3
out=$("$FAILURES_SH" incr 99 --reason "x")
assert_eq "$(echo "$out" | jq -r '.escalated')" "false" "3-threshold: 1st not escalated"
out=$("$FAILURES_SH" incr 99 --reason "x")
assert_eq "$(echo "$out" | jq -r '.escalated')" "false" "3-threshold: 2nd not escalated"
out=$("$FAILURES_SH" incr 99 --reason "x")
assert_eq "$(echo "$out" | jq -r '.escalated')" "true" "3-threshold: 3rd escalated"
unset NIGHT_PATROL_MAX_FAILURES

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "=========================================="
echo "Tests run:    $TESTS_RUN"
echo "Tests failed: $TESTS_FAILED"
echo "=========================================="

if (( TESTS_FAILED > 0 )); then
    exit 1
fi
exit 0
