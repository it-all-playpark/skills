#!/usr/bin/env bash
# Unit tests for _shared/scripts/termination-record.sh (issue #53).
#
# Run: bash tests/_shared/test-termination-record.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPT="$REPO_ROOT/_shared/scripts/termination-record.sh"

command -v jq >/dev/null || { echo "jq required"; exit 1; }

PASS=0
FAIL=0
pass() { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "${2:-}"; }

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

make_worktree() {
  local name="$1"
  local path="$TMP_ROOT/$name"
  mkdir -p "$path/.claude"
  cat > "$path/.claude/kickoff.json" <<'JSON'
{
  "version": "3.0.0",
  "issue": 53,
  "branch": "feature/issue-53-m",
  "worktree": "/tmp/wt",
  "base_branch": "dev",
  "started_at": "2026-04-11T10:00:00Z",
  "updated_at": "2026-04-11T10:00:00Z",
  "current_phase": "3b_plan_review",
  "phases": {
    "3b_plan_review": { "status": "in_progress" },
    "6_evaluate": { "status": "pending", "iterations": [], "current_iteration": 0, "max_iterations": 5 }
  },
  "feature_list": [],
  "progress_log": [],
  "decisions": [],
  "config": {}
}
JSON
  echo "$path"
}

# ----------------------------------------------------------------------------
# Test 1: script file exists and is executable
# ----------------------------------------------------------------------------
printf 'Test 1: script exists and is executable\n'
if [[ -x "$SCRIPT" ]]; then
  pass "termination-record.sh exists and is executable"
else
  fail "termination-record.sh exists and is executable" "missing: $SCRIPT"
  printf '\nSummary: %d passed, %d failed\n' "$PASS" "$FAIL"
  exit 1
fi

# ----------------------------------------------------------------------------
# Test 2: Phase 3b converged termination writes block + legacy flags
# ----------------------------------------------------------------------------
printf '\nTest 2: phase 3b converged termination\n'
WT=$(make_worktree wt1)
OUT=$("$SCRIPT" 3b_plan_review converged \
  --worktree "$WT" \
  --final-iteration 2 \
  --final-verdict pass \
  --verdict-history '[{"iteration":1,"verdict":"revise","score":72},{"iteration":2,"verdict":"pass","score":85}]' \
  2>&1)
if [[ $? -ne 0 ]]; then
  fail "converged termination exits 0" "$OUT"
else
  pass "converged termination exits 0"
fi

STATE="$WT/.claude/kickoff.json"
REASON=$(jq -r '.phases["3b_plan_review"].termination.reason' "$STATE")
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label" "expected='$expected' actual='$actual'"; fi
}
assert_eq "termination.reason = converged" "converged" "$REASON"
FINAL_ITER=$(jq -r '.phases["3b_plan_review"].termination.final_iteration' "$STATE")
assert_eq "final_iteration = 2" "2" "$FINAL_ITER"
FINAL_VERDICT=$(jq -r '.phases["3b_plan_review"].termination.final_verdict' "$STATE")
assert_eq "final_verdict = pass" "pass" "$FINAL_VERDICT"
HIST_LEN=$(jq -r '.phases["3b_plan_review"].termination.verdict_history | length' "$STATE")
assert_eq "verdict_history length = 2" "2" "$HIST_LEN"
RECORDED=$(jq -r '.phases["3b_plan_review"].termination.recorded_at' "$STATE")
if [[ -n "$RECORDED" && "$RECORDED" != "null" ]]; then
  pass "recorded_at is populated"
else
  fail "recorded_at is populated" "got: $RECORDED"
fi

# converged should NOT write escalated field at all
ESCALATED=$(jq -r '.phases["3b_plan_review"].escalated' "$STATE")
assert_eq "converged: escalated not written (null)" "null" "$ESCALATED"

# ----------------------------------------------------------------------------
# Test 3: append-verdict grows history and updates final_iteration
# ----------------------------------------------------------------------------
printf '\nTest 3: append-verdict grows history\n'
WT=$(make_worktree wt2)
# First verdict
"$SCRIPT" 3b_plan_review converged \
  --worktree "$WT" \
  --append-verdict '{"iteration":1,"verdict":"revise","score":70}' >/dev/null 2>&1
# Second verdict appended
"$SCRIPT" 3b_plan_review converged \
  --worktree "$WT" \
  --append-verdict '{"iteration":2,"verdict":"pass","score":88}' \
  --final-verdict pass >/dev/null 2>&1
STATE="$WT/.claude/kickoff.json"
LEN=$(jq -r '.phases["3b_plan_review"].termination.verdict_history | length' "$STATE")
assert_eq "verdict_history length after 2 appends = 2" "2" "$LEN"
FINAL_ITER=$(jq -r '.phases["3b_plan_review"].termination.final_iteration' "$STATE")
assert_eq "final_iteration synced from history length = 2" "2" "$FINAL_ITER"
LAST_VERDICT=$(jq -r '.phases["3b_plan_review"].termination.verdict_history[-1].verdict' "$STATE")
assert_eq "last verdict = pass" "pass" "$LAST_VERDICT"

# ----------------------------------------------------------------------------
# Test 4: stuck reason records only termination block (no legacy fields)
# ----------------------------------------------------------------------------
printf '\nTest 4: stuck termination records only termination block\n'
WT=$(make_worktree wt3)
"$SCRIPT" 3b_plan_review stuck \
  --worktree "$WT" \
  --final-iteration 2 \
  --final-verdict revise \
  --verdict-history '[{"iteration":1,"verdict":"revise","score":68},{"iteration":2,"verdict":"revise","score":69}]' >/dev/null 2>&1
STATE="$WT/.claude/kickoff.json"
REASON=$(jq -r '.phases["3b_plan_review"].termination.reason' "$STATE")
assert_eq "termination.reason = stuck" "stuck" "$REASON"
FINAL_VERDICT_STUCK=$(jq -r '.phases["3b_plan_review"].termination.final_verdict' "$STATE")
assert_eq "termination.final_verdict = revise" "revise" "$FINAL_VERDICT_STUCK"
LAST_HIST_SCORE=$(jq -r '.phases["3b_plan_review"].termination.verdict_history[-1].score' "$STATE")
assert_eq "last verdict_history score = 69" "69" "$LAST_HIST_SCORE"
# Legacy fields must NOT be written
ESC=$(jq -r '.phases["3b_plan_review"].escalated' "$STATE")
assert_eq "stuck: escalated not written (null)" "null" "$ESC"
ESC_REASON=$(jq -r '.phases["3b_plan_review"].escalation_reason' "$STATE")
assert_eq "stuck: escalation_reason not written (null)" "null" "$ESC_REASON"

# ----------------------------------------------------------------------------
# Test 5: Phase 6 termination with feedback_target in verdict_history
# ----------------------------------------------------------------------------
printf '\nTest 5: phase 6 max_iterations termination\n'
WT=$(make_worktree wt4)
"$SCRIPT" 6_evaluate max_iterations \
  --worktree "$WT" \
  --final-iteration 5 \
  --final-verdict fail \
  --verdict-history '[
    {"iteration":1,"verdict":"fail","feedback_target":"design"},
    {"iteration":2,"verdict":"fail","feedback_target":"design"},
    {"iteration":3,"verdict":"fail","feedback_target":"implementation"},
    {"iteration":4,"verdict":"fail","feedback_target":"implementation"},
    {"iteration":5,"verdict":"fail","feedback_target":"design"}
  ]' >/dev/null 2>&1
STATE="$WT/.claude/kickoff.json"
REASON=$(jq -r '.phases["6_evaluate"].termination.reason' "$STATE")
assert_eq "phase 6 reason = max_iterations" "max_iterations" "$REASON"
HIST_LEN=$(jq -r '.phases["6_evaluate"].termination.verdict_history | length' "$STATE")
assert_eq "phase 6 verdict_history length = 5" "5" "$HIST_LEN"
FIRST_FT=$(jq -r '.phases["6_evaluate"].termination.verdict_history[0].feedback_target' "$STATE")
assert_eq "first iteration feedback_target = design" "design" "$FIRST_FT"
# current_iteration legacy mirror must NOT be written by termination-record.sh
CUR_ITER=$(jq -r '.phases["6_evaluate"].current_iteration' "$STATE")
assert_eq "phase 6 current_iteration not written by termination-record (stays init value 0)" "0" "$CUR_ITER"

# ----------------------------------------------------------------------------
# Test 6: invalid reason → exit non-zero
# ----------------------------------------------------------------------------
printf '\nTest 6: invalid reason exits non-zero\n'
WT=$(make_worktree wt5)
if "$SCRIPT" 3b_plan_review bogus --worktree "$WT" --final-iteration 1 >/dev/null 2>&1; then
  fail "invalid reason rejected" "script exited 0"
else
  pass "invalid reason rejected"
fi

# ----------------------------------------------------------------------------
# Test 7: invalid phase → exit non-zero
# ----------------------------------------------------------------------------
printf '\nTest 7: invalid phase exits non-zero\n'
WT=$(make_worktree wt6)
if "$SCRIPT" 4_implement converged --worktree "$WT" --final-iteration 1 >/dev/null 2>&1; then
  fail "invalid phase rejected" "script exited 0"
else
  pass "invalid phase rejected"
fi

# ----------------------------------------------------------------------------
# Test 8: idempotence — re-recording converged keeps state consistent
# ----------------------------------------------------------------------------
printf '\nTest 8: idempotent record\n'
WT=$(make_worktree wt7)
"$SCRIPT" 3b_plan_review converged --worktree "$WT" --final-iteration 1 --final-verdict pass \
  --verdict-history '[{"iteration":1,"verdict":"pass","score":90}]' >/dev/null 2>&1
"$SCRIPT" 3b_plan_review converged --worktree "$WT" --final-iteration 1 --final-verdict pass \
  --verdict-history '[{"iteration":1,"verdict":"pass","score":90}]' >/dev/null 2>&1
STATE="$WT/.claude/kickoff.json"
LEN=$(jq -r '.phases["3b_plan_review"].termination.verdict_history | length' "$STATE")
assert_eq "idempotent verdict_history length = 1" "1" "$LEN"

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
printf '\n----------------------------------------\n'
printf 'Summary: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
