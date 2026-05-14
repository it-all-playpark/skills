#!/usr/bin/env bash
# test-status-distribution.sh - Verify analyze-dev-flow-family.sh aggregates
# the dev-implement worker's 4-value status enum into a status_distribution
# field (issue #92, AC5).
#
# This test creates a fixture journal directory with entries that carry
# context.return_status = DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT
# plus legacy success/fail counterparts, runs the script with
# CLAUDE_JOURNAL_DIR pointing at the fixture, and asserts the resulting JSON.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/../scripts/analyze-dev-flow-family.sh"

WORKDIR="$(mktemp -d -t dffd-status-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

FIXTURE_JOURNAL="$WORKDIR/journal"
mkdir -p "$FIXTURE_JOURNAL"

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

# ----------------------------------------------------------------------------
# Build fixture: 6 dev-implement entries within window, each carrying a
# different return_status (DONE x2, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT,
# legacy success and fail).
# ----------------------------------------------------------------------------
TS_RECENT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

build_entry() {
  local skill="$1" outcome="$2" return_status="$3" id="$4"
  jq -n \
    --arg skill "$skill" \
    --arg outcome "$outcome" \
    --arg return_status "$return_status" \
    --arg ts "$TS_RECENT" \
    --arg id "$id" \
    '{
       id: $id,
       skill: $skill,
       outcome: $outcome,
       timestamp: $ts,
       source: "log",
       context: ({
         return_status: $return_status
       } | with_entries(select(.value != "")))
     }'
}

build_entry "dev-implement" "success" "DONE"               "e1"  > "$FIXTURE_JOURNAL/e1.json"
build_entry "dev-implement" "success" "DONE"               "e2"  > "$FIXTURE_JOURNAL/e2.json"
build_entry "dev-implement" "success" "DONE_WITH_CONCERNS" "e3"  > "$FIXTURE_JOURNAL/e3.json"
build_entry "dev-implement" "failure" "BLOCKED"            "e4"  > "$FIXTURE_JOURNAL/e4.json"
build_entry "dev-implement" "partial" "NEEDS_CONTEXT"      "e5"  > "$FIXTURE_JOURNAL/e5.json"
# legacy variant A: outcome present but return_status missing → bucket as legacy_*
build_entry "dev-implement" "success" ""                   "e6"  > "$FIXTURE_JOURNAL/e6.json"
build_entry "dev-implement" "failure" ""                   "e7"  > "$FIXTURE_JOURNAL/e7.json"

# Run the script
OUTPUT=$(CLAUDE_JOURNAL_DIR="$FIXTURE_JOURNAL" SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
  "$SCRIPT" --window 7d 2>/dev/null || true)

printf 'Test suite: status_distribution aggregation (AC5)\n\n'

if [[ -z "$OUTPUT" ]]; then
  fail "analyze-dev-flow-family.sh produced output" "(empty stdout)"
  printf '\n  %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
  exit 1
fi

# ----------------------------------------------------------------------------
# per_skill entry for dev-implement must include status_distribution
# ----------------------------------------------------------------------------
DEV_IMPL=$(echo "$OUTPUT" | jq -c '.per_skill[] | select(.skill == "dev-implement")')

if [[ -z "$DEV_IMPL" || "$DEV_IMPL" == "null" ]]; then
  fail "per_skill contains dev-implement" "missing in output"
  printf '\n  %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
  exit 1
fi
pass "per_skill contains dev-implement"

SD=$(echo "$DEV_IMPL" | jq -c '.status_distribution // null')
if [[ "$SD" == "null" ]]; then
  fail "dev-implement entry has status_distribution field" "missing"
else
  pass "dev-implement entry has status_distribution field"
fi

assert_count() {
  local label="$1" key="$2" expected="$3"
  local actual
  actual=$(echo "$SD" | jq -r --arg k "$key" '.[$k] // 0')
  if [[ "$actual" == "$expected" ]]; then
    pass "$label ($key = $expected)"
  else
    fail "$label ($key = $expected)" "got: $actual"
  fi
}

assert_count "DONE bucket"               "DONE"               "2"
assert_count "DONE_WITH_CONCERNS bucket" "DONE_WITH_CONCERNS" "1"
assert_count "BLOCKED bucket"            "BLOCKED"            "1"
assert_count "NEEDS_CONTEXT bucket"      "NEEDS_CONTEXT"      "1"
assert_count "legacy_success bucket"     "legacy_success"     "1"
assert_count "legacy_fail bucket"        "legacy_fail"        "1"

# total_with_status counts entries that had a return_status: 2 DONE + 1 DWC + 1 BLOCKED + 1 NEEDS_CONTEXT = 5
TOTAL=$(echo "$SD" | jq -r '.total_with_status // 0')
if [[ "$TOTAL" == "5" ]]; then
  pass "total_with_status counts entries with explicit return_status (5)"
else
  fail "total_with_status counts entries with explicit return_status (5)" "got: $TOTAL"
fi

# ----------------------------------------------------------------------------
# Stuck detection ORs in (BLOCKED + NEEDS_CONTEXT) / total_with_status > 0.30
# Here (1+1)/4 = 0.5 > 0.30, so dev-implement should appear in stuck_skills.
# ----------------------------------------------------------------------------
STUCK_HIT=$(echo "$OUTPUT" | jq -r \
  '.findings.stuck_skills | map(select(.skill == "dev-implement")) | length')
if [[ "$STUCK_HIT" -ge 1 ]]; then
  pass "stuck detection picks up dev-implement via status-code OR rule"
else
  fail "stuck detection picks up dev-implement via status-code OR rule" \
    "expected >= 1 stuck entry for dev-implement"
fi

# Verify the stuck entry carries a status_distribution-derived reason field
STUCK_OBJ=$(echo "$OUTPUT" | jq -c \
  '.findings.stuck_skills[] | select(.skill == "dev-implement")')
if echo "$STUCK_OBJ" | jq -e '(.blocked_rate // null) != null' >/dev/null; then
  pass "stuck entry exposes blocked_rate detail"
else
  fail "stuck entry exposes blocked_rate detail" "missing field"
fi

# ----------------------------------------------------------------------------
# Explicit legacy return_status strings ("success" / "fail") must also be
# bucketed as legacy_* (subagent-dispatch.md L101-103 mapping). Add fresh
# fixture entries and re-run.
# ----------------------------------------------------------------------------
FIXTURE_JOURNAL2="$WORKDIR/journal2"
mkdir -p "$FIXTURE_JOURNAL2"
build_entry "dev-implement" "success" "DONE"      "ex1" > "$FIXTURE_JOURNAL2/ex1.json"
build_entry "dev-implement" "success" "success"   "ex2" > "$FIXTURE_JOURNAL2/ex2.json"
build_entry "dev-implement" "failure" "fail"      "ex3" > "$FIXTURE_JOURNAL2/ex3.json"

OUTPUT2=$(CLAUDE_JOURNAL_DIR="$FIXTURE_JOURNAL2" SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
  "$SCRIPT" --window 7d 2>/dev/null || true)
SD2=$(echo "$OUTPUT2" | jq -c '.per_skill[] | select(.skill == "dev-implement") | .status_distribution // null')

if [[ "$SD2" == "null" || -z "$SD2" ]]; then
  fail "explicit legacy fixture: status_distribution present" "missing"
else
  pass "explicit legacy fixture: status_distribution present"
  lg_s=$(echo "$SD2" | jq -r '.legacy_success // 0')
  lg_f=$(echo "$SD2" | jq -r '.legacy_fail // 0')
  done_count=$(echo "$SD2" | jq -r '.DONE // 0')
  unk=$(echo "$SD2" | jq -r '.unknown // 0')
  tws=$(echo "$SD2" | jq -r '.total_with_status // 0')

  if [[ "$lg_s" == "1" ]]; then
    pass "explicit return_status='success' bucketed as legacy_success"
  else
    fail "explicit return_status='success' bucketed as legacy_success" "got: $lg_s"
  fi
  if [[ "$lg_f" == "1" ]]; then
    pass "explicit return_status='fail' bucketed as legacy_fail"
  else
    fail "explicit return_status='fail' bucketed as legacy_fail" "got: $lg_f"
  fi
  if [[ "$done_count" == "1" ]]; then
    pass "explicit return_status='DONE' still bucketed correctly"
  else
    fail "explicit return_status='DONE' still bucketed correctly" "got: $done_count"
  fi
  if [[ "$unk" == "0" ]]; then
    pass "legacy strings do NOT leak into unknown bucket"
  else
    fail "legacy strings do NOT leak into unknown bucket" "unknown=$unk"
  fi
  # total_with_status only counts 4-value enum (DONE etc.), so just 1 (DONE) here
  if [[ "$tws" == "1" ]]; then
    pass "total_with_status excludes legacy buckets (counts only 4-value enum)"
  else
    fail "total_with_status excludes legacy buckets (counts only 4-value enum)" "got: $tws"
  fi
fi

printf '\n  %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
exit $(( FAIL_COUNT > 0 ? 1 : 0 ))
