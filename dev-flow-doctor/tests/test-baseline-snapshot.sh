#!/usr/bin/env bash
# test-baseline-snapshot.sh - Unit tests for baseline-snapshot.sh
# Run: ./dev-flow-doctor/tests/test-baseline-snapshot.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNAPSHOT_SH="$SCRIPT_DIR/../scripts/baseline-snapshot.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE_FILE="$REPO_ROOT/dev-flow-doctor/templates/baseline-pre-79.example.json"
JOURNAL_CLEAN="$SCRIPT_DIR/fixtures/journal-glue/clean"
JOURNAL_REGRESSED="$SCRIPT_DIR/fixtures/journal-glue/regressed"

WORKDIR="$(mktemp -d -t dffd-bsnap-XXXXXX)"
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
assert_nonempty() {
  local label="$1" actual="$2"
  if [[ -n "$actual" && "$actual" != "null" ]]; then pass "$label"; else fail "$label" "value was empty/null"; fi
}

run_snapshot() {
  CLAUDE_JOURNAL_DIR="$1" \
  SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
    "$SNAPSHOT_SH" "${@:2}"
}

# helper: ISO8601 UTC timestamp N days before now (BSD/GNU dual)
days_ago_iso() {
  local n="$1"
  date -u -v-"${n}"d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
    date -u -d "${n} days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null
}

printf 'Test suite: baseline-snapshot.sh\n\n'

# ----------------------------------------------------------------------------
# Test 1: Snapshot schema fields present
# ----------------------------------------------------------------------------
printf 'Test 1: snapshot schema has required fields\n'
RESULT=$(run_snapshot "$JOURNAL_CLEAN" --window 30d 2>&1)
if ! echo "$RESULT" | jq empty 2>/dev/null; then
  fail "snapshot produces valid JSON" "$RESULT"
else
  pass "snapshot produces valid JSON"
fi
for field in window per_skill per_phase error_categories glue_errors total_entries family_skills; do
  HAS=$(echo "$RESULT" | jq "has(\"$field\")" 2>/dev/null)
  assert_eq "snapshot has field: $field" "true" "$HAS"
done

# ----------------------------------------------------------------------------
# Test 2: window field equals "30d"
# ----------------------------------------------------------------------------
printf '\nTest 2: window field equals "30d"\n'
WINDOW_VAL=$(echo "$RESULT" | jq -r '.window // ""')
assert_eq "snapshot.window == 30d" "30d" "$WINDOW_VAL"

# ----------------------------------------------------------------------------
# Test 3: glue_errors counted from journal fixture
# ----------------------------------------------------------------------------
printf '\nTest 3: glue_errors detection\n'
RESULT_REGRESSED=$(run_snapshot "$JOURNAL_REGRESSED" --window 30d 2>&1)
GLUE_COUNT=$(echo "$RESULT_REGRESSED" | jq '.glue_errors.count // 0')
if [[ "$GLUE_COUNT" -gt 0 ]]; then
  pass "glue_errors.count > 0 for regressed fixture (got $GLUE_COUNT)"
else
  fail "glue_errors.count > 0 for regressed fixture" "got $GLUE_COUNT"
fi

CLEAN_GLUE=$(echo "$RESULT" | jq '.glue_errors.count // 0')
if [[ "$CLEAN_GLUE" -eq 0 ]]; then
  pass "glue_errors.count == 0 for clean fixture"
else
  fail "glue_errors.count == 0 for clean fixture" "got $CLEAN_GLUE"
fi

# ----------------------------------------------------------------------------
# Test 4: per-skill aggregation excludes non-family unless --include-non-family
# ----------------------------------------------------------------------------
printf '\nTest 4: per-skill aggregation\n'
# Default family filter
DEV_KICKOFF_COUNT=$(echo "$RESULT" | jq '[.per_skill[] | select(.skill == "dev-kickoff")] | length')
assert_eq "dev-kickoff in per_skill" "1" "$DEV_KICKOFF_COUNT"
BLOG_COUNT=$(echo "$RESULT" | jq '[.per_skill[] | select(.skill == "blog-cross-post")] | length')
assert_eq "blog-cross-post NOT in per_skill (family filter)" "0" "$BLOG_COUNT"

# ----------------------------------------------------------------------------
# Test 5: templates/baseline-pre-79.example.json schema compliance
# ----------------------------------------------------------------------------
printf '\nTest 5: templates/baseline-pre-79.example.json conforms to snapshot schema\n'
if [[ ! -f "$TEMPLATE_FILE" ]]; then
  fail "template file exists" "$TEMPLATE_FILE"
else
  pass "template file exists"
  if ! jq empty "$TEMPLATE_FILE" 2>/dev/null; then
    fail "template is valid JSON"
  else
    pass "template is valid JSON"
  fi
  for field in window per_skill per_phase error_categories glue_errors total_entries; do
    HAS=$(jq "has(\"$field\")" "$TEMPLATE_FILE" 2>/dev/null)
    assert_eq "template has field: $field" "true" "$HAS"
  done
  TEMPL_WINDOW=$(jq -r '.window // ""' "$TEMPLATE_FILE" 2>/dev/null)
  assert_eq "template.window == 30d" "30d" "$TEMPL_WINDOW"
fi

# ----------------------------------------------------------------------------
# Test 6: --out <path> writes file
# ----------------------------------------------------------------------------
printf '\nTest 6: --out flag writes to file\n'
OUT_FILE="$WORKDIR/snapshot.json"
CLAUDE_JOURNAL_DIR="$JOURNAL_CLEAN" SKILL_CONFIG_PATH="$EMPTY_CONFIG" \
  "$SNAPSHOT_SH" --window 30d --out "$OUT_FILE" >/dev/null 2>&1
if [[ -s "$OUT_FILE" ]] && jq empty "$OUT_FILE" 2>/dev/null; then
  pass "--out wrote valid JSON to file"
else
  fail "--out wrote valid JSON to file" "$OUT_FILE missing or invalid"
fi

# ----------------------------------------------------------------------------
# Test 7: --until <iso8601> bounds the window to [since, until)
# ----------------------------------------------------------------------------
printf '\nTest 7: --until bounds the window\n'
ROLLING_JOURNAL="$WORKDIR/journal-rolling"
mkdir -p "$ROLLING_JOURNAL"

TS_20D=$(days_ago_iso 20)
TS_10D=$(days_ago_iso 10)
TS_2D=$(days_ago_iso 2)

cat > "$ROLLING_JOURNAL/entry-20d.json" <<EOF
{"version":"1.0.0","id":"e-20d","timestamp":"$TS_20D","skill":"pr-iterate","outcome":"success","duration_turns":5,"context":{}}
EOF
cat > "$ROLLING_JOURNAL/entry-10d.json" <<EOF
{"version":"1.0.0","id":"e-10d","timestamp":"$TS_10D","skill":"pr-iterate","outcome":"success","duration_turns":5,"context":{}}
EOF
cat > "$ROLLING_JOURNAL/entry-2d.json" <<EOF
{"version":"1.0.0","id":"e-2d","timestamp":"$TS_2D","skill":"pr-iterate","outcome":"success","duration_turns":5,"context":{}}
EOF

UNTIL_7D=$(days_ago_iso 7)
RESULT_UNTIL=$(run_snapshot "$ROLLING_JOURNAL" --window 7d --until "$UNTIL_7D" 2>&1)
UNTIL_TOTAL=$(echo "$RESULT_UNTIL" | jq '.total_entries // -1')
assert_eq "--until 7d ago: total_entries == 1 (only now-10d entry)" "1" "$UNTIL_TOTAL"
UNTIL_VAL=$(echo "$RESULT_UNTIL" | jq -r '.until // "MISSING"')
assert_eq "--until echoed in output.until" "$UNTIL_7D" "$UNTIL_VAL"
UNTIL_SINCE=$(echo "$RESULT_UNTIL" | jq -r '.since // "MISSING"')
EXPECTED_SINCE=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$UNTIL_7D" -v-7d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
  date -u -d "$UNTIL_7D 7 days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
assert_eq "--until 7d: .since == until - 7d" "$EXPECTED_SINCE" "$UNTIL_SINCE"

# --until omitted: .until == null, and total_entries counts from since (no upper bound)
RESULT_NO_UNTIL=$(run_snapshot "$ROLLING_JOURNAL" --window 7d 2>&1)
NO_UNTIL_VAL=$(echo "$RESULT_NO_UNTIL" | jq -c '.until')
assert_eq "--until omitted: .until == null" "null" "$NO_UNTIL_VAL"
NO_UNTIL_TOTAL=$(echo "$RESULT_NO_UNTIL" | jq '.total_entries // -1')
assert_eq "--until omitted: total_entries == 1 (only now-2d entry within 7d window)" "1" "$NO_UNTIL_TOTAL"

# --until with invalid format -> exit 1, stderr JSON error
ERR_OUT=$(run_snapshot "$ROLLING_JOURNAL" --window 7d --until "not-a-date" 2>&1)
ERR_EC=$?
if [[ "$ERR_EC" -eq 1 ]]; then pass "--until invalid format: exit code 1"; else fail "--until invalid format: exit code 1" "got $ERR_EC"; fi
if echo "$ERR_OUT" | jq -e '.status == "error"' >/dev/null 2>&1; then
  pass "--until invalid format: stderr is JSON error"
else
  fail "--until invalid format: stderr is JSON error" "$ERR_OUT"
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
printf '\n=== Summary ===\nPASS: %d\nFAIL: %d\n' "$PASS_COUNT" "$FAIL_COUNT"
if [[ "$FAIL_COUNT" -gt 0 ]]; then exit 1; else exit 0; fi
