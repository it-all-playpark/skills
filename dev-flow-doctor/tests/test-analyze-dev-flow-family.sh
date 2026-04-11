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
# Test 9: cold-start — empty journal dir triggers insufficient_data in
# run-diagnostics.sh --scope family and family penalty stays at 0.
# ----------------------------------------------------------------------------
printf '\nTest 9: cold-start guard (empty journal)\n'
EMPTY_JOURNAL="$WORKDIR/empty-journal"
mkdir -p "$EMPTY_JOURNAL"

# analyze script on empty dir: every family skill has total=0 → all dead,
# all disconnected. This is the raw behaviour the cold-start guard must
# translate into insufficient_data at the diagnostics layer.
COLD_RAW=$(CLAUDE_JOURNAL_DIR="$EMPTY_JOURNAL" SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
  "$ANALYZE_SH" --window 30d 2>&1)
if ! echo "$COLD_RAW" | jq empty 2>/dev/null; then
  fail "analyze produces valid JSON on empty journal" "$COLD_RAW"
else
  pass "analyze produces valid JSON on empty journal"
fi
COLD_TOTAL=$(echo "$COLD_RAW" | jq '[.per_skill[].total] | add // 0')
assert_eq "empty journal → family total entries = 0" "0" "$COLD_TOTAL"

# Diagnostics layer: run-diagnostics.sh should skip family penalty.
DIAG_SH="$SCRIPT_DIR/../scripts/run-diagnostics.sh"
COLD_DIAG=$(CLAUDE_JOURNAL_DIR="$EMPTY_JOURNAL" SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
  "$DIAG_SH" --scope family --window 30d 2>&1)
if ! echo "$COLD_DIAG" | jq empty 2>/dev/null; then
  fail "run-diagnostics cold-start produces valid JSON" "$COLD_DIAG"
else
  pass "run-diagnostics cold-start produces valid JSON"
fi
COLD_STATUS=$(echo "$COLD_DIAG" | jq -r '.checks.dev_flow_family.status // ""')
assert_eq "cold-start family status = insufficient_data" "insufficient_data" "$COLD_STATUS"
COLD_SCORE=$(echo "$COLD_DIAG" | jq '.score')
assert_eq "cold-start score stays 100 (no family penalty)" "100" "$COLD_SCORE"
COLD_SCORE_SCOPE=$(echo "$COLD_DIAG" | jq -r '.score_scope // ""')
assert_eq "cold-start score_scope = family" "family" "$COLD_SCORE_SCOPE"

# ----------------------------------------------------------------------------
# Test 10: broken JSON mix — one malformed file must not blank the whole
# journal. Valid entries should still be aggregated.
# ----------------------------------------------------------------------------
printf '\nTest 10: parse error fallback (broken JSON mix)\n'
MIXED_JOURNAL="$WORKDIR/mixed-journal"
mkdir -p "$MIXED_JOURNAL"
# Copy all existing fixtures
cp "$FIXTURES"/*.json "$MIXED_JOURNAL"/
# Add a malformed file that would break `jq -s '.' "${files[@]}"`
printf '{"broken": ' > "$MIXED_JOURNAL/2026-04-09-10-00-00-broken.json"

MIXED_RESULT=$(CLAUDE_JOURNAL_DIR="$MIXED_JOURNAL" SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
  "$ANALYZE_SH" --window 30d 2>&1)
if ! echo "$MIXED_RESULT" | jq empty 2>/dev/null; then
  fail "mixed journal produces valid JSON" "$MIXED_RESULT"
else
  pass "mixed journal produces valid JSON"
fi
# dev-kickoff still has its 3 valid entries
MIXED_DK_TOTAL=$(echo "$MIXED_RESULT" | jq '[.per_skill[] | select(.skill == "dev-kickoff")][0].total')
assert_eq "broken file ignored: dev-kickoff total = 3" "3" "$MIXED_DK_TOTAL"
# pr-fix still has its 3 entries
MIXED_PF_TOTAL=$(echo "$MIXED_RESULT" | jq '[.per_skill[] | select(.skill == "pr-fix")][0].total')
assert_eq "broken file ignored: pr-fix total = 3" "3" "$MIXED_PF_TOTAL"

# ----------------------------------------------------------------------------
# Test 11: parent_refs — a hook-capture entry referencing a family skill
# excludes that skill from disconnected_skills, and substring lookalikes
# (e.g. "dev-validate-extra") do NOT count as a reference to "dev-validate".
# ----------------------------------------------------------------------------
printf '\nTest 11: parent_refs & word-boundary match\n'
PARENT_JOURNAL="$WORKDIR/parent-journal"
mkdir -p "$PARENT_JOURNAL"
cp "$FIXTURES"/*.json "$PARENT_JOURNAL"/
# hook-capture entry that references dev-integrate (via "Skill: dev-integrate")
cat > "$PARENT_JOURNAL/2026-04-09-12-00-00-hook-capture.json" <<'JSON'
{
  "version": "1.0.0",
  "id": "20260409T120000-hook-capture",
  "timestamp": "2026-04-09T12:00:00Z",
  "skill": "hook-capture",
  "source": "hook-capture",
  "outcome": "success",
  "duration_turns": 0,
  "context": {
    "input_summary": "Skill: dev-integrate --subtask A"
  }
}
JSON
# hook-capture entry that mentions ONLY a substring lookalike of dev-validate
cat > "$PARENT_JOURNAL/2026-04-09-12-05-00-hook-capture.json" <<'JSON'
{
  "version": "1.0.0",
  "id": "20260409T120500-hook-capture",
  "timestamp": "2026-04-09T12:05:00Z",
  "skill": "hook-capture",
  "source": "hook-capture",
  "outcome": "success",
  "duration_turns": 0,
  "context": {
    "input_summary": "Skill: dev-validate-extra --foo bar"
  }
}
JSON

PARENT_RESULT=$(CLAUDE_JOURNAL_DIR="$PARENT_JOURNAL" SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
  "$ANALYZE_SH" --window 30d 2>&1)
if ! echo "$PARENT_RESULT" | jq empty 2>/dev/null; then
  fail "parent-ref journal produces valid JSON" "$PARENT_RESULT"
else
  pass "parent-ref journal produces valid JSON"
fi

# dev-integrate has no own entries but IS referenced → should NOT be disconnected
DI_DISC=$(echo "$PARENT_RESULT" | jq '[.findings.disconnected_skills[] | select(.skill == "dev-integrate")] | length')
assert_eq "dev-integrate not disconnected (parent ref matched)" "0" "$DI_DISC"

# dev-validate has no own entries and only a substring-lookalike reference
# → substring must NOT count, so it should still be disconnected.
DV_DISC=$(echo "$PARENT_RESULT" | jq '[.findings.disconnected_skills[] | select(.skill == "dev-validate")] | length')
assert_eq "dev-validate still disconnected (substring lookalike)" "1" "$DV_DISC"

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
printf '\n----------------------------------------\n'
printf 'Summary: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0
