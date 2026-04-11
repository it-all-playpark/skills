#!/usr/bin/env bash
# test-check-diff-scale.sh - Tests for dev-plan-impl/scripts/check-diff-scale.sh
# Run: bash tests/dev-plan-impl/test-check-diff-scale.sh
#
# Exit 0 on success, non-zero on failure.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET="$REPO_ROOT/dev-plan-impl/scripts/check-diff-scale.sh"

TESTS_PASSED=0
TESTS_FAILED=0
FAIL_MESSAGES=()

pass() {
    TESTS_PASSED=$((TESTS_PASSED + 1))
    printf "  ok   %s\n" "$1"
}

fail() {
    TESTS_FAILED=$((TESTS_FAILED + 1))
    FAIL_MESSAGES+=("$1: $2")
    printf "  FAIL %s -- %s\n" "$1" "$2"
}

assert_eq() {
    local name="$1"; local expected="$2"; local actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        pass "$name"
    else
        fail "$name" "expected='$expected' actual='$actual'"
    fi
}

# --- setup tmpdir ---
TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

PREV="$TMPDIR_TEST/prev.md"
CURR="$TMPDIR_TEST/curr.md"

echo "==> Running tests for check-diff-scale.sh"
echo "    target: $TARGET"

# precondition: script exists
if [[ ! -x "$TARGET" ]]; then
    echo "FATAL: $TARGET not found or not executable" >&2
    exit 2
fi

# Test (a): previous does not exist -> status skipped
RESULT=$("$TARGET" --current "$CURR" --previous "$TMPDIR_TEST/does-not-exist.md" 2>/dev/null || true)
STATUS=$(echo "$RESULT" | jq -r '.status')
assert_eq "a_previous_missing_status_skipped" "skipped" "$STATUS"

# Test (b): previous == current -> ratio 0, status ok
printf 'line1\nline2\nline3\n' > "$PREV"
cp "$PREV" "$CURR"
RESULT=$("$TARGET" --current "$CURR" --previous "$PREV" 2>/dev/null)
STATUS=$(echo "$RESULT" | jq -r '.status')
RATIO_IS_ZERO=$(echo "$RESULT" | jq -r '.ratio | if . == 0 then "yes" else "no" end')
assert_eq "b_identical_status_ok" "ok" "$STATUS"
assert_eq "b_identical_ratio_zero" "yes" "$RATIO_IS_ZERO"

# Test (c): near full rewrite (all 5 lines replaced in a 5-line file -> ratio = 2.0) -> warning
printf 'old1\nold2\nold3\nold4\nold5\n' > "$PREV"
printf 'new1\nnew2\nnew3\nnew4\nnew5\n' > "$CURR"
STDERR_FILE="$TMPDIR_TEST/stderr.txt"
RESULT=$("$TARGET" --current "$CURR" --previous "$PREV" 2>"$STDERR_FILE")
STATUS=$(echo "$RESULT" | jq -r '.status')
assert_eq "c_full_rewrite_status_warning" "warning" "$STATUS"
if grep -q "diff ratio" "$STDERR_FILE"; then
    pass "c_full_rewrite_stderr_warning"
else
    fail "c_full_rewrite_stderr_warning" "stderr lacks 'diff ratio' text: $(cat "$STDERR_FILE")"
fi

# Test (d): --max-ratio 3.0 override (higher than 2.0) turns warning into ok
RESULT=$("$TARGET" --current "$CURR" --previous "$PREV" --max-ratio 3.0 2>/dev/null)
STATUS=$(echo "$RESULT" | jq -r '.status')
assert_eq "d_max_ratio_override_ok" "ok" "$STATUS"

# Test (e): script returns exit 0 even when warning (non-blocking)
"$TARGET" --current "$CURR" --previous "$PREV" >/dev/null 2>/dev/null
EXIT_CODE=$?
assert_eq "e_warning_exit_zero" "0" "$EXIT_CODE"

# Test (f): small diff (1 line changed out of 10) -> ok
printf 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n' > "$PREV"
printf 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nCHANGED\n' > "$CURR"
RESULT=$("$TARGET" --current "$CURR" --previous "$PREV" 2>/dev/null)
STATUS=$(echo "$RESULT" | jq -r '.status')
assert_eq "f_small_diff_status_ok" "ok" "$STATUS"

# Test (g): non-numeric --max-ratio -> non-zero exit with error JSON on stderr
ERR_OUT=$("$TARGET" --current "$CURR" --previous "$PREV" --max-ratio "abc" 2>&1 >/dev/null) || true
EXIT_CODE=0
"$TARGET" --current "$CURR" --previous "$PREV" --max-ratio "abc" >/dev/null 2>&1 || EXIT_CODE=$?
if [[ $EXIT_CODE -ne 0 ]]; then
    pass "g_nonnumeric_cli_max_ratio_fails_exit"
else
    fail "g_nonnumeric_cli_max_ratio_fails_exit" "expected non-zero exit, got $EXIT_CODE"
fi
ERR_STATUS=$(echo "$ERR_OUT" | jq -r '.status' 2>/dev/null || echo "")
assert_eq "g_nonnumeric_cli_max_ratio_error_json" "error" "$ERR_STATUS"

# Test (h): negative --max-ratio -> non-zero exit
"$TARGET" --current "$CURR" --previous "$PREV" --max-ratio "-0.1" >/dev/null 2>&1
EXIT_CODE=$?
if [[ $EXIT_CODE -ne 0 ]]; then
    pass "h_negative_cli_max_ratio_fails_exit"
else
    fail "h_negative_cli_max_ratio_fails_exit" "expected non-zero exit, got $EXIT_CODE"
fi

# Test (i): non-numeric config.plan_review.max_diff_ratio -> non-zero exit
WTREE="$TMPDIR_TEST/wtree"
mkdir -p "$WTREE/.claude"
cat > "$WTREE/.claude/kickoff.json" <<'JSON'
{"config":{"plan_review":{"max_diff_ratio":"not-a-number"}}}
JSON
"$TARGET" --current "$CURR" --previous "$PREV" --worktree "$WTREE" >/dev/null 2>&1
EXIT_CODE=$?
if [[ $EXIT_CODE -ne 0 ]]; then
    pass "i_nonnumeric_config_max_diff_ratio_fails_exit"
else
    fail "i_nonnumeric_config_max_diff_ratio_fails_exit" "expected non-zero exit, got $EXIT_CODE"
fi

# Test (j): numeric config.plan_review.max_diff_ratio -> honored
cat > "$WTREE/.claude/kickoff.json" <<'JSON'
{"config":{"plan_review":{"max_diff_ratio":3.0}}}
JSON
# Re-use the full-rewrite previous/current from test (c) — recreate to make j self-contained.
printf 'old1\nold2\nold3\nold4\nold5\n' > "$PREV"
printf 'new1\nnew2\nnew3\nnew4\nnew5\n' > "$CURR"
RESULT=$("$TARGET" --current "$CURR" --previous "$PREV" --worktree "$WTREE" 2>/dev/null)
STATUS=$(echo "$RESULT" | jq -r '.status')
assert_eq "j_numeric_config_max_diff_ratio_applies" "ok" "$STATUS"
MAX_OUT=$(echo "$RESULT" | jq -r '.max_ratio')
assert_eq "j_numeric_config_max_diff_ratio_value" "3.0" "$MAX_OUT"

# --- summary ---
echo ""
echo "==> Summary: $TESTS_PASSED passed, $TESTS_FAILED failed"
if [[ $TESTS_FAILED -gt 0 ]]; then
    printf '%s\n' "${FAIL_MESSAGES[@]}"
    exit 1
fi
exit 0
