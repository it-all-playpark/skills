#!/usr/bin/env bash
# test-update-phase-removed-options.sh - Verify removed CLI options are rejected.
#
# Architecture Decision 1 (issue #95): --escalated / --escalation-reason /
# --review-iteration / --review-verdict / --review-score / --stuck-findings
# were legacy Phase 3b mirror options. All are removed from update-phase.sh.
# Callers using these options must receive a non-zero exit with an error message.
#
# Run: bash tests/dev-kickoff/test-update-phase-removed-options.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPT="$REPO_ROOT/dev-kickoff/scripts/update-phase.sh"

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
  "issue": 95,
  "branch": "feature/issue-95-m",
  "worktree": "/tmp/wt",
  "base_branch": "main",
  "started_at": "2026-05-14T00:00:00Z",
  "updated_at": "2026-05-14T00:00:00Z",
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
# Test A: Removed options are rejected with non-zero exit
# ----------------------------------------------------------------------------
printf 'Test A: Removed options return non-zero exit with Unknown option error\n\n'

WT=$(make_worktree wt_a)

assert_option_rejected() {
  local opt_label="$1" wt="$2"; shift 2
  local tmp_out; tmp_out="$TMP_ROOT/out_${opt_label//[-]/_}.txt"
  "$SCRIPT" "$@" >"$tmp_out" 2>&1; local ec=$?
  if [[ $ec -ne 0 ]]; then
    pass "${opt_label} returns non-zero"
  else
    fail "${opt_label} returns non-zero" "exit code was 0; output: $(cat "$tmp_out")"
  fi
  if grep -qi "unknown option\|${opt_label}" "$tmp_out"; then
    pass "${opt_label} error message mentions option"
  else
    fail "${opt_label} error message mentions option" "got: $(cat "$tmp_out")"
  fi
}

# A-1: --escalated
printf '  A-1: --escalated\n'
assert_option_rejected "--escalated" "$WT" 3b_plan_review done --worktree "$WT" --escalated true

# A-2: --escalation-reason
printf '  A-2: --escalation-reason\n'
assert_option_rejected "--escalation-reason" "$WT" 3b_plan_review done --worktree "$WT" --escalation-reason stuck

# A-3: --review-iteration
printf '  A-3: --review-iteration\n'
assert_option_rejected "--review-iteration" "$WT" 3b_plan_review done --worktree "$WT" --review-iteration 2

# A-4: --review-verdict
printf '  A-4: --review-verdict\n'
assert_option_rejected "--review-verdict" "$WT" 3b_plan_review done --worktree "$WT" --review-verdict pass

# A-5: --review-score
printf '  A-5: --review-score\n'
assert_option_rejected "--review-score" "$WT" 3b_plan_review done --worktree "$WT" --review-score 85

# A-6: --stuck-findings
printf '  A-6: --stuck-findings\n'
assert_option_rejected "--stuck-findings" "$WT" 3b_plan_review done --worktree "$WT" --stuck-findings '[]'

# ----------------------------------------------------------------------------
# Test B: Remaining valid options still work (regression guard)
# ----------------------------------------------------------------------------
printf '\nTest B: Remaining valid options return exit 0 (regression guard)\n\n'

WT_B=$(make_worktree wt_b)

# B-1: minimal positional invocation
printf '  B-1: minimal positional\n'
OUT=$("$SCRIPT" 3b_plan_review in_progress --worktree "$WT_B" 2>&1)
EC=$?
if [[ $EC -eq 0 ]]; then
  pass "positional phase/status exits 0"
else
  fail "positional phase/status exits 0" "got ec=$EC: $OUT"
fi

WT_B=$(make_worktree wt_b2)

# B-2: --termination-reason
printf '  B-2: --termination-reason\n'
OUT=$("$SCRIPT" 3b_plan_review done \
  --worktree "$WT_B" \
  --termination-reason converged \
  --termination-final-verdict pass 2>&1)
EC=$?
if [[ $EC -eq 0 ]]; then
  pass "--termination-reason converged exits 0"
else
  fail "--termination-reason converged exits 0" "got ec=$EC: $OUT"
fi

WT_B=$(make_worktree wt_b3)

# B-3: --termination-verdict-history
printf '  B-3: --termination-verdict-history\n'
OUT=$("$SCRIPT" 3b_plan_review done \
  --worktree "$WT_B" \
  --termination-reason converged \
  --termination-verdict-history '[{"iteration":1,"verdict":"pass","score":90}]' 2>&1)
EC=$?
if [[ $EC -eq 0 ]]; then
  pass "--termination-verdict-history exits 0"
else
  fail "--termination-verdict-history exits 0" "got ec=$EC: $OUT"
fi

WT_B=$(make_worktree wt_b4)

# B-4: --append-verdict
printf '  B-4: --append-verdict\n'
OUT=$("$SCRIPT" 3b_plan_review done \
  --worktree "$WT_B" \
  --termination-reason converged \
  --append-verdict '{"iteration":1,"verdict":"pass","score":88}' 2>&1)
EC=$?
if [[ $EC -eq 0 ]]; then
  pass "--append-verdict exits 0"
else
  fail "--append-verdict exits 0" "got ec=$EC: $OUT"
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
printf '\n----------------------------------------\n'
printf 'Summary: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
