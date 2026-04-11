#!/usr/bin/env bash
# test-analyze-dev-flow-family.sh - Unit tests for analyze-dev-flow-family.sh
# Run: ./dev-flow-doctor/tests/test-analyze-dev-flow-family.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYZE_SH="$SCRIPT_DIR/../scripts/analyze-dev-flow-family.sh"
FIXTURES="$SCRIPT_DIR/fixtures/journal"
WORKDIR="$(mktemp -d -t dffd-test-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

FAIL_COUNT=0
PASS_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  \033[32mPASS\033[0m %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '  \033[31mFAIL\033[0m %s\n' "$1"
  if [[ -n "${2:-}" ]]; then
    printf '        %s\n' "$2"
  fi
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label" "expected='$expected' actual='$actual'"
  fi
}

# Use an empty config override so environment skill-config.json doesn't leak in
EMPTY_CONFIG="$WORKDIR/empty-config.json"
echo '{}' > "$EMPTY_CONFIG"

run_analyze() {
  CLAUDE_JOURNAL_DIR="$FIXTURES" \
  SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
    "$ANALYZE_SH" "$@"
}

printf 'Test suite: analyze-dev-flow-family.sh\n'
printf 'Fixtures: %s\n\n' "$FIXTURES"

# ----------------------------------------------------------------------------
# Test 1: Default window (30d) covers all fixtures
# ----------------------------------------------------------------------------
printf 'Test 1: default window 30d produces valid JSON\n'
RESULT=$(run_analyze --window 30d 2>&1)
if ! echo "$RESULT" | jq empty 2>/dev/null; then
  fail "30d produces valid JSON" "$RESULT"
else
  pass "30d produces valid JSON"
fi

# ----------------------------------------------------------------------------
# Test 2: family filter excludes non-family skills
# ----------------------------------------------------------------------------
printf '\nTest 2: non-family skills excluded\n'
# blog-cross-post should not appear in per_skill
BLOG_COUNT=$(echo "$RESULT" | jq '[.per_skill[] | select(.skill == "blog-cross-post")] | length')
assert_eq "blog-cross-post not in per_skill" "0" "$BLOG_COUNT"

# ----------------------------------------------------------------------------
# Test 3: dead phases
# ----------------------------------------------------------------------------
printf '\nTest 3: dead phase detection\n'
# dev-validate, dev-integrate, dev-evaluate, pr-iterate, night-patrol → dead
DEAD_COUNT=$(echo "$RESULT" | jq '.findings.dead_phases | length')
assert_eq "5 dead phases detected" "5" "$DEAD_COUNT"

# dev-kickoff (3 success) should NOT be dead
DK_DEAD=$(echo "$RESULT" | jq '[.findings.dead_phases[] | select(.skill == "dev-kickoff")] | length')
assert_eq "dev-kickoff not dead (has success)" "0" "$DK_DEAD"

# dev-validate should be dead
DV_DEAD=$(echo "$RESULT" | jq '[.findings.dead_phases[] | select(.skill == "dev-validate")] | length')
assert_eq "dev-validate is dead" "1" "$DV_DEAD"

# ----------------------------------------------------------------------------
# Test 4: stuck skills
# ----------------------------------------------------------------------------
printf '\nTest 4: stuck skill detection\n'
# pr-fix: 2 failure + 1 success out of 3 → failure_rate 0.666 > 0.30 AND total >= 3
STUCK_PRFIX=$(echo "$RESULT" | jq '[.findings.stuck_skills[] | select(.skill == "pr-fix")] | length')
assert_eq "pr-fix is stuck" "1" "$STUCK_PRFIX"

# dev-kickoff: 0% failure → not stuck
STUCK_DK=$(echo "$RESULT" | jq '[.findings.stuck_skills[] | select(.skill == "dev-kickoff")] | length')
assert_eq "dev-kickoff not stuck" "0" "$STUCK_DK"

# dev-implement: only 1 entry → excluded by min_total guard
STUCK_DI=$(echo "$RESULT" | jq '[.findings.stuck_skills[] | select(.skill == "dev-implement")] | length')
assert_eq "dev-implement excluded (min_total guard)" "0" "$STUCK_DI"

# ----------------------------------------------------------------------------
# Test 5: bottlenecks
# ----------------------------------------------------------------------------
printf '\nTest 5: bottleneck ranking\n'
BN_COUNT=$(echo "$RESULT" | jq '.findings.bottlenecks | length')
assert_eq "3 bottlenecks returned (top N=3)" "3" "$BN_COUNT"

BN_TOP=$(echo "$RESULT" | jq -r '.findings.bottlenecks[0].skill')
assert_eq "dev-kickoff is top bottleneck (avg 20 turns)" "dev-kickoff" "$BN_TOP"

# ----------------------------------------------------------------------------
# Test 6: disconnected skills
# ----------------------------------------------------------------------------
printf '\nTest 6: disconnected skill detection\n'
DISC_COUNT=$(echo "$RESULT" | jq '.findings.disconnected_skills | length')
# Same 5 dead skills are also disconnected (no own + no parent ref in fixtures)
assert_eq "5 disconnected skills detected" "5" "$DISC_COUNT"

# dev-kickoff has own entries → not disconnected
DISC_DK=$(echo "$RESULT" | jq '[.findings.disconnected_skills[] | select(.skill == "dev-kickoff")] | length')
assert_eq "dev-kickoff not disconnected" "0" "$DISC_DK"

# ----------------------------------------------------------------------------
# Test 7: per_skill statistics correctness
# ----------------------------------------------------------------------------
printf '\nTest 7: per_skill statistics\n'
DK_TOTAL=$(echo "$RESULT" | jq '[.per_skill[] | select(.skill == "dev-kickoff")][0].total')
assert_eq "dev-kickoff total = 3" "3" "$DK_TOTAL"

DK_AVG=$(echo "$RESULT" | jq '[.per_skill[] | select(.skill == "dev-kickoff")][0].avg_duration_turns')
assert_eq "dev-kickoff avg duration = 20" "20" "$DK_AVG"

PR_FAIL_RATE=$(echo "$RESULT" | jq '[.per_skill[] | select(.skill == "pr-fix")][0].failure_rate | . * 1000 | floor')
# 2/3 = 0.666... → floor(666.6) = 666
assert_eq "pr-fix failure_rate ≈ 0.666" "666" "$PR_FAIL_RATE"

# ----------------------------------------------------------------------------
# Test 8: window filter (--window 1d → everything filtered out, all dead)
# ----------------------------------------------------------------------------
printf '\nTest 8: narrow window filters entries\n'
RESULT_1D=$(run_analyze --window 1d 2>&1)
if ! echo "$RESULT_1D" | jq empty 2>/dev/null; then
  fail "1d produces valid JSON" "$RESULT_1D"
else
  pass "1d produces valid JSON"
fi
# With fixtures dated 2026-04-05..08 and today=2026-04-11, 1d window → 0 entries
DK_1D_TOTAL=$(echo "$RESULT_1D" | jq '[.per_skill[] | select(.skill == "dev-kickoff")][0].total')
assert_eq "dev-kickoff total = 0 in 1d window" "0" "$DK_1D_TOTAL"
DEAD_1D=$(echo "$RESULT_1D" | jq '.findings.dead_phases | length')
assert_eq "all 8 family skills dead in 1d window" "8" "$DEAD_1D"

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
printf '\n----------------------------------------\n'
printf 'Summary: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0
