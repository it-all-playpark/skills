#!/usr/bin/env bash
# test-analyze-termination-loops.sh - Unit tests for analyze-termination-loops.sh (issue #53)
#
# Run: ./dev-flow-doctor/tests/test-analyze-termination-loops.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYZE_SH="$SCRIPT_DIR/../scripts/analyze-termination-loops.sh"

command -v jq >/dev/null || { echo "jq required"; exit 1; }

PASS=0
FAIL=0
pass() { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "${2:-}"; }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label" "expected='$expected' actual='$actual'"; fi
}

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

# Create a fake worktree-base directory
BASE="$TMP_ROOT/worktrees"
mkdir -p "$BASE"

make_kickoff() {
  local name="$1" phase="$2" content="$3"
  local dir="$BASE/$name/.claude"
  mkdir -p "$dir"
  echo "$content" > "$dir/kickoff.json"
}

# ----------------------------------------------------------------------------
# Test 1: script exists and is executable
# ----------------------------------------------------------------------------
printf 'Test 1: script exists\n'
if [[ -x "$ANALYZE_SH" ]]; then
  pass "analyze-termination-loops.sh exists and is executable"
else
  fail "analyze-termination-loops.sh exists" "missing: $ANALYZE_SH"
  printf '\nSummary: %d passed, %d failed\n' "$PASS" "$FAIL"
  exit 1
fi

# ----------------------------------------------------------------------------
# Test 2: empty worktree-base → valid JSON with empty findings
# ----------------------------------------------------------------------------
printf '\nTest 2: empty worktree-base\n'
EMPTY_BASE="$TMP_ROOT/empty"
mkdir -p "$EMPTY_BASE"
RESULT=$("$ANALYZE_SH" --worktree-base "$EMPTY_BASE" 2>&1)
if echo "$RESULT" | jq empty 2>/dev/null; then
  pass "empty base produces valid JSON"
  FINDINGS_LEN=$(echo "$RESULT" | jq '.findings | length')
  assert_eq "empty base findings length = 0" "0" "$FINDINGS_LEN"
else
  fail "empty base produces valid JSON" "$RESULT"
fi

# ----------------------------------------------------------------------------
# Test 3: repeated feedback_target (design 2 iterations in a row) → finding
# ----------------------------------------------------------------------------
printf '\nTest 3: repeated feedback_target detected\n'
make_kickoff "wt-repeat" "6_evaluate" '{
  "issue": 100,
  "updated_at": "2026-04-10T00:00:00Z",
  "phases": {
    "6_evaluate": {
      "termination": {
        "reason": "max_iterations",
        "final_iteration": 3,
        "final_verdict": "fail",
        "verdict_history": [
          {"iteration":1,"verdict":"fail","feedback_target":"design"},
          {"iteration":2,"verdict":"fail","feedback_target":"design"},
          {"iteration":3,"verdict":"fail","feedback_target":"implementation"}
        ]
      }
    }
  }
}'
RESULT=$("$ANALYZE_SH" --worktree-base "$BASE" 2>&1)
REPEAT_COUNT=$(echo "$RESULT" | jq '[.findings[] | select(.pattern == "repeated_feedback_target")] | length')
assert_eq "repeated_feedback_target finding count = 1" "1" "$REPEAT_COUNT"
TARGET=$(echo "$RESULT" | jq -r '[.findings[] | select(.pattern == "repeated_feedback_target")][0].feedback_target')
assert_eq "repeated target = design" "design" "$TARGET"

# ----------------------------------------------------------------------------
# Test 4: feedback_target alternates → no repeated finding
# ----------------------------------------------------------------------------
printf '\nTest 4: alternating feedback_target NOT flagged\n'
rm -rf "$BASE"/*
make_kickoff "wt-alt" "6_evaluate" '{
  "issue": 101,
  "updated_at": "2026-04-10T00:00:00Z",
  "phases": {
    "6_evaluate": {
      "termination": {
        "reason": "max_iterations",
        "final_iteration": 3,
        "final_verdict": "fail",
        "verdict_history": [
          {"iteration":1,"verdict":"fail","feedback_target":"design"},
          {"iteration":2,"verdict":"fail","feedback_target":"implementation"},
          {"iteration":3,"verdict":"fail","feedback_target":"design"}
        ]
      }
    }
  }
}'
RESULT=$("$ANALYZE_SH" --worktree-base "$BASE" 2>&1)
REPEAT_COUNT=$(echo "$RESULT" | jq '[.findings[] | select(.pattern == "repeated_feedback_target")] | length')
assert_eq "alternating → no repeated_feedback_target" "0" "$REPEAT_COUNT"

# ----------------------------------------------------------------------------
# Test 5: Phase 3b stuck termination → finding
# ----------------------------------------------------------------------------
printf '\nTest 5: phase 3b stuck termination\n'
rm -rf "$BASE"/*
make_kickoff "wt-stuck" "3b_plan_review" '{
  "issue": 102,
  "updated_at": "2026-04-10T00:00:00Z",
  "phases": {
    "3b_plan_review": {
      "termination": {
        "reason": "stuck",
        "final_iteration": 2,
        "final_verdict": "revise",
        "verdict_history": [
          {"iteration":1,"verdict":"revise","score":70},
          {"iteration":2,"verdict":"revise","score":71}
        ]
      }
    }
  }
}'
RESULT=$("$ANALYZE_SH" --worktree-base "$BASE" 2>&1)
STUCK_COUNT=$(echo "$RESULT" | jq '[.findings[] | select(.pattern == "stuck")] | length')
assert_eq "stuck finding count = 1" "1" "$STUCK_COUNT"
PHASE=$(echo "$RESULT" | jq -r '[.findings[] | select(.pattern == "stuck")][0].phase')
assert_eq "stuck finding phase = 3b_plan_review" "3b_plan_review" "$PHASE"

# ----------------------------------------------------------------------------
# Test 6: max_iterations termination → finding
# ----------------------------------------------------------------------------
printf '\nTest 6: max_iterations termination\n'
rm -rf "$BASE"/*
make_kickoff "wt-maxiter" "6_evaluate" '{
  "issue": 103,
  "updated_at": "2026-04-10T00:00:00Z",
  "phases": {
    "6_evaluate": {
      "termination": {
        "reason": "max_iterations",
        "final_iteration": 5,
        "final_verdict": "fail",
        "verdict_history": [
          {"iteration":1,"verdict":"fail","feedback_target":"implementation"},
          {"iteration":2,"verdict":"fail","feedback_target":"design"},
          {"iteration":3,"verdict":"fail","feedback_target":"implementation"},
          {"iteration":4,"verdict":"fail","feedback_target":"design"},
          {"iteration":5,"verdict":"fail","feedback_target":"implementation"}
        ]
      }
    }
  }
}'
RESULT=$("$ANALYZE_SH" --worktree-base "$BASE" 2>&1)
MAX_COUNT=$(echo "$RESULT" | jq '[.findings[] | select(.pattern == "max_iterations")] | length')
assert_eq "max_iterations finding count = 1" "1" "$MAX_COUNT"

# ----------------------------------------------------------------------------
# Test 7: kickoff without termination block → skipped (no findings)
# ----------------------------------------------------------------------------
printf '\nTest 7: kickoff without termination skipped\n'
rm -rf "$BASE"/*
make_kickoff "wt-notermination" "6_evaluate" '{
  "issue": 104,
  "updated_at": "2026-04-10T00:00:00Z",
  "phases": {
    "6_evaluate": { "status": "done" }
  }
}'
RESULT=$("$ANALYZE_SH" --worktree-base "$BASE" 2>&1)
FINDINGS_LEN=$(echo "$RESULT" | jq '.findings | length')
assert_eq "no termination → findings = 0" "0" "$FINDINGS_LEN"
CHECKED=$(echo "$RESULT" | jq '.checked_worktrees')
assert_eq "checked_worktrees = 1" "1" "$CHECKED"

# ----------------------------------------------------------------------------
# Test 8: converged termination → NOT flagged
# ----------------------------------------------------------------------------
printf '\nTest 8: converged termination NOT flagged\n'
rm -rf "$BASE"/*
make_kickoff "wt-conv" "6_evaluate" '{
  "issue": 105,
  "updated_at": "2026-04-10T00:00:00Z",
  "phases": {
    "6_evaluate": {
      "termination": {
        "reason": "converged",
        "final_iteration": 1,
        "final_verdict": "pass",
        "verdict_history": [
          {"iteration":1,"verdict":"pass"}
        ]
      }
    }
  }
}'
RESULT=$("$ANALYZE_SH" --worktree-base "$BASE" 2>&1)
FINDINGS_LEN=$(echo "$RESULT" | jq '.findings | length')
assert_eq "converged → findings = 0" "0" "$FINDINGS_LEN"

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
printf '\n----------------------------------------\n'
printf 'Summary: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
