#!/usr/bin/env bash
# Test suite for stop-devflow-telemetry.sh
#
# Usage: bash stop-devflow-telemetry.test.sh
#
# Exit 0 on all pass, non-zero otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SCRIPT_DIR}/stop-devflow-telemetry.sh"

PASS=0
FAIL=0
FAILURES=()

pass() {
  local name="$1"
  PASS=$((PASS + 1))
  printf "  \033[32mPASS\033[0m %s\n" "$name"
}
fail() {
  local name="$1" msg="$2"
  FAIL=$((FAIL + 1))
  FAILURES+=("$name: $msg")
  printf "  \033[31mFAIL\033[0m %s (%s)\n" "$name" "$msg"
}

# --------------------------------------------------------------------------
# Setup / teardown helpers
# --------------------------------------------------------------------------

make_tmpdir() {
  mktemp -d "$TMPDIR/stop-devflow-test.XXXXXX"
}

# Build a minimal handoff JSON and write it to a file.
# Usage: make_handoff <tmpdir> <filename> [extra_json_fields]
# extra_json_fields is a jq filter string applied to base object, e.g.:
#   '. + {"eval_verdict":"PASS","iterate_status":"converged"}'
make_handoff() {
  local dir="$1" fname="$2" extra="${3:-.}"
  local base
  base=$(jq -n '{
    skill: "dev-flow",
    outcome: "success",
    issue: 203,
    journal_sh: "STUB_PLACEHOLDER",
    telemetry: {
      merge_tier: "REVIEW",
      gate_policy: "llm-major-advisory",
      danger_hits: [],
      shape: "standard",
      shape_refloored: false,
      plan_iter: 1,
      eval_iter: 1
    }
  }')
  echo "$base" | jq "$extra" >"${dir}/${fname}"
}

# --------------------------------------------------------------------------
# Test 1: hook not found / not executable → skip (guard)
# --------------------------------------------------------------------------
echo "=== stop-devflow-telemetry tests ==="

if [[ ! -f ${HOOK} ]]; then
  echo "  (hook not found yet — TDD red phase confirmed)"
  fail "hook_exists" "hook file not found: ${HOOK}"
fi

# If hook not found, remaining tests will fail in unhelpful ways. Bail early.
if ((FAIL > 0)); then
  echo ""
  echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
  for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi

if [[ ! -x ${HOOK} ]]; then
  fail "hook_executable" "hook not executable: ${HOOK}"
  echo ""
  echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
  for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
  exit 1
fi

# --------------------------------------------------------------------------
# Helper: run the hook with given env vars and stdin
# Returns hook exit code via $RUN_EXIT; hook stdout captured (should be empty)
# --------------------------------------------------------------------------
RUN_EXIT=0
RUN_OUT=""
run_hook() {
  # Args: env vars as NAME=VALUE pairs (passed via env command)
  # Reads remaining args as env overrides
  local envargs=("$@")
  RUN_EXIT=0
  RUN_OUT=""
  RUN_OUT=$(env "${envargs[@]}" bash "$HOOK" </dev/null 2>&1) || RUN_EXIT=$?
}

# --------------------------------------------------------------------------
# Test 2: pending dir not present → exit 0
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  # CLAUDE_JOURNAL_DIR points to a dir with no pending/ subdir
  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}" "HOME=${tmpd}"
  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "pending_dir_absent_exits_0"
  else
    fail "pending_dir_absent_exits_0" "expected exit 0, got ${RUN_EXIT}"
  fi
  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 3: escape hatch CLAUDE_DEVFLOW_TELEMETRY_HOOK=0 → exit 0
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  make_handoff "${tmpd}/journal/pending" "handoff.json"
  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}" "CLAUDE_DEVFLOW_TELEMETRY_HOOK=0"
  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "escape_hatch_exits_0"
  else
    fail "escape_hatch_exits_0" "expected exit 0 with escape hatch, got ${RUN_EXIT}"
  fi
  # File should still exist (not processed)
  if [[ -f "${tmpd}/journal/pending/handoff.json" ]]; then
    pass "escape_hatch_file_untouched"
  else
    fail "escape_hatch_file_untouched" "file should not be processed when escape hatch is set"
  fi
  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Stub journal.sh builder
# Creates a stub script that records its arguments to a capture file
# --------------------------------------------------------------------------
make_stub_journal() {
  local stub_path="$1" capture_file="$2" exit_code="${3:-0}"
  cat >"$stub_path" <<STUB_EOF
#!/usr/bin/env bash
# Stub journal.sh for testing
echo "\$*" >> "${capture_file}"
exit ${exit_code}
STUB_EOF
  chmod +x "$stub_path"
}

# --------------------------------------------------------------------------
# Test 4: happy path — 1 pending file → stub called with correct args, file removed
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  # Build handoff with journal_sh pointing to stub
  jq -n \
    --arg js "$stub" \
    '{
      skill: "dev-flow",
      outcome: "success",
      issue: 203,
      journal_sh: $js,
      telemetry: {
        merge_tier: "REVIEW",
        gate_policy: "llm-major-advisory",
        danger_hits: [],
        shape: "standard",
        shape_refloored: false,
        plan_iter: 1,
        eval_iter: 1
      }
    }' >"${tmpd}/journal/pending/handoff.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "happy_path_exits_0"
  else
    fail "happy_path_exits_0" "expected exit 0, got ${RUN_EXIT}. output: ${RUN_OUT}"
  fi

  # Check capture file exists and has content
  if [[ ! -f $capture ]]; then
    fail "happy_path_stub_called" "capture file not created (stub not called)"
  else
    captured=$(cat "$capture")
    # Expected args: log dev-flow success --issue 203 --merge-tier REVIEW ...
    if echo "$captured" | grep -q "log dev-flow success" &&
      echo "$captured" | grep -q -- "--issue 203" &&
      echo "$captured" | grep -q -- "--merge-tier REVIEW" &&
      echo "$captured" | grep -q -- "--gate-policy llm-major-advisory" &&
      echo "$captured" | grep -q -- "--danger-hits" &&
      echo "$captured" | grep -q -- "--shape standard" &&
      echo "$captured" | grep -q -- "--shape-refloored false" &&
      echo "$captured" | grep -q -- "--plan-iter 1" &&
      echo "$captured" | grep -q -- "--eval-iter 1"; then
      pass "happy_path_stub_called_with_correct_args"
    else
      fail "happy_path_stub_called_with_correct_args" "args mismatch. got: ${captured}"
    fi
    # eval_verdict and iterate_status should NOT appear (not in this handoff)
    if echo "$captured" | grep -q -- "--eval-verdict"; then
      fail "happy_path_no_eval_verdict" "--eval-verdict should not be present"
    else
      pass "happy_path_no_eval_verdict"
    fi
    if echo "$captured" | grep -q -- "--iterate-status"; then
      fail "happy_path_no_iterate_status" "--iterate-status should not be present"
    else
      pass "happy_path_no_iterate_status"
    fi
  fi

  # Pending file should be removed after success
  if [[ ! -f "${tmpd}/journal/pending/handoff.json" ]]; then
    pass "happy_path_pending_file_removed"
  else
    fail "happy_path_pending_file_removed" "pending file should be removed after successful processing"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 5: optional fields — eval_verdict + iterate_status present → flags appended
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  jq -n \
    --arg js "$stub" \
    '{
      skill: "dev-flow",
      outcome: "success",
      issue: 42,
      journal_sh: $js,
      repo: "acme/skills",
      pr_number: 123,
      telemetry: {
        merge_tier: "AUTO",
        gate_policy: "llm-autonomous",
        danger_hits: ["sql-injection"],
        shape: "micro",
        shape_refloored: true,
        plan_iter: 2,
        eval_iter: 3,
        eval_verdict: "PASS",
        iterate_status: "converged",
        eval_staleness: "iterate_fixed",
        ci_wait_seconds: 30,
        ci_poll_attempts: 3
      }
    }' >"${tmpd}/journal/pending/handoff.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "optional_fields_exits_0"
  else
    fail "optional_fields_exits_0" "expected exit 0, got ${RUN_EXIT}. output: ${RUN_OUT}"
  fi

  if [[ -f $capture ]]; then
    captured=$(cat "$capture")
    if echo "$captured" | grep -q -- "--eval-verdict PASS"; then
      pass "optional_eval_verdict_present"
    else
      fail "optional_eval_verdict_present" "--eval-verdict PASS not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--iterate-status converged"; then
      pass "optional_iterate_status_present"
    else
      fail "optional_iterate_status_present" "--iterate-status converged not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--shape-refloored true"; then
      pass "optional_shape_refloored_true"
    else
      fail "optional_shape_refloored_true" "--shape-refloored true not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--eval-staleness iterate_fixed"; then
      pass "optional_eval_staleness_present"
    else
      fail "optional_eval_staleness_present" "--eval-staleness iterate_fixed not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--repo acme/skills"; then
      pass "optional_repo_present"
    else
      fail "optional_repo_present" "--repo acme/skills not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--pr-number 123"; then
      pass "optional_pr_number_present"
    else
      fail "optional_pr_number_present" "--pr-number 123 not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--ci-wait-seconds 30"; then
      pass "optional_ci_wait_seconds_present"
    else
      fail "optional_ci_wait_seconds_present" "--ci-wait-seconds 30 not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--ci-poll-attempts 3"; then
      pass "optional_ci_poll_attempts_present"
    else
      fail "optional_ci_poll_attempts_present" "--ci-poll-attempts 3 not found. got: ${captured}"
    fi
  else
    fail "optional_fields_stub_called" "capture file not created"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 6: optional fields absent — no eval_verdict/iterate_status in handoff → flags absent
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  jq -n \
    --arg js "$stub" \
    '{
      skill: "dev-flow",
      outcome: "success",
      issue: 10,
      journal_sh: $js,
      telemetry: {
        merge_tier: "HOLD",
        gate_policy: "deterministic-only",
        danger_hits: [],
        shape: "complex",
        shape_refloored: false,
        plan_iter: 5,
        eval_iter: 4
      }
    }' >"${tmpd}/journal/pending/handoff.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ -f $capture ]]; then
    captured=$(cat "$capture")
    if ! echo "$captured" | grep -q -- "--eval-verdict"; then
      pass "no_eval_verdict_when_absent"
    else
      fail "no_eval_verdict_when_absent" "--eval-verdict should not appear"
    fi
    if ! echo "$captured" | grep -q -- "--iterate-status"; then
      pass "no_iterate_status_when_absent"
    else
      fail "no_iterate_status_when_absent" "--iterate-status should not appear"
    fi
    if ! echo "$captured" | grep -q -- "--eval-staleness"; then
      pass "no_eval_staleness_when_absent"
    else
      fail "no_eval_staleness_when_absent" "--eval-staleness should not appear"
    fi
    if ! echo "$captured" | grep -q -- "--repo"; then
      pass "no_repo_when_absent"
    else
      fail "no_repo_when_absent" "--repo should not appear"
    fi
    if ! echo "$captured" | grep -q -- "--pr-number"; then
      pass "no_pr_number_when_absent"
    else
      fail "no_pr_number_when_absent" "--pr-number should not appear"
    fi
    if ! echo "$captured" | grep -q -- "--ci-wait-seconds"; then
      pass "no_ci_wait_seconds_when_absent"
    else
      fail "no_ci_wait_seconds_when_absent" "--ci-wait-seconds should not appear"
    fi
    if ! echo "$captured" | grep -q -- "--ci-poll-attempts"; then
      pass "no_ci_poll_attempts_when_absent"
    else
      fail "no_ci_poll_attempts_when_absent" "--ci-poll-attempts should not appear"
    fi
  else
    fail "no_optional_fields_stub_called" "capture file not created"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 7: failure path — stub exits 1 → file restored, log written
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 1

  jq -n \
    --arg js "$stub" \
    '{
      skill: "dev-flow",
      outcome: "failure",
      issue: 99,
      journal_sh: $js,
      telemetry: {
        merge_tier: "REVIEW",
        gate_policy: "llm-major-advisory",
        danger_hits: [],
        shape: "standard",
        shape_refloored: false,
        plan_iter: 1,
        eval_iter: 1
      }
    }' >"${tmpd}/journal/pending/handoff.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  # Hook must exit 0 even on failure
  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "failure_path_exits_0"
  else
    fail "failure_path_exits_0" "hook must always exit 0, got ${RUN_EXIT}"
  fi

  # Pending file should be restored (not removed) after failure
  if [[ -f "${tmpd}/journal/pending/handoff.json" ]]; then
    pass "failure_path_file_restored"
  else
    fail "failure_path_file_restored" "pending file should be restored after journal.sh failure"
  fi

  # Log file should be written
  logfile="${tmpd}/.claude/logs/stop-devflow-telemetry.log"
  if [[ -f $logfile ]]; then
    pass "failure_path_log_written"
    # Check log has content (timestamp + something)
    if [[ -s $logfile ]]; then
      pass "failure_path_log_nonempty"
    else
      fail "failure_path_log_nonempty" "log file is empty"
    fi
  else
    fail "failure_path_log_written" "log file not created at ${logfile}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 8: malformed JSON → moved to pending/malformed/, error logged, exit 0
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"

  echo "{ not valid json }" >"${tmpd}/journal/pending/bad.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "malformed_exits_0"
  else
    fail "malformed_exits_0" "hook must always exit 0, got ${RUN_EXIT}"
  fi

  # Original file should not exist in pending/
  if [[ ! -f "${tmpd}/journal/pending/bad.json" ]]; then
    pass "malformed_removed_from_pending"
  else
    fail "malformed_removed_from_pending" "malformed file should be moved out of pending/"
  fi

  # File should be in malformed/ subdir
  if ls "${tmpd}/journal/pending/malformed/" 2>/dev/null | grep -q "bad.json"; then
    pass "malformed_moved_to_malformed_dir"
  else
    fail "malformed_moved_to_malformed_dir" "malformed file not found in pending/malformed/"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 9: merge_tier absent (no telemetry.merge_tier) → NOT malformed, recorded
#          without --merge-tier (producer 契約: required key は skill/outcome のみ)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  jq -n --arg js "$stub" \
    '{"skill":"dev-flow","outcome":"success","issue":1,"journal_sh":$js,"telemetry":{}}' \
    >"${tmpd}/journal/pending/nokey.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "missing_merge_tier_exits_0"
  else
    fail "missing_merge_tier_exits_0" "hook must always exit 0, got ${RUN_EXIT}"
  fi

  if ls "${tmpd}/journal/pending/malformed/" 2>/dev/null | grep -q "nokey.json"; then
    fail "missing_merge_tier_not_malformed" "merge_tier 欠落は malformed 扱いにしてはいけない（producer 契約は skill/outcome のみ必須）"
  else
    pass "missing_merge_tier_not_malformed"
  fi

  if [[ -f $capture ]]; then
    captured=$(cat "$capture")
    if echo "$captured" | grep -q "log dev-flow success"; then
      pass "missing_merge_tier_stub_called"
    else
      fail "missing_merge_tier_stub_called" "stub not called with expected skill/outcome. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--merge-tier"; then
      fail "missing_merge_tier_no_flag" "--merge-tier must not appear when telemetry.merge_tier is absent. got: ${captured}"
    else
      pass "missing_merge_tier_no_flag"
    fi
  else
    fail "missing_merge_tier_stub_called" "capture file not created (stub not called)"
  fi

  if [[ ! -f "${tmpd}/journal/pending/nokey.json" ]]; then
    pass "missing_merge_tier_pending_removed"
  else
    fail "missing_merge_tier_pending_removed" "pending file should be removed after successful processing"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 9b: skill missing → still malformed treatment (producer 契約違反)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"

  echo '{"outcome":"success","issue":1,"journal_sh":"/bin/true","telemetry":{"merge_tier":"REVIEW"}}' \
    >"${tmpd}/journal/pending/noskill.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "missing_skill_exits_0"
  else
    fail "missing_skill_exits_0" "hook must always exit 0, got ${RUN_EXIT}"
  fi

  if ls "${tmpd}/journal/pending/malformed/" 2>/dev/null | grep -q "noskill.json"; then
    pass "missing_skill_moved_to_malformed"
  else
    fail "missing_skill_moved_to_malformed" "handoff missing skill must be moved to malformed/"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 9c: outcome missing → still malformed treatment (producer 契約違反)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"

  echo '{"skill":"dev-flow","issue":1,"journal_sh":"/bin/true","telemetry":{"merge_tier":"REVIEW"}}' \
    >"${tmpd}/journal/pending/nooutcome.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "missing_outcome_exits_0"
  else
    fail "missing_outcome_exits_0" "hook must always exit 0, got ${RUN_EXIT}"
  fi

  if ls "${tmpd}/journal/pending/malformed/" 2>/dev/null | grep -q "nooutcome.json"; then
    pass "missing_outcome_moved_to_malformed"
  else
    fail "missing_outcome_moved_to_malformed" "handoff missing outcome must be moved to malformed/"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 9d: dev-flow 失敗 run（malformed 実データ系統A を模す）→ error_category /
#          error_msg (top-level) が --error-category / --error-msg として転送される
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  jq -n --arg js "$stub" \
    '{
      skill: "dev-flow",
      outcome: "failure",
      issue: 325,
      repo: "it-all-playpark/skills",
      journal_sh: $js,
      error_category: "needs_clarification",
      error_msg: "analyze: 要件が曖昧で中断",
      telemetry: {
        gate_policy: "llm-major-advisory",
        plan_iter: 0,
        eval_iter: 0
      }
    }' >"${tmpd}/journal/pending/failrun.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ -f $capture ]]; then
    captured=$(cat "$capture")
    if echo "$captured" | grep -q "log dev-flow failure"; then
      pass "failrun_skill_outcome"
    else
      fail "failrun_skill_outcome" "expected 'log dev-flow failure'. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--error-category needs_clarification"; then
      pass "failrun_error_category"
    else
      fail "failrun_error_category" "--error-category needs_clarification not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--error-msg"; then
      pass "failrun_error_msg"
    else
      fail "failrun_error_msg" "--error-msg not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--gate-policy llm-major-advisory"; then
      pass "failrun_gate_policy"
    else
      fail "failrun_gate_policy" "--gate-policy llm-major-advisory not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--merge-tier"; then
      fail "failrun_no_merge_tier" "--merge-tier must not appear. got: ${captured}"
    else
      pass "failrun_no_merge_tier"
    fi
  else
    fail "failrun_stub_called" "capture file not created (stub not called)"
  fi

  if [[ ! -f "${tmpd}/journal/pending/failrun.json" ]]; then
    pass "failrun_pending_removed"
  else
    fail "failrun_pending_removed" "pending file should be removed after successful processing"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 9e: pr-iterate 単体起動 handoff（系統B）→ iterate_status / ci_wait_seconds /
#          ci_poll_attempts / pr_number が転送され、merge-tier/error-category は無い
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  jq -n --arg js "$stub" \
    '{
      skill: "pr-iterate",
      outcome: "success",
      repo: "it-all-playpark/skills",
      pr_number: 99,
      journal_sh: $js,
      telemetry: {
        iterate_status: "converged",
        ci_wait_seconds: 120,
        ci_poll_attempts: 3
      }
    }' >"${tmpd}/journal/pending/priterate.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ -f $capture ]]; then
    captured=$(cat "$capture")
    if echo "$captured" | grep -q "log pr-iterate success"; then
      pass "priterate_skill_outcome"
    else
      fail "priterate_skill_outcome" "expected 'log pr-iterate success'. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--iterate-status converged"; then
      pass "priterate_iterate_status"
    else
      fail "priterate_iterate_status" "--iterate-status converged not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--ci-wait-seconds 120"; then
      pass "priterate_ci_wait_seconds"
    else
      fail "priterate_ci_wait_seconds" "--ci-wait-seconds 120 not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--ci-poll-attempts 3"; then
      pass "priterate_ci_poll_attempts"
    else
      fail "priterate_ci_poll_attempts" "--ci-poll-attempts 3 not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--pr-number 99"; then
      pass "priterate_pr_number"
    else
      fail "priterate_pr_number" "--pr-number 99 not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--merge-tier"; then
      fail "priterate_no_merge_tier" "--merge-tier must not appear. got: ${captured}"
    else
      pass "priterate_no_merge_tier"
    fi
    if echo "$captured" | grep -q -- "--error-category"; then
      fail "priterate_no_error_category" "--error-category must not appear. got: ${captured}"
    else
      pass "priterate_no_error_category"
    fi
  else
    fail "priterate_stub_called" "capture file not created (stub not called)"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 9f: 最小 payload {skill, outcome, journal_sh}（telemetry object 自体なし）
#          → 記録成功・pending 削除
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  jq -n --arg js "$stub" '{skill: "pr-iterate", outcome: "success", journal_sh: $js}' \
    >"${tmpd}/journal/pending/minimal.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "minimal_payload_exits_0"
  else
    fail "minimal_payload_exits_0" "expected exit 0, got ${RUN_EXIT}. output: ${RUN_OUT}"
  fi

  if [[ -f $capture ]]; then
    captured=$(cat "$capture")
    if echo "$captured" | grep -q "log pr-iterate success"; then
      pass "minimal_payload_stub_called"
    else
      fail "minimal_payload_stub_called" "expected 'log pr-iterate success'. got: ${captured}"
    fi
  else
    fail "minimal_payload_stub_called" "capture file not created (stub not called)"
  fi

  if [[ ! -f "${tmpd}/journal/pending/minimal.json" ]]; then
    pass "minimal_payload_pending_removed"
  else
    fail "minimal_payload_pending_removed" "pending file should be removed after successful processing"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 9g: telemetry.merge_tier が JSON null → --merge-tier は付与されない
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  jq -n --arg js "$stub" \
    '{skill:"dev-flow", outcome:"success", issue:5, journal_sh:$js, telemetry:{merge_tier:null}}' \
    >"${tmpd}/journal/pending/nulltier.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ -f $capture ]]; then
    captured=$(cat "$capture")
    if echo "$captured" | grep -q -- "--merge-tier"; then
      fail "null_merge_tier_no_flag" "--merge-tier must not appear when telemetry.merge_tier is null. got: ${captured}"
    else
      pass "null_merge_tier_no_flag"
    fi
  else
    fail "null_merge_tier_stub_called" "capture file not created (stub not called)"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 9h (regression / byte compat): merge_tier を持つ既存 handoff の cmd_args が
#          exact-match で現状と一致する（--merge-tier の挿入位置が --issue 直後から
#          動いていないことの証明）
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  jq -n --arg js "$stub" \
    '{
      skill: "dev-flow",
      outcome: "success",
      issue: 203,
      journal_sh: $js,
      telemetry: {
        merge_tier: "REVIEW",
        gate_policy: "llm-major-advisory",
        danger_hits: [],
        shape: "standard",
        shape_refloored: false,
        plan_iter: 1,
        eval_iter: 1
      }
    }' >"${tmpd}/journal/pending/regression.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  expected='log dev-flow success --issue 203 --merge-tier REVIEW --gate-policy llm-major-advisory --danger-hits [] --shape standard --shape-refloored false --plan-iter 1 --eval-iter 1'

  if [[ -f $capture ]]; then
    captured=$(cat "$capture")
    if [[ $captured == "$expected" ]]; then
      pass "regression_exact_arg_order"
    else
      fail "regression_exact_arg_order" "expected: [${expected}] got: [${captured}]"
    fi
  else
    fail "regression_exact_arg_order" "capture file not created (stub not called)"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 10: stdout must be empty (hook prints nothing to stdout)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  jq -n \
    --arg js "$stub" \
    '{
      skill: "dev-flow",
      outcome: "success",
      issue: 1,
      journal_sh: $js,
      telemetry: {
        merge_tier: "REVIEW",
        gate_policy: "llm-major-advisory",
        danger_hits: [],
        shape: "standard",
        shape_refloored: false,
        plan_iter: 1,
        eval_iter: 1
      }
    }' >"${tmpd}/journal/pending/handoff.json"

  stdout_out=$(env "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}" bash "$HOOK" </dev/null 2>/dev/null || true)

  if [[ -z $stdout_out ]]; then
    pass "no_stdout_output"
  else
    fail "no_stdout_output" "hook should not write to stdout, got: ${stdout_out}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Helper: build a handoff whose telemetry carries trust keys
# Usage: make_trust_handoff <outfile> <stub_path> <trust_json_filter>
# --------------------------------------------------------------------------
make_trust_handoff() {
  local outfile="$1" stub="$2" trust_filter="$3"
  jq -n --arg js "$stub" '{
    skill: "dev-flow",
    outcome: "success",
    issue: 390,
    journal_sh: $js,
    telemetry: {
      merge_tier: "REVIEW",
      gate_policy: "llm-major-advisory",
      danger_hits: [],
      shape: "standard",
      shape_refloored: false,
      plan_iter: 1,
      eval_iter: 1
    }
  }' | jq "$trust_filter" >"$outfile"
}

# --------------------------------------------------------------------------
# Test 11: valid trust telemetry → --trust-run-id / --trust-receipts /
#          --trust-surfaceproof are forwarded to journal.sh
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/trust.json" "$stub" \
    '.telemetry += {
      trust_run_id: "run-390-abc",
      trust_receipts: [{layer:"surfaceproof",mode:"shadow",verdict:"pass",stage:"analyze"},
                       {layer:"evalseal",mode:"shadow",verdict:"inconclusive",stage:"evaluate"}],
      trust_surfaceproof_shadow: {mode:"shadow",verdict:"pass",reason_code:null,receipt_id:"sha256:deadbeef"}
    }'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--trust-run-id run-390-abc"; then
    pass "trust_run_id_forwarded"
  else
    fail "trust_run_id_forwarded" "expected --trust-run-id. got: ${captured}"
  fi
  if echo "$captured" | grep -q -- '--trust-receipts \[{"layer":"surfaceproof"'; then
    pass "trust_receipts_forwarded"
  else
    fail "trust_receipts_forwarded" "expected --trust-receipts with compact JSON. got: ${captured}"
  fi
  if echo "$captured" | grep -q -- '--trust-surfaceproof {"mode":"shadow"'; then
    pass "trust_surfaceproof_forwarded"
  else
    fail "trust_surfaceproof_forwarded" "expected --trust-surfaceproof with compact JSON. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/trust.json" ]]; then
    pass "trust_pending_file_removed"
  else
    fail "trust_pending_file_removed" "pending file should be removed after success"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 12: trust keys absent (trust-inactive run) → no trust flags at all
#          (既存呼び出しと byte 互換。AC-11: shadow/off で挙動不変)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/notrust.json" "$stub" '.'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--trust-"; then
    fail "trust_absent_no_flags" "no --trust-* flag expected. got: ${captured}"
  else
    pass "trust_absent_no_flags"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 13: trust_surfaceproof_shadow が closed-enum 契約違反 (verdict:null —
#          advisory/blocking 昇格 run の形) → 当該フラグのみ drop し、base entry は記録される
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/badsp.json" "$stub" \
    '.telemetry += {
      trust_run_id: "run-390-xyz",
      trust_surfaceproof_shadow: {mode:"advisory",verdict:null,reason_code:null,receipt_id:null}
    }'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--trust-surfaceproof"; then
    fail "bad_surfaceproof_dropped" "invalid --trust-surfaceproof must not be forwarded. got: ${captured}"
  else
    pass "bad_surfaceproof_dropped"
  fi
  # base entry (と有効な trust_run_id) は失われない
  if echo "$captured" | grep -q -- "--merge-tier REVIEW" &&
    echo "$captured" | grep -q -- "--trust-run-id run-390-xyz"; then
    pass "bad_surfaceproof_base_entry_preserved"
  else
    fail "bad_surfaceproof_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/badsp.json" ]]; then
    pass "bad_surfaceproof_pending_removed"
  else
    fail "bad_surfaceproof_pending_removed" "pending file must not be stuck on trust-key drop"
  fi
  if grep -q "trust-key-dropped: trust_surfaceproof_shadow" \
    "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "bad_surfaceproof_logged"
  else
    fail "bad_surfaceproof_logged" "drop must be recorded in the log (silent drop 禁止)"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 14: trust_receipts に未知 layer → 当該フラグのみ drop、base entry は記録される
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/badrcpt.json" "$stub" \
    '.telemetry += {
      trust_receipts: [{layer:"unknownlayer",mode:"shadow",verdict:"pass"}]
    }'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--trust-receipts"; then
    fail "bad_receipts_dropped" "invalid --trust-receipts must not be forwarded. got: ${captured}"
  else
    pass "bad_receipts_dropped"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "bad_receipts_base_entry_preserved"
  else
    fail "bad_receipts_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if grep -q "trust-key-dropped: trust_receipts" \
    "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "bad_receipts_logged"
  else
    fail "bad_receipts_logged" "drop must be recorded in the log (silent drop 禁止)"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 15 (integration): 実 journal.sh が存在する環境では、trust キーが実際に
#          journal entry の telemetry へ到達することを確認する（skills repo 側の
#          --trust-* 受理契約との結合テスト）。未配置環境では skip。
# --------------------------------------------------------------------------
{
  REAL_JOURNAL="${SCRIPT_DIR}/../../playpark-core/skill-retrospective/scripts/journal.sh"
  if [[ ! -x $REAL_JOURNAL ]]; then
    echo "  (skip: real journal.sh not found — integration test skipped)"
  else
    tmpd=$(make_tmpdir)
    mkdir -p "${tmpd}/journal/pending"

    make_trust_handoff "${tmpd}/journal/pending/e2e.json" "$REAL_JOURNAL" \
      '.telemetry += {
        trust_run_id: "run-e2e-001",
        trust_receipts: [{layer:"evalseal",mode:"shadow",verdict:"pass",stage:"evaluate"}],
        trust_surfaceproof_shadow: {mode:"shadow",verdict:"inconclusive"}
      }'

    run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

    entry=$(ls "${tmpd}/journal"/*.json 2>/dev/null | head -1 || true)
    if [[ -z $entry ]]; then
      fail "integration_entry_written" "no journal entry created. hook output: ${RUN_OUT}"
    else
      pass "integration_entry_written"
      if [[ $(jq -r '.telemetry.trust_run_id' "$entry") == "run-e2e-001" ]] &&
        [[ $(jq -r '.telemetry.trust_receipts[0].layer' "$entry") == "evalseal" ]] &&
        [[ $(jq -r '.telemetry.trust_surfaceproof_shadow.verdict' "$entry") == "inconclusive" ]]; then
        pass "integration_trust_keys_persisted"
      else
        fail "integration_trust_keys_persisted" "trust keys missing in entry: $(jq -c '.telemetry' "$entry")"
      fi
    fi

    rm -rf "$tmpd"
  fi
}

# --------------------------------------------------------------------------
# Helper: build a handoff whose telemetry carries the 8 new telemetry keys
# (issue #430: vdelta_verdicts / vdelta_fail_open / redgreen_deny /
# testsurf_hits / duration_seconds / phase_durations / merge_tier_reasons /
# route) plus the base telemetry fields. Usage:
#   make_full_telemetry_handoff <outfile> <stub_path> [extra_jq_filter]
# --------------------------------------------------------------------------
make_full_telemetry_handoff() {
  local outfile="$1" stub="$2" extra="${3:-.}"
  jq -n --arg js "$stub" '{
    skill: "dev-flow",
    outcome: "success",
    issue: 430,
    journal_sh: $js,
    telemetry: {
      merge_tier: "REVIEW",
      gate_policy: "llm-major-advisory",
      danger_hits: [],
      shape: "standard",
      shape_refloored: false,
      plan_iter: 1,
      eval_iter: 1,
      vdelta_verdicts: [{"ac":1,"status":"promoted"}],
      vdelta_fail_open: 1,
      redgreen_deny: [{"ac":2,"reasons":["no red"]}],
      testsurf_hits: ["test/foo.test.js"],
      duration_seconds: 840,
      phase_durations: {"analyze":120,"plan":95},
      merge_tier_reasons: ["danger hit"],
      route: "lite"
    }
  }' | jq "$extra" >"$outfile"
}

# --------------------------------------------------------------------------
# Test 16: telemetry 8-key normal forwarding — all 8 new keys present in
#          handoff → all forwarded to journal.sh with correct (compact JSON
#          for object/array-valued keys) values, and existing keys
#          (--merge-tier / --gate-policy etc.) still forwarded (no regression)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_full_telemetry_handoff "${tmpd}/journal/pending/full.json" "$stub"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "full_telemetry_exits_0"
  else
    fail "full_telemetry_exits_0" "expected exit 0, got ${RUN_EXIT}. output: ${RUN_OUT}"
  fi

  if [[ -f $capture ]]; then
    captured=$(cat "$capture")
    if echo "$captured" | grep -q -- '--vdelta-verdicts \[{"ac":1,"status":"promoted"}\]'; then
      pass "full_telemetry_vdelta_verdicts"
    else
      fail "full_telemetry_vdelta_verdicts" "--vdelta-verdicts not found/compact. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--vdelta-fail-open 1"; then
      pass "full_telemetry_vdelta_fail_open"
    else
      fail "full_telemetry_vdelta_fail_open" "--vdelta-fail-open 1 not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- '--redgreen-deny \[{"ac":2,"reasons":\["no red"\]}\]'; then
      pass "full_telemetry_redgreen_deny"
    else
      fail "full_telemetry_redgreen_deny" "--redgreen-deny not found/compact. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- '--testsurf-hits \["test/foo.test.js"\]'; then
      pass "full_telemetry_testsurf_hits"
    else
      fail "full_telemetry_testsurf_hits" "--testsurf-hits not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--duration-seconds 840"; then
      pass "full_telemetry_duration_seconds"
    else
      fail "full_telemetry_duration_seconds" "--duration-seconds 840 not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- '--phase-durations {"analyze":120,"plan":95}'; then
      pass "full_telemetry_phase_durations"
    else
      fail "full_telemetry_phase_durations" "--phase-durations not found/compact. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- '--merge-tier-reasons \["danger hit"\]'; then
      pass "full_telemetry_merge_tier_reasons"
    else
      fail "full_telemetry_merge_tier_reasons" "--merge-tier-reasons not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--route lite"; then
      pass "full_telemetry_route"
    else
      fail "full_telemetry_route" "--route lite not found. got: ${captured}"
    fi
    # Existing keys must still be forwarded (no regression)
    if echo "$captured" | grep -q -- "--merge-tier REVIEW" &&
      echo "$captured" | grep -q -- "--gate-policy llm-major-advisory"; then
      pass "full_telemetry_existing_keys_preserved"
    else
      fail "full_telemetry_existing_keys_preserved" "existing --merge-tier/--gate-policy must still be forwarded. got: ${captured}"
    fi
  else
    fail "full_telemetry_stub_called" "capture file not created (stub not called)"
  fi

  if [[ ! -f "${tmpd}/journal/pending/full.json" ]]; then
    pass "full_telemetry_pending_removed"
  else
    fail "full_telemetry_pending_removed" "pending file should be removed after successful processing"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 17: conditional output — legacy handoff without the 8 new telemetry
#          keys (same shape as Test 9h) → none of the new flags appear.
#          Test 9h's exact-match regression is the final byte-compat
#          guarantee; this test only needs to confirm the absence of the
#          new flags for a handoff that doesn't carry them.
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  jq -n --arg js "$stub" \
    '{
      skill: "dev-flow",
      outcome: "success",
      issue: 203,
      journal_sh: $js,
      telemetry: {
        merge_tier: "REVIEW",
        gate_policy: "llm-major-advisory",
        danger_hits: [],
        shape: "standard",
        shape_refloored: false,
        plan_iter: 1,
        eval_iter: 1
      }
    }' >"${tmpd}/journal/pending/legacy.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ -f $capture ]]; then
    captured=$(cat "$capture")
    if ! echo "$captured" | grep -q -- "--vdelta-"; then
      pass "legacy_no_vdelta_flags"
    else
      fail "legacy_no_vdelta_flags" "--vdelta-* must not appear for legacy handoff. got: ${captured}"
    fi
    if ! echo "$captured" | grep -q -- "--redgreen-"; then
      pass "legacy_no_redgreen_flags"
    else
      fail "legacy_no_redgreen_flags" "--redgreen-* must not appear for legacy handoff. got: ${captured}"
    fi
    if ! echo "$captured" | grep -q -- "--testsurf-"; then
      pass "legacy_no_testsurf_flags"
    else
      fail "legacy_no_testsurf_flags" "--testsurf-* must not appear for legacy handoff. got: ${captured}"
    fi
    if ! echo "$captured" | grep -q -- "--duration-seconds"; then
      pass "legacy_no_duration_seconds"
    else
      fail "legacy_no_duration_seconds" "--duration-seconds must not appear for legacy handoff. got: ${captured}"
    fi
    if ! echo "$captured" | grep -q -- "--phase-durations"; then
      pass "legacy_no_phase_durations"
    else
      fail "legacy_no_phase_durations" "--phase-durations must not appear for legacy handoff. got: ${captured}"
    fi
    if ! echo "$captured" | grep -q -- "--merge-tier-reasons"; then
      pass "legacy_no_merge_tier_reasons"
    else
      fail "legacy_no_merge_tier_reasons" "--merge-tier-reasons must not appear for legacy handoff. got: ${captured}"
    fi
    if ! echo "$captured" | grep -q -- "--route"; then
      pass "legacy_no_route"
    else
      fail "legacy_no_route" "--route must not appear for legacy handoff. got: ${captured}"
    fi
  else
    fail "legacy_stub_called" "capture file not created (stub not called)"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 18: per-key drop — a single telemetry key with a contract-violating
#          value must be dropped (flag absent from journal.sh call), while
#          the base entry (--merge-tier etc.) is still recorded, pending is
#          still removed, and the drop is logged as
#          "telemetry-key-dropped: <key>" (fail-open, same design as trust
#          keys in Test 13/14).
# --------------------------------------------------------------------------

# Test 18a: vdelta_verdicts with a non-object array element
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_full_telemetry_handoff "${tmpd}/journal/pending/bad.json" "$stub" \
    '.telemetry.vdelta_verdicts = ["not-object"]'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"
  captured=$(cat "$capture" 2>/dev/null || echo "")

  if ! echo "$captured" | grep -q -- "--vdelta-verdicts"; then
    pass "drop_vdelta_verdicts_flag_absent"
  else
    fail "drop_vdelta_verdicts_flag_absent" "invalid --vdelta-verdicts must not be forwarded. got: ${captured}"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "drop_vdelta_verdicts_base_entry_preserved"
  else
    fail "drop_vdelta_verdicts_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/bad.json" ]]; then
    pass "drop_vdelta_verdicts_pending_removed"
  else
    fail "drop_vdelta_verdicts_pending_removed" "pending file must not be stuck on telemetry-key drop"
  fi
  if grep -q "telemetry-key-dropped: vdelta_verdicts" \
    "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "drop_vdelta_verdicts_logged"
  else
    fail "drop_vdelta_verdicts_logged" "drop must be recorded in the log (silent drop 禁止)"
  fi

  rm -rf "$tmpd"
}

# Test 18b: vdelta_fail_open negative number
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_full_telemetry_handoff "${tmpd}/journal/pending/bad.json" "$stub" \
    '.telemetry.vdelta_fail_open = -1'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"
  captured=$(cat "$capture" 2>/dev/null || echo "")

  if ! echo "$captured" | grep -q -- "--vdelta-fail-open"; then
    pass "drop_vdelta_fail_open_flag_absent"
  else
    fail "drop_vdelta_fail_open_flag_absent" "invalid --vdelta-fail-open must not be forwarded. got: ${captured}"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "drop_vdelta_fail_open_base_entry_preserved"
  else
    fail "drop_vdelta_fail_open_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/bad.json" ]]; then
    pass "drop_vdelta_fail_open_pending_removed"
  else
    fail "drop_vdelta_fail_open_pending_removed" "pending file must not be stuck on telemetry-key drop"
  fi
  if grep -q "telemetry-key-dropped: vdelta_fail_open" \
    "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "drop_vdelta_fail_open_logged"
  else
    fail "drop_vdelta_fail_open_logged" "drop must be recorded in the log (silent drop 禁止)"
  fi

  rm -rf "$tmpd"
}

# Test 18c: redgreen_deny is an object, not an array
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_full_telemetry_handoff "${tmpd}/journal/pending/bad.json" "$stub" \
    '.telemetry.redgreen_deny = {"ac":1}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"
  captured=$(cat "$capture" 2>/dev/null || echo "")

  if ! echo "$captured" | grep -q -- "--redgreen-deny"; then
    pass "drop_redgreen_deny_flag_absent"
  else
    fail "drop_redgreen_deny_flag_absent" "invalid --redgreen-deny must not be forwarded. got: ${captured}"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "drop_redgreen_deny_base_entry_preserved"
  else
    fail "drop_redgreen_deny_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/bad.json" ]]; then
    pass "drop_redgreen_deny_pending_removed"
  else
    fail "drop_redgreen_deny_pending_removed" "pending file must not be stuck on telemetry-key drop"
  fi
  if grep -q "telemetry-key-dropped: redgreen_deny" \
    "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "drop_redgreen_deny_logged"
  else
    fail "drop_redgreen_deny_logged" "drop must be recorded in the log (silent drop 禁止)"
  fi

  rm -rf "$tmpd"
}

# Test 18d: testsurf_hits with a number array element
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_full_telemetry_handoff "${tmpd}/journal/pending/bad.json" "$stub" \
    '.telemetry.testsurf_hits = [42]'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"
  captured=$(cat "$capture" 2>/dev/null || echo "")

  if ! echo "$captured" | grep -q -- "--testsurf-hits"; then
    pass "drop_testsurf_hits_flag_absent"
  else
    fail "drop_testsurf_hits_flag_absent" "invalid --testsurf-hits must not be forwarded. got: ${captured}"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "drop_testsurf_hits_base_entry_preserved"
  else
    fail "drop_testsurf_hits_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/bad.json" ]]; then
    pass "drop_testsurf_hits_pending_removed"
  else
    fail "drop_testsurf_hits_pending_removed" "pending file must not be stuck on telemetry-key drop"
  fi
  if grep -q "telemetry-key-dropped: testsurf_hits" \
    "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "drop_testsurf_hits_logged"
  else
    fail "drop_testsurf_hits_logged" "drop must be recorded in the log (silent drop 禁止)"
  fi

  rm -rf "$tmpd"
}

# Test 18e: duration_seconds is a non-numeric string
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_full_telemetry_handoff "${tmpd}/journal/pending/bad.json" "$stub" \
    '.telemetry.duration_seconds = "abc"'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"
  captured=$(cat "$capture" 2>/dev/null || echo "")

  if ! echo "$captured" | grep -q -- "--duration-seconds"; then
    pass "drop_duration_seconds_flag_absent"
  else
    fail "drop_duration_seconds_flag_absent" "invalid --duration-seconds must not be forwarded. got: ${captured}"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "drop_duration_seconds_base_entry_preserved"
  else
    fail "drop_duration_seconds_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/bad.json" ]]; then
    pass "drop_duration_seconds_pending_removed"
  else
    fail "drop_duration_seconds_pending_removed" "pending file must not be stuck on telemetry-key drop"
  fi
  if grep -q "telemetry-key-dropped: duration_seconds" \
    "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "drop_duration_seconds_logged"
  else
    fail "drop_duration_seconds_logged" "drop must be recorded in the log (silent drop 禁止)"
  fi

  rm -rf "$tmpd"
}

# Test 18f: phase_durations with a non-numeric object value
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_full_telemetry_handoff "${tmpd}/journal/pending/bad.json" "$stub" \
    '.telemetry.phase_durations = {"analyze":"fast"}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"
  captured=$(cat "$capture" 2>/dev/null || echo "")

  if ! echo "$captured" | grep -q -- "--phase-durations"; then
    pass "drop_phase_durations_flag_absent"
  else
    fail "drop_phase_durations_flag_absent" "invalid --phase-durations must not be forwarded. got: ${captured}"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "drop_phase_durations_base_entry_preserved"
  else
    fail "drop_phase_durations_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/bad.json" ]]; then
    pass "drop_phase_durations_pending_removed"
  else
    fail "drop_phase_durations_pending_removed" "pending file must not be stuck on telemetry-key drop"
  fi
  if grep -q "telemetry-key-dropped: phase_durations" \
    "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "drop_phase_durations_logged"
  else
    fail "drop_phase_durations_logged" "drop must be recorded in the log (silent drop 禁止)"
  fi

  rm -rf "$tmpd"
}

# Test 18g: merge_tier_reasons with an object array element
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_full_telemetry_handoff "${tmpd}/journal/pending/bad.json" "$stub" \
    '.telemetry.merge_tier_reasons = [{"r":1}]'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"
  captured=$(cat "$capture" 2>/dev/null || echo "")

  if ! echo "$captured" | grep -q -- "--merge-tier-reasons"; then
    pass "drop_merge_tier_reasons_flag_absent"
  else
    fail "drop_merge_tier_reasons_flag_absent" "invalid --merge-tier-reasons must not be forwarded. got: ${captured}"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "drop_merge_tier_reasons_base_entry_preserved"
  else
    fail "drop_merge_tier_reasons_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/bad.json" ]]; then
    pass "drop_merge_tier_reasons_pending_removed"
  else
    fail "drop_merge_tier_reasons_pending_removed" "pending file must not be stuck on telemetry-key drop"
  fi
  if grep -q "telemetry-key-dropped: merge_tier_reasons" \
    "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "drop_merge_tier_reasons_logged"
  else
    fail "drop_merge_tier_reasons_logged" "drop must be recorded in the log (silent drop 禁止)"
  fi

  rm -rf "$tmpd"
}

# Test 18h: route outside the lite|full enum (also carries a valid
#           duration_seconds to prove only the offending key is dropped)
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_full_telemetry_handoff "${tmpd}/journal/pending/bad.json" "$stub" \
    '.telemetry.route = "turbo"'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"
  captured=$(cat "$capture" 2>/dev/null || echo "")

  if ! echo "$captured" | grep -q -- "--route"; then
    pass "drop_route_flag_absent"
  else
    fail "drop_route_flag_absent" "invalid --route must not be forwarded. got: ${captured}"
  fi
  if echo "$captured" | grep -q -- "--duration-seconds 840"; then
    pass "drop_route_other_valid_key_preserved"
  else
    fail "drop_route_other_valid_key_preserved" "--duration-seconds 840 must still be forwarded (only route should be dropped). got: ${captured}"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "drop_route_base_entry_preserved"
  else
    fail "drop_route_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/bad.json" ]]; then
    pass "drop_route_pending_removed"
  else
    fail "drop_route_pending_removed" "pending file must not be stuck on telemetry-key drop"
  fi
  if grep -q "telemetry-key-dropped: route" \
    "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "drop_route_logged"
  else
    fail "drop_route_logged" "drop must be recorded in the log (silent drop 禁止)"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test 19 (integration): 実 journal.sh が存在する環境では、telemetry 8 キーが
#          実際に journal entry の .telemetry へ到達することを確認する
#          （skills repo 側の --vdelta-* / --route 等の受理契約との結合テスト）。
#          未配置環境では skip（Test 15 と同じ扱い）。
# --------------------------------------------------------------------------
{
  REAL_JOURNAL="${SCRIPT_DIR}/../../playpark-core/skill-retrospective/scripts/journal.sh"
  if [[ ! -x $REAL_JOURNAL ]]; then
    echo "  (skip: real journal.sh not found — integration test skipped)"
  else
    tmpd=$(make_tmpdir)
    mkdir -p "${tmpd}/journal/pending"

    make_full_telemetry_handoff "${tmpd}/journal/pending/e2e8.json" "$REAL_JOURNAL"

    run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

    entry=$(ls "${tmpd}/journal"/*.json 2>/dev/null | head -1 || true)
    if [[ -z $entry ]]; then
      fail "integration_8key_entry_written" "no journal entry created. hook output: ${RUN_OUT}"
    else
      pass "integration_8key_entry_written"
      if [[ $(jq -r '.telemetry.vdelta_verdicts[0].ac' "$entry") == "1" ]] &&
        [[ $(jq -r '.telemetry.route' "$entry") == "lite" ]] &&
        [[ $(jq -r '.telemetry.duration_seconds' "$entry") == "840" ]] &&
        [[ $(jq -r '.telemetry.phase_durations.analyze' "$entry") == "120" ]]; then
        pass "integration_8key_telemetry_persisted"
      else
        fail "integration_8key_telemetry_persisted" "8-key telemetry missing in entry: $(jq -c '.telemetry' "$entry")"
      fi
    fi

    rm -rf "$tmpd"
  fi
}

# --------------------------------------------------------------------------
# Test T-A: valid trust_evalseal_missing_reason → --trust-evalseal-missing-reason
#           is forwarded to journal.sh
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/evalseal.json" "$stub" \
    '.telemetry += {trust_evalseal_missing_reason: "agent_throw"}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--trust-evalseal-missing-reason agent_throw"; then
    pass "trust_evalseal_missing_reason_forwarded"
  else
    fail "trust_evalseal_missing_reason_forwarded" "expected --trust-evalseal-missing-reason agent_throw. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/evalseal.json" ]]; then
    pass "trust_evalseal_missing_reason_pending_removed"
  else
    fail "trust_evalseal_missing_reason_pending_removed" "pending file should be removed after success"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test T-B: trust_evalseal_missing_reason with a closed-enum 契約違反の値
#           → 当該フラグのみ drop、base entry は記録される、drop はログされる
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/badreason.json" "$stub" \
    '.telemetry += {trust_evalseal_missing_reason: "totally_bogus"}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--trust-evalseal-missing-reason"; then
    fail "bad_evalseal_missing_reason_dropped" "invalid --trust-evalseal-missing-reason must not be forwarded. got: ${captured}"
  else
    pass "bad_evalseal_missing_reason_dropped"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "bad_evalseal_missing_reason_base_entry_preserved"
  else
    fail "bad_evalseal_missing_reason_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if grep -q "trust-key-dropped: trust_evalseal_missing_reason" \
    "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "bad_evalseal_missing_reason_logged"
  else
    fail "bad_evalseal_missing_reason_logged" "drop must be recorded in the log (silent drop 禁止)"
  fi
  if [[ ! -f "${tmpd}/journal/pending/badreason.json" ]]; then
    pass "bad_evalseal_missing_reason_pending_removed"
  else
    fail "bad_evalseal_missing_reason_pending_removed" "pending file must not be stuck on trust-key drop"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test T-C: trust_evalseal_missing_reason absent → no such flag at all
#           (空値を渡さない)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/noreason.json" "$stub" '.'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--trust-evalseal-missing-reason"; then
    fail "trust_evalseal_missing_reason_absent_no_flag" "no --trust-evalseal-missing-reason flag expected. got: ${captured}"
  else
    pass "trust_evalseal_missing_reason_absent_no_flag"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test T-D (integration): 実 journal.sh が存在する環境では、
#          trust_evalseal_missing_reason が実際に journal entry の
#          telemetry へ到達することを確認する。未配置環境では skip。
# --------------------------------------------------------------------------
{
  REAL_JOURNAL="${SCRIPT_DIR}/../../playpark-core/skill-retrospective/scripts/journal.sh"
  if [[ ! -x $REAL_JOURNAL ]]; then
    echo "  (skip: real journal.sh not found — integration test skipped)"
  else
    tmpd=$(make_tmpdir)
    mkdir -p "${tmpd}/journal/pending"

    make_trust_handoff "${tmpd}/journal/pending/e2ereason.json" "$REAL_JOURNAL" \
      '.telemetry += {trust_evalseal_missing_reason: "seal_error"}'

    run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

    entry=$(ls "${tmpd}/journal"/*.json 2>/dev/null | head -1 || true)
    if [[ -z $entry ]]; then
      fail "integration_evalseal_missing_reason_entry_written" "no journal entry created. hook output: ${RUN_OUT}"
    else
      pass "integration_evalseal_missing_reason_entry_written"
      if [[ $(jq -r '.telemetry.trust_evalseal_missing_reason' "$entry") == "seal_error" ]] &&
        [[ $(jq -r '.telemetry.merge_tier' "$entry") == "REVIEW" ]]; then
        pass "integration_evalseal_missing_reason_persisted"
      else
        fail "integration_evalseal_missing_reason_persisted" "trust_evalseal_missing_reason missing/altered in entry: $(jq -c '.telemetry' "$entry")"
      fi
    fi

    rm -rf "$tmpd"
  fi
}

# --------------------------------------------------------------------------
# Test T-E: valid trust_effectdelta_pr_missing_reason
#           → --trust-effectdelta-pr-missing-reason is forwarded to journal.sh
#           (issue #156 AC-1 / skills#476 Phase 1 送り側)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/effectdelta.json" "$stub" \
    '.telemetry += {trust_effectdelta_pr_missing_reason: "gh_failed"}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--trust-effectdelta-pr-missing-reason gh_failed"; then
    pass "trust_effectdelta_pr_missing_reason_forwarded"
  else
    fail "trust_effectdelta_pr_missing_reason_forwarded" "expected --trust-effectdelta-pr-missing-reason gh_failed. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/effectdelta.json" ]]; then
    pass "trust_effectdelta_pr_missing_reason_pending_removed"
  else
    fail "trust_effectdelta_pr_missing_reason_pending_removed" "pending file should be removed after success"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test T-E2: closed enum の全 8 値が転送される（EvalSeal と値集合が違うので
#            取り違えると silent に落ちる。全値を固定する — issue #156 AC-1）
# --------------------------------------------------------------------------
{
  for reason in agent_throw agent_null mode_off gh_failed script_error agent_error schema_invalid unknown; do
    tmpd=$(make_tmpdir)
    mkdir -p "${tmpd}/journal/pending"
    capture="${tmpd}/capture.txt"
    stub="${tmpd}/journal.sh"
    make_stub_journal "$stub" "$capture" 0

    make_trust_handoff "${tmpd}/journal/pending/ed-${reason}.json" "$stub" \
      ".telemetry += {trust_effectdelta_pr_missing_reason: \"${reason}\"}"

    run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

    captured=$(cat "$capture" 2>/dev/null || echo "")
    if echo "$captured" | grep -q -- "--trust-effectdelta-pr-missing-reason ${reason}"; then
      pass "trust_effectdelta_pr_missing_reason_enum_${reason}"
    else
      fail "trust_effectdelta_pr_missing_reason_enum_${reason}" "enum value ${reason} must be forwarded. got: ${captured}"
    fi

    rm -rf "$tmpd"
  done
}

# --------------------------------------------------------------------------
# Test T-F: trust_effectdelta_pr_missing_reason に closed-enum 契約違反の値
#           → 当該フラグのみ drop、base entry は記録される、drop はログされる
#           (issue #156 AC-2 / AC-3)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  # seal_error は EvalSeal 側 enum の値であり EffectDelta 側には無い。
  # case を共有すると誤って通るので、この値で分離を固定する。
  make_trust_handoff "${tmpd}/journal/pending/badeffectdelta.json" "$stub" \
    '.telemetry += {trust_effectdelta_pr_missing_reason: "seal_error"}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--trust-effectdelta-pr-missing-reason"; then
    fail "bad_effectdelta_pr_missing_reason_dropped" "invalid --trust-effectdelta-pr-missing-reason must not be forwarded. got: ${captured}"
  else
    pass "bad_effectdelta_pr_missing_reason_dropped"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "bad_effectdelta_pr_missing_reason_base_entry_preserved"
  else
    fail "bad_effectdelta_pr_missing_reason_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if grep -q "trust-key-dropped: trust_effectdelta_pr_missing_reason" \
    "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "bad_effectdelta_pr_missing_reason_logged"
  else
    fail "bad_effectdelta_pr_missing_reason_logged" "drop must be recorded in the log (silent drop 禁止)"
  fi
  if [[ ! -f "${tmpd}/journal/pending/badeffectdelta.json" ]]; then
    pass "bad_effectdelta_pr_missing_reason_pending_removed"
  else
    fail "bad_effectdelta_pr_missing_reason_pending_removed" "pending file must not be stuck on trust-key drop"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test T-G: trust_effectdelta_pr_missing_reason absent → no such flag at all
#           (空値を渡さない。journal.sh は空文字でも die_json するため
#            entry ごと失う — issue #156 AC-4)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/noeffectdelta.json" "$stub" '.'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--trust-effectdelta-pr-missing-reason"; then
    fail "trust_effectdelta_pr_missing_reason_absent_no_flag" "no --trust-effectdelta-pr-missing-reason flag expected. got: ${captured}"
  else
    pass "trust_effectdelta_pr_missing_reason_absent_no_flag"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test T-H (integration): 実 journal.sh が存在する環境では、
#          trust_effectdelta_pr_missing_reason が実際に journal entry の
#          telemetry へ到達することを確認する。未配置環境では skip。
#          (issue #156 AC-5)
# --------------------------------------------------------------------------
{
  REAL_JOURNAL="${SCRIPT_DIR}/../../playpark-core/skill-retrospective/scripts/journal.sh"
  if [[ ! -x $REAL_JOURNAL ]]; then
    echo "  (skip: real journal.sh not found — integration test skipped)"
  else
    tmpd=$(make_tmpdir)
    mkdir -p "${tmpd}/journal/pending"

    make_trust_handoff "${tmpd}/journal/pending/e2eeffectdelta.json" "$REAL_JOURNAL" \
      '.telemetry += {trust_effectdelta_pr_missing_reason: "gh_failed"}'

    run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

    entry=$(ls "${tmpd}/journal"/*.json 2>/dev/null | head -1 || true)
    if [[ -z $entry ]]; then
      fail "integration_effectdelta_pr_missing_reason_entry_written" "no journal entry created. hook output: ${RUN_OUT}"
    else
      pass "integration_effectdelta_pr_missing_reason_entry_written"
      if [[ $(jq -r '.telemetry.trust_effectdelta_pr_missing_reason' "$entry") == "gh_failed" ]] &&
        [[ $(jq -r '.telemetry.merge_tier' "$entry") == "REVIEW" ]]; then
        pass "integration_effectdelta_pr_missing_reason_persisted"
      else
        fail "integration_effectdelta_pr_missing_reason_persisted" "trust_effectdelta_pr_missing_reason missing/altered in entry: $(jq -c '.telemetry' "$entry")"
      fi
    fi

    rm -rf "$tmpd"
  fi
}

# --------------------------------------------------------------------------
# Test G-A: valid guard_id → --guard-id が journal.sh へ転送される
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/guardid.json" "$stub" \
    '.telemetry += {guard_id: "sandbox-deny"}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--guard-id sandbox-deny"; then
    pass "guard_id_forwarded"
  else
    fail "guard_id_forwarded" "expected --guard-id sandbox-deny. got: ${captured}"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "guard_id_base_entry_preserved"
  else
    fail "guard_id_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/guardid.json" ]]; then
    pass "guard_id_pending_removed"
  else
    fail "guard_id_pending_removed" "pending file should be removed after success"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test G-B: comma 区切りの multi-guard 値がそのまま転送される
#           (journal.sh 側は comma 区切りリストを受理する契約)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/multiguard.json" "$stub" \
    '.telemetry += {guard_id: "sandbox-deny,inline-edit-guard"}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--guard-id sandbox-deny,inline-edit-guard"; then
    pass "guard_id_multi_forwarded_intact"
  else
    fail "guard_id_multi_forwarded_intact" "comma-joined guard_id must be forwarded verbatim. got: ${captured}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test G-C: guard_id 不在 → --guard-id フラグ自体が出ない (空値を渡さない)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/noguard.json" "$stub" '.'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--guard-id"; then
    fail "guard_id_absent_no_flag" "no --guard-id flag expected. got: ${captured}"
  else
    pass "guard_id_absent_no_flag"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test G-D: guard_id が JSON null → --guard-id を渡さない
#           (jq -r で "null" 文字列化されるため、明示的に弾く必要がある)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/nullguard.json" "$stub" \
    '.telemetry += {guard_id: null}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--guard-id"; then
    fail "guard_id_null_no_flag" "JSON null guard_id must not be forwarded as the literal string null. got: ${captured}"
  else
    pass "guard_id_null_no_flag"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "guard_id_null_base_entry_preserved"
  else
    fail "guard_id_null_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test G-E (integration): 実 journal.sh が --guard-id を受理する環境では、
#          guard_id が journal entry の telemetry へ到達することを確認する。
#          未配置 / 未対応 (skills#530 未 merge) の環境では skip。
# --------------------------------------------------------------------------
{
  REAL_JOURNAL="${SCRIPT_DIR}/../../playpark-core/skill-retrospective/scripts/journal.sh"
  if [[ ! -x $REAL_JOURNAL ]]; then
    echo "  (skip: real journal.sh not found — integration test skipped)"
  elif ! grep -q -- '--guard-id' "$REAL_JOURNAL"; then
    echo "  (skip: real journal.sh does not support --guard-id yet — 受け側 skills#530 未 merge)"
  else
    tmpd=$(make_tmpdir)
    mkdir -p "${tmpd}/journal/pending"

    make_trust_handoff "${tmpd}/journal/pending/e2eguard.json" "$REAL_JOURNAL" \
      '.telemetry += {guard_id: "sandbox-deny"}'

    run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

    entry=$(ls "${tmpd}/journal"/*.json 2>/dev/null | head -1 || true)
    if [[ -z $entry ]]; then
      fail "integration_guard_id_entry_written" "no journal entry created. hook output: ${RUN_OUT}"
    else
      pass "integration_guard_id_entry_written"
      if [[ $(jq -r '.telemetry.guard_id' "$entry") == "sandbox-deny" ]] &&
        [[ $(jq -r '.telemetry.merge_tier' "$entry") == "REVIEW" ]]; then
        pass "integration_guard_id_persisted"
      else
        fail "integration_guard_id_persisted" "guard_id missing/altered in entry: $(jq -c '.telemetry' "$entry")"
      fi
    fi

    rm -rf "$tmpd"
  fi
}

# --------------------------------------------------------------------------
# Test P-A: iterate_rounds / fixes_applied → --telemetry-json へ載って転送される
#           (skills#535: pr-iterate の fix 回数を測定可能にする AC)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/iterate.json" "$stub" \
    '.telemetry += {iterate_rounds: 3, fixes_applied: 2}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- '--telemetry-json'; then
    pass "passthrough_flag_present"
  else
    fail "passthrough_flag_present" "expected --telemetry-json. got: ${captured}"
  fi
  if echo "$captured" | grep -q '"iterate_rounds":3'; then
    pass "iterate_rounds_forwarded"
  else
    fail "iterate_rounds_forwarded" "expected iterate_rounds:3. got: ${captured}"
  fi
  if echo "$captured" | grep -q '"fixes_applied":2'; then
    pass "fixes_applied_forwarded"
  else
    fail "fixes_applied_forwarded" "expected fixes_applied:2. got: ${captured}"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "passthrough_base_entry_preserved"
  else
    fail "passthrough_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/iterate.json" ]]; then
    pass "passthrough_pending_removed"
  else
    fail "passthrough_pending_removed" "pending file should be removed after success"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test P-B: 既に silent drop されていた 4 キーも同じ経路で回収される
#           (fix_null_retries / review_null_retries / fix_uncommitted_recovered /
#            subagent_invocations。subagent_invocations は object 値)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/dropped.json" "$stub" \
    '.telemetry += {fix_null_retries: 1, review_null_retries: 2, fix_uncommitted_recovered: 3, subagent_invocations: {"pr-reviewer": 4}}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -qF -- '"fix_null_retries":1'; then
    pass "passthrough_recovered_fix_null_retries"
  else
    fail "passthrough_recovered_fix_null_retries" "expected fix_null_retries:1. got: ${captured}"
  fi
  if echo "$captured" | grep -qF -- '"review_null_retries":2'; then
    pass "passthrough_recovered_review_null_retries"
  else
    fail "passthrough_recovered_review_null_retries" "expected review_null_retries:2. got: ${captured}"
  fi
  if echo "$captured" | grep -qF -- '"fix_uncommitted_recovered":3'; then
    pass "passthrough_recovered_fix_uncommitted_recovered"
  else
    fail "passthrough_recovered_fix_uncommitted_recovered" "expected fix_uncommitted_recovered:3. got: ${captured}"
  fi
  if echo "$captured" | grep -qF -- '"subagent_invocations":{"pr-reviewer":4}'; then
    pass "passthrough_recovered_subagent_invocations"
  else
    fail "passthrough_recovered_subagent_invocations" "expected subagent_invocations object. got: ${captured}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test P-C: passthrough キーが 1 つも無い → --telemetry-json フラグ自体を出さない
#           (空 object を渡して journal.sh の検証を無駄に踏まない)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/nopass.json" "$stub" '.'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--telemetry-json"; then
    fail "passthrough_absent_no_flag" "no --telemetry-json flag expected. got: ${captured}"
  else
    pass "passthrough_absent_no_flag"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "passthrough_absent_base_entry_preserved"
  else
    fail "passthrough_absent_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test P-D: JSON null のキーは object から除外される（存在する数値キーは残す）
#           null をそのまま載せると doctor 側の集計で 0 と区別できなくなる
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/nullmix.json" "$stub" \
    '.telemetry += {iterate_rounds: 0, fixes_applied: null}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q '"iterate_rounds":0'; then
    pass "passthrough_zero_preserved"
  else
    fail "passthrough_zero_preserved" "expected iterate_rounds:0. got: ${captured}"
  fi
  if echo "$captured" | grep -q '"fixes_applied"'; then
    fail "passthrough_null_dropped" "null value must not be forwarded. got: ${captured}"
  else
    pass "passthrough_null_dropped"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test P-E (integration): 実 journal.sh が --telemetry-json を受理する環境で、
#          iterate_rounds / fixes_applied が journal entry の telemetry へ
#          「数値で」到達することを確認する（skills#535 の受け入れ条件そのもの）。
#          未配置 / 未対応の環境では skip。
# --------------------------------------------------------------------------
{
  REAL_JOURNAL="${SCRIPT_DIR}/../../playpark-core/skill-retrospective/scripts/journal.sh"
  if [[ ! -x $REAL_JOURNAL ]]; then
    echo "  (skip: real journal.sh not found — integration test skipped)"
  elif ! grep -q -- '--telemetry-json' "$REAL_JOURNAL"; then
    echo "  (skip: real journal.sh does not support --telemetry-json — 受け側未対応)"
  else
    tmpd=$(make_tmpdir)
    mkdir -p "${tmpd}/journal/pending"

    make_trust_handoff "${tmpd}/journal/pending/e2epass.json" "$REAL_JOURNAL" \
      '.telemetry += {iterate_rounds: 3, fixes_applied: 2}'

    run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

    entry=$(ls "${tmpd}/journal"/*.json 2>/dev/null | head -1 || true)
    if [[ -z $entry ]]; then
      fail "integration_passthrough_entry_written" "no journal entry created. hook output: ${RUN_OUT}"
    else
      pass "integration_passthrough_entry_written"
      if [[ $(jq -r '.telemetry.iterate_rounds | type' "$entry") == "number" ]] &&
        [[ $(jq -r '.telemetry.iterate_rounds' "$entry") == "3" ]] &&
        [[ $(jq -r '.telemetry.fixes_applied | type' "$entry") == "number" ]] &&
        [[ $(jq -r '.telemetry.fixes_applied' "$entry") == "2" ]] &&
        [[ $(jq -r '.telemetry.merge_tier' "$entry") == "REVIEW" ]]; then
        pass "integration_passthrough_persisted_as_number"
      else
        fail "integration_passthrough_persisted_as_number" "iterate_rounds/fixes_applied missing or non-numeric: $(jq -c '.telemetry' "$entry")"
      fi
    fi

    rm -rf "$tmpd"
  fi
}

# --------------------------------------------------------------------------
# Test CONF-A: eval_confidence: 0.85 (number) → --eval-confidence 0.85 forwarded
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/conf-a.json" "$stub" \
    '.telemetry += {eval_confidence: 0.85}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--eval-confidence 0.85"; then
    pass "eval_confidence_number_forwarded"
  else
    fail "eval_confidence_number_forwarded" "expected --eval-confidence 0.85. got: ${captured}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test CONF-B: eval_confidence: null (key present, value null) → --eval-confidence
#              null is forwarded (欠落とは区別する — AC-3)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/conf-b.json" "$stub" \
    '.telemetry += {eval_confidence: null}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--eval-confidence null"; then
    pass "eval_confidence_null_forwarded"
  else
    fail "eval_confidence_null_forwarded" "expected --eval-confidence null. got: ${captured}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test CONF-C: eval_confidence key absent → --eval-confidence flag not forwarded
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/conf-c.json" "$stub" '.'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--eval-confidence"; then
    fail "eval_confidence_absent_not_forwarded" "no --eval-confidence flag expected. got: ${captured}"
  else
    pass "eval_confidence_absent_not_forwarded"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "eval_confidence_absent_base_entry_preserved"
  else
    fail "eval_confidence_absent_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test CONF-D: eval_confidence: 0 (falsy boundary value) → --eval-confidence 0
#              forwarded (truthiness 判定を使わない)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/conf-d.json" "$stub" \
    '.telemetry += {eval_confidence: 0}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--eval-confidence 0$" ||
    echo "$captured" | grep -q -- "--eval-confidence 0 "; then
    pass "eval_confidence_zero_forwarded"
  else
    fail "eval_confidence_zero_forwarded" "expected --eval-confidence 0. got: ${captured}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test CONF-E: review_confidence: 0.42 + review_decision: "approve" → both
#              forwarded to journal.sh
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/conf-e.json" "$stub" \
    '.telemetry += {review_confidence: 0.42, review_decision: "approve"}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--review-confidence 0.42"; then
    pass "review_confidence_forwarded"
  else
    fail "review_confidence_forwarded" "expected --review-confidence 0.42. got: ${captured}"
  fi
  if echo "$captured" | grep -q -- "--review-decision approve"; then
    pass "review_decision_approve_forwarded"
  else
    fail "review_decision_approve_forwarded" "expected --review-decision approve. got: ${captured}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test CONF-F: review_decision outside the approve|request-changes|comment
#              enum → not forwarded, dropped and logged (silent drop 禁止)
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_trust_handoff "${tmpd}/journal/pending/conf-f.json" "$stub" \
    '.telemetry += {review_decision: "bikeshed"}'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--review-decision"; then
    fail "review_decision_invalid_dropped" "invalid --review-decision must not be forwarded. got: ${captured}"
  else
    pass "review_decision_invalid_dropped"
  fi
  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "review_decision_invalid_base_entry_preserved"
  else
    fail "review_decision_invalid_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if grep -q "telemetry-key-dropped: review_decision" \
    "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "review_decision_invalid_logged"
  else
    fail "review_decision_invalid_logged" "drop must be recorded in the log (silent drop 禁止)"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test CONF-G (integration): 実 journal.sh が --eval-confidence /
#          --review-confidence / --review-decision を受理する環境では、
#          journal entry の .telemetry へ実際に到達することを確認する
#          （skills#561 F2 の受け側配線との結合テスト）。未配置 / 未対応の環境では skip。
# --------------------------------------------------------------------------
{
  REAL_JOURNAL="${SCRIPT_DIR}/../../playpark-core/skill-retrospective/scripts/journal.sh"
  if [[ ! -x $REAL_JOURNAL ]]; then
    echo "  (skip: real journal.sh not found — integration test skipped)"
  elif ! grep -q -- '--eval-confidence' "$REAL_JOURNAL"; then
    echo "  (skip: real journal.sh does not support --eval-confidence — 受け側未対応)"
  else
    tmpd=$(make_tmpdir)
    mkdir -p "${tmpd}/journal/pending"

    make_trust_handoff "${tmpd}/journal/pending/e2econf.json" "$REAL_JOURNAL" \
      '.telemetry += {eval_confidence: 0.9, review_confidence: null, review_decision: "comment"}'

    run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

    entry=$(ls "${tmpd}/journal"/*.json 2>/dev/null | head -1 || true)
    if [[ -z $entry ]]; then
      fail "integration_confidence_entry_written" "no journal entry created. hook output: ${RUN_OUT}"
    else
      pass "integration_confidence_entry_written"
      if [[ $(jq -r '.telemetry.eval_confidence' "$entry") == "0.9" ]] &&
        [[ $(jq -r '.telemetry.review_confidence' "$entry") == "null" ]] &&
        [[ $(jq -r '.telemetry.review_decision' "$entry") == "comment" ]]; then
        pass "integration_confidence_persisted"
      else
        fail "integration_confidence_persisted" "confidence telemetry missing/mismatched in entry: $(jq -c '.telemetry' "$entry")"
      fi
    fi

    rm -rf "$tmpd"
  fi
}

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
if ((FAIL > 0)); then
  printf '\n'
  printf 'Failures:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
  exit 1
fi
exit 0
