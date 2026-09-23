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
  mktemp -d "${TMPDIR:-/tmp}/stop-devflow-test.XXXXXX"
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
        eval_iter: 1
      }
    }' >"${tmpd}/journal/pending/regression.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  expected='log dev-flow success --issue 203 --merge-tier REVIEW --gate-policy llm-major-advisory --danger-hits [] --shape standard --eval-iter 1'

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
# Test 9i: abort payload（top-level error_phase）→ --error-phase として転送され、
#          telemetry.abort_phase / abort_label は --telemetry-json passthrough で到達する
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
      issue: 607,
      repo: "it-all-playpark/skills",
      journal_sh: $js,
      error_category: "abort",
      error_msg: "abort@Evaluate/eval#1: evaluator boom",
      error_phase: "Evaluate",
      telemetry: {
        gate_policy: "llm-major-advisory",
        shape: "standard",
        eval_iter: 1,
        abort_phase: "Evaluate",
        abort_label: "eval#1"
      }
    }' >"${tmpd}/journal/pending/abortrun.json"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ -f $capture ]]; then
    captured=$(cat "$capture")
    if echo "$captured" | grep -q "log dev-flow failure"; then
      pass "abort_skill_outcome"
    else
      fail "abort_skill_outcome" "expected 'log dev-flow failure'. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--error-category abort"; then
      pass "abort_error_category"
    else
      fail "abort_error_category" "--error-category abort not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--error-msg"; then
      pass "abort_error_msg"
    else
      fail "abort_error_msg" "--error-msg not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--error-phase Evaluate"; then
      pass "abort_error_phase"
    else
      fail "abort_error_phase" "--error-phase Evaluate not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--shape standard"; then
      pass "abort_shape"
    else
      fail "abort_shape" "--shape standard not found. got: ${captured}"
    fi
    if echo "$captured" | grep -q -- "--telemetry-json"; then
      pass "abort_telemetry_json_present"
    else
      fail "abort_telemetry_json_present" "--telemetry-json not found. got: ${captured}"
    fi

    passthrough_json=$(printf '%s' "$captured" | sed -n 's/.*--telemetry-json //p')
    if echo "$passthrough_json" | jq -e '.abort_phase == "Evaluate" and .abort_label == "eval#1"' >/dev/null 2>&1; then
      pass "abort_telemetry_passthrough_fields"
    else
      fail "abort_telemetry_passthrough_fields" "expected abort_phase/abort_label in passthrough JSON. got: ${passthrough_json}"
    fi
  else
    fail "abort_stub_called" "capture file not created (stub not called)"
  fi

  if [[ ! -f "${tmpd}/journal/pending/abortrun.json" ]]; then
    pass "abort_pending_removed"
  else
    fail "abort_pending_removed" "pending file should be removed after successful processing"
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
# Helper: build a handoff with base telemetry, then apply a jq filter to add keys
# Usage: make_base_handoff <outfile> <stub_path> <jq_filter>
# --------------------------------------------------------------------------
make_base_handoff() {
  local outfile="$1" stub="$2" extra_filter="$3"
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
      eval_iter: 1
    }
  }' | jq "$extra_filter" >"$outfile"
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
      eval_iter: 1,
      vdelta_verdicts: [{"ac":1,"status":"promoted"}],
      vdelta_fail_open: 1,
      redgreen_deny: [{"ac":2,"reasons":["no red"]}],
      testsurf_hits: ["test/foo.test.js"],
      duration_seconds: 840,
      phase_durations: {"implement":120,"validate":95},
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
    if echo "$captured" | grep -q -- '--phase-durations {"implement":120,"validate":95}'; then
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
#          "telemetry-key-dropped: <key>" (fail-open).
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
    '.telemetry.phase_durations = {"implement":"fast"}'

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
        [[ $(jq -r '.telemetry.phase_durations.implement' "$entry") == "120" ]]; then
        pass "integration_8key_telemetry_persisted"
      else
        fail "integration_8key_telemetry_persisted" "8-key telemetry missing in entry: $(jq -c '.telemetry' "$entry")"
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

  make_base_handoff "${tmpd}/journal/pending/guardid.json" "$stub" \
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

  make_base_handoff "${tmpd}/journal/pending/multiguard.json" "$stub" \
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

  make_base_handoff "${tmpd}/journal/pending/noguard.json" "$stub" '.'

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

  make_base_handoff "${tmpd}/journal/pending/nullguard.json" "$stub" \
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

    make_base_handoff "${tmpd}/journal/pending/e2eguard.json" "$REAL_JOURNAL" \
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

  make_base_handoff "${tmpd}/journal/pending/iterate.json" "$stub" \
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

  make_base_handoff "${tmpd}/journal/pending/dropped.json" "$stub" \
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

  make_base_handoff "${tmpd}/journal/pending/nopass.json" "$stub" '.'

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

  make_base_handoff "${tmpd}/journal/pending/nullmix.json" "$stub" \
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

    make_base_handoff "${tmpd}/journal/pending/e2epass.json" "$REAL_JOURNAL" \
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

  make_base_handoff "${tmpd}/journal/pending/conf-a.json" "$stub" \
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

  make_base_handoff "${tmpd}/journal/pending/conf-b.json" "$stub" \
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

  make_base_handoff "${tmpd}/journal/pending/conf-c.json" "$stub" '.'

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

  make_base_handoff "${tmpd}/journal/pending/conf-d.json" "$stub" \
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

  make_base_handoff "${tmpd}/journal/pending/conf-e.json" "$stub" \
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

  make_base_handoff "${tmpd}/journal/pending/conf-f.json" "$stub" \
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

    make_base_handoff "${tmpd}/journal/pending/e2econf.json" "$REAL_JOURNAL" \
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
# Test P-F (AC1 回帰): hook が明示列挙しない新規 telemetry キー（fix_terminal_reason /
#           terminal_path / eval_model_config / plugin_version / iterate_history）が
#           passthrough 経由で journal entry へ到達する（skills#601）
# --------------------------------------------------------------------------
{
  if [[ "$(grep -c 'fix_terminal_reason' "$HOOK")" -eq 0 ]]; then
    pass "pf_hook_has_no_fix_terminal_reason_literal"
  else
    fail "pf_hook_has_no_fix_terminal_reason_literal" "hook should not hardcode fix_terminal_reason — it must reach journal via passthrough only"
  fi
  if [[ "$(grep -c 'iterate_history' "$HOOK")" -eq 0 ]]; then
    pass "pf_hook_has_no_iterate_history_literal"
  else
    fail "pf_hook_has_no_iterate_history_literal" "hook should not hardcode iterate_history — it must reach journal via passthrough only"
  fi

  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_base_handoff "${tmpd}/journal/pending/pf.json" "$stub" \
    '.telemetry += {
      fix_terminal_reason: "applied_false",
      terminal_path: "ci",
      eval_model_config: "opus",
      review_model_config: "opus",
      plugin_version: "0.3.0",
      iterate_history: [{iteration: 1, decision: "request-changes", summary: "ng", blocking: [{severity: "major", topic: "t1"}], minor: []}]
    }'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- '--telemetry-json'; then
    pass "pf_telemetry_json_present"
  else
    fail "pf_telemetry_json_present" "expected --telemetry-json. got: ${captured}"
  fi

  passthrough_json=$(printf '%s' "$captured" | sed -n 's/.*--telemetry-json //p')
  if echo "$passthrough_json" | jq -e '
      .fix_terminal_reason == "applied_false" and
      .terminal_path == "ci" and
      .eval_model_config == "opus" and
      .review_model_config == "opus" and
      .plugin_version == "0.3.0" and
      .iterate_history[0].decision == "request-changes" and
      .iterate_history[0].blocking[0].topic == "t1"
    ' >/dev/null 2>&1; then
    pass "pf_new_keys_reach_passthrough"
  else
    fail "pf_new_keys_reach_passthrough" "expected new keys in passthrough JSON. got: ${passthrough_json}"
  fi

  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "pf_base_entry_preserved"
  else
    fail "pf_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/pf.json" ]]; then
    pass "pf_pending_removed"
  else
    fail "pf_pending_removed" "pending file should be removed after success"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test P-G (静的検証): PER_KEY_TELEMETRY_KEYS 配列と hook 内 `.telemetry.<key>`
#           参照が両方向で一致する（除外漏れ・配列の孤立要素を検出する）
# --------------------------------------------------------------------------
{
  # 配列読み込みに mapfile（bash 4+）を使わない — AC7 が規定する起動形
  # `bash plugins/dev-flow/hooks/stop-devflow-telemetry.test.sh` は macOS 標準の
  # /bin/bash 3.2 で解決されうるため。
  array_keys=()
  while IFS= read -r k; do
    [[ -n $k ]] && array_keys+=("$k")
  done < <(sed -n '/^PER_KEY_TELEMETRY_KEYS=(/,/^)/p' "$HOOK" | tr -s ' \n' '\n' | grep -E '^[a-z_]+$')

  # 参照の抽出は jq projection ブロックに限定する。hook 全文を grep すると、コメントに
  # `.telemetry.<key>` と書いてあるだけで pass してしまい、静的 pin がコメント文字列に依存する。
  # projection 内の per-key 抽出には `.telemetry.<key>` 形式と、null-safe な `has("<key>")` 形式
  # （eval_confidence / review_confidence）の 2 通りがあるため両方を拾う。
  referenced_keys=()
  while IFS= read -r k; do
    [[ -n $k ]] && referenced_keys+=("$k")
  done < <(
    sed -n "/^  if ! parsed=/,/^  }' --argjson perkey/p" "$HOOK" \
      | grep -oE '\.telemetry\.[a-z_]+|has\("[a-z_]+"\)' \
      | sed -e 's/^\.telemetry\.//' -e 's/^has("//' -e 's/")$//' \
      | sort -u
  )

  if [[ ${#array_keys[@]} -gt 0 ]]; then
    pass "pg_array_nonempty"
  else
    fail "pg_array_nonempty" "PER_KEY_TELEMETRY_KEYS array not found or empty in ${HOOK}"
  fi

  missing_from_array=()
  for k in "${referenced_keys[@]}"; do
    found=0
    for a in "${array_keys[@]}"; do
      [[ $a == "$k" ]] && found=1 && break
    done
    [[ $found -eq 0 ]] && missing_from_array+=("$k")
  done
  if [[ ${#missing_from_array[@]} -eq 0 ]]; then
    pass "pg_all_referenced_keys_in_array"
  else
    fail "pg_all_referenced_keys_in_array" "keys referenced via .telemetry.<key> but missing from PER_KEY_TELEMETRY_KEYS: ${missing_from_array[*]}"
  fi

  missing_from_hook=()
  for a in "${array_keys[@]}"; do
    found=0
    for k in "${referenced_keys[@]}"; do
      [[ $a == "$k" ]] && found=1 && break
    done
    [[ $found -eq 0 ]] && missing_from_hook+=("$a")
  done
  if [[ ${#missing_from_hook[@]} -eq 0 ]]; then
    pass "pg_all_array_keys_referenced"
  else
    fail "pg_all_array_keys_referenced" "keys in PER_KEY_TELEMETRY_KEYS but never referenced via .telemetry.<key>: ${missing_from_hook[*]}"
  fi
}

# --------------------------------------------------------------------------
# Test R-A (静的検証): trust-layer の telemetry 転送（issue #698 で撤去）が hook 本文に
#           残っていない。生産側は撤去済みで、per-key 抽出・enum 検証・flag 転送のどれが
#           残っても到達不能コードになるため、識別子の残骸そのものを pin する
# --------------------------------------------------------------------------
{
  residue=$(grep -n 'trust' "$HOOK" || true)
  if [[ -z $residue ]]; then
    pass "ra_no_trust_residue_in_hook"
  else
    fail "ra_no_trust_residue_in_hook" "trust-layer residue found in hook: ${residue}"
  fi
}

# --------------------------------------------------------------------------
# Test P-H (除外の動作): per-key キー（route / eval_confidence /
#           review_decision / guard_id）は passthrough から除外され、per-key flag
#           側にのみ現れる。per-key でないキー（subagent_invocations / terminal_path）
#           は passthrough に残る
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_base_handoff "${tmpd}/journal/pending/ph.json" "$stub" \
    '.telemetry += {
      route: "lite",
      eval_confidence: 0.5,
      review_decision: "approve",
      guard_id: "g",
      subagent_invocations: {total: 1, by_type: {x: 1}},
      terminal_path: "review"
    }'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  passthrough_json=$(printf '%s' "$captured" | sed -n 's/.*--telemetry-json //p')

  if echo "$passthrough_json" | jq -e '
      (has("merge_tier") | not) and
      (has("route") | not) and
      (has("eval_confidence") | not) and
      (has("review_decision") | not) and
      (has("guard_id") | not) and
      (.subagent_invocations.total == 1) and
      (.terminal_path == "review")
    ' >/dev/null 2>&1; then
    pass "ph_perkey_keys_excluded_others_kept"
  else
    fail "ph_perkey_keys_excluded_others_kept" "expected per-key keys excluded, others kept. got: ${passthrough_json}"
  fi

  if echo "$captured" | grep -q -- "--route lite" &&
    echo "$captured" | grep -q -- "--guard-id g"; then
    pass "ph_perkey_flags_still_forwarded"
  else
    fail "ph_perkey_flags_still_forwarded" "expected per-key flags forwarded. got: ${captured}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test P-I (現行挙動 pin): .telemetry が非 object（文字列）→ per-key 行が jq エラー
#           となり、既存の malformed 経路（pending/malformed/ + malformed-json ログ）
#           へ落ちる。passthrough 側に type ガードは置かない（到達不能な dead code
#           になるため）
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_base_handoff "${tmpd}/journal/pending/pi.json" "$stub" '.telemetry = "oops"'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  if [[ $RUN_EXIT -eq 0 ]]; then
    pass "pi_exits_0"
  else
    fail "pi_exits_0" "hook must always exit 0, got ${RUN_EXIT}"
  fi
  if [[ ! -f $capture ]]; then
    pass "pi_stub_not_called"
  else
    fail "pi_stub_not_called" "stub should not be called when telemetry is non-object. got: $(cat "$capture")"
  fi
  if [[ -f "${tmpd}/journal/pending/malformed/pi.json" ]]; then
    pass "pi_moved_to_malformed"
  else
    fail "pi_moved_to_malformed" "expected file moved to pending/malformed/pi.json"
  fi
  if grep -q "malformed-json" "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "pi_malformed_logged"
  else
    fail "pi_malformed_logged" "expected malformed-json entry in log"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test P-J (AC6 fail-closed 不変): out-of-enum の enum キーは
#           passthrough 経由でも journal に到達しない（per-key で drop されたキーが
#           passthrough から漏れて fail-closed を迂回することを禁止する）
# --------------------------------------------------------------------------
{
  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_base_handoff "${tmpd}/journal/pending/pj.json" "$stub" \
    '.telemetry += {
      review_decision: "bogus",
      route: "bogus",
      terminal_path: "ci"
    }'

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- "--review-decision" ||
    echo "$captured" | grep -q -- "--route"; then
    fail "pj_perkey_flags_not_forwarded" "out-of-enum values must not be forwarded via per-key flags. got: ${captured}"
  else
    pass "pj_perkey_flags_not_forwarded"
  fi

  if grep -q "telemetry-key-dropped: review_decision" "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null &&
    grep -q "telemetry-key-dropped: route" "${tmpd}/.claude/logs/stop-devflow-telemetry.log" 2>/dev/null; then
    pass "pj_drops_logged"
  else
    fail "pj_drops_logged" "expected telemetry-key-dropped log lines"
  fi

  passthrough_json=$(printf '%s' "$captured" | sed -n 's/.*--telemetry-json //p')
  if echo "$passthrough_json" | jq -e '
      (has("review_decision") | not) and
      (has("route") | not) and
      (.terminal_path == "ci")
    ' >/dev/null 2>&1; then
    pass "pj_dropped_keys_absent_from_passthrough"
  else
    fail "pj_dropped_keys_absent_from_passthrough" "dropped per-key values must not leak via passthrough. got: ${passthrough_json}"
  fi

  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "pj_base_entry_preserved"
  else
    fail "pj_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test P-K (integration): 実 journal.sh が --telemetry-json を受理する環境で、
#          fix_terminal_reason / terminal_path / plugin_version /
#          eval_model_config / iterate_history が journal entry へ到達し、
#          per-key で drop された route（out-of-enum）は到達しない
#          ことを確認する。未配置 / 未対応の環境では skip。
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

    make_base_handoff "${tmpd}/journal/pending/pk.json" "$REAL_JOURNAL" \
      '.telemetry += {
        fix_terminal_reason: "commit_unensured",
        terminal_path: "review",
        plugin_version: "0.3.0",
        eval_model_config: "opus",
        review_model_config: "opus",
        iterate_history: [{iteration: 1, decision: "request-changes", summary: "ng", blocking: [{severity: "major", topic: "t1"}], minor: []}],
        route: "bogus"
      }'

    run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

    entry=$(ls "${tmpd}/journal"/*.json 2>/dev/null | head -1 || true)
    if [[ -z $entry ]]; then
      fail "pk_entry_written" "no journal entry created. hook output: ${RUN_OUT}"
    else
      pass "pk_entry_written"
      if [[ $(jq -r '.telemetry.fix_terminal_reason' "$entry") == "commit_unensured" ]] &&
        [[ $(jq -r '.telemetry.terminal_path' "$entry") == "review" ]] &&
        [[ $(jq -r '.telemetry.plugin_version' "$entry") == "0.3.0" ]] &&
        [[ $(jq -r '.telemetry.eval_model_config' "$entry") == "opus" ]] &&
        [[ $(jq -r '.telemetry.review_model_config' "$entry") == "opus" ]] &&
        [[ $(jq -r '.telemetry.iterate_history[0].decision' "$entry") == "request-changes" ]] &&
        [[ $(jq -r '.telemetry.iterate_history[0].blocking[0].topic' "$entry") == "t1" ]] &&
        [[ $(jq -r '.telemetry | has("route")' "$entry") == "false" ]] &&
        [[ $(jq -r '.telemetry.merge_tier' "$entry") == "REVIEW" ]]; then
        pass "pk_persisted_correctly"
      else
        fail "pk_persisted_correctly" "telemetry mismatch in entry: $(jq -c '.telemetry' "$entry")"
      fi
    fi

    rm -rf "$tmpd"
  fi
}

# --------------------------------------------------------------------------
# Shared payload for Test P-L / P-M: resolved_evidence object (skills#603).
# Mirrors _lib/resolved-evidence.mjs buildResolvedEvidence() output contract.
# --------------------------------------------------------------------------
RESOLVED_EVIDENCE_FILTER='.telemetry += { resolved_evidence: {
   cap_chars: 1000, truncated: false,
   ledger_resolved: ([range(0;21)] | map({id: ("EVAL-1-topic-" + (tostring)), lane: "blocking", dimension: "quality", text: ("item " + tostring), evidence: ("e|`\n" + ([range(0;200)] | map("x") | join("")))})),
   env_notes: [{id: "ENV-1", env_key: "bats-sandbox", env_count: 2, checked: true, text: "t", evidence: "CI で確認済み"}],
   ac_satisfied: ([range(0;8)] | map({ac_index: ., verified_by: "inspection", evidence: ("ac ok " + tostring)})),
   security_cleared: [{danger_class: "config", evidence: "safe"}, {danger_class: "network", evidence: "safe"}, {danger_class: "secrets", evidence: "safe"}]
 } }'

# --------------------------------------------------------------------------
# Test P-L (stub 経路): 新規 telemetry キー resolved_evidence（object）が hook に
#           ハードコードされず、passthrough 経由で journal.sh へ欠損なく到達する
#           （skills#603。hook 本体は変更しない）
# --------------------------------------------------------------------------
{
  if [[ "$(grep -c 'resolved_evidence' "$HOOK")" -eq 0 ]]; then
    pass "passthrough_resolved_evidence_hook_has_no_literal"
  else
    fail "passthrough_resolved_evidence_hook_has_no_literal" "hook should not hardcode resolved_evidence — it must reach journal via passthrough only"
  fi

  tmpd=$(make_tmpdir)
  mkdir -p "${tmpd}/journal/pending"
  capture="${tmpd}/capture.txt"
  stub="${tmpd}/journal.sh"
  make_stub_journal "$stub" "$capture" 0

  make_base_handoff "${tmpd}/journal/pending/pl.json" "$stub" "$RESOLVED_EVIDENCE_FILTER"

  run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

  captured=$(cat "$capture" 2>/dev/null || echo "")
  if echo "$captured" | grep -q -- '--telemetry-json'; then
    pass "passthrough_resolved_evidence_telemetry_json_present"
  else
    fail "passthrough_resolved_evidence_telemetry_json_present" "expected --telemetry-json. got: ${captured}"
  fi

  passthrough_json=$(printf '%s' "$captured" | sed -n 's/.*--telemetry-json //p')
  if echo "$passthrough_json" | jq -e '
      (.resolved_evidence.ledger_resolved | length) == 21 and
      (.resolved_evidence.ac_satisfied[7].ac_index == 7) and
      (.resolved_evidence.security_cleared | length) == 3 and
      (.resolved_evidence.env_notes[0].checked == true) and
      (.resolved_evidence.ledger_resolved[0].evidence | startswith("e|`\n")) and
      ((.resolved_evidence | tojson | length) > 5000)
    ' >/dev/null 2>&1; then
    pass "passthrough_resolved_evidence_object_intact"
  else
    fail "passthrough_resolved_evidence_object_intact" "expected 21-item resolved_evidence object intact in passthrough JSON. got (truncated): $(echo "$passthrough_json" | head -c 300)"
  fi

  if echo "$captured" | grep -q -- "--merge-tier REVIEW"; then
    pass "passthrough_resolved_evidence_base_entry_preserved"
  else
    fail "passthrough_resolved_evidence_base_entry_preserved" "base telemetry must still be logged. got: ${captured}"
  fi
  if [[ ! -f "${tmpd}/journal/pending/pl.json" ]]; then
    pass "passthrough_resolved_evidence_pending_removed"
  else
    fail "passthrough_resolved_evidence_pending_removed" "pending file should be removed after success"
  fi

  rm -rf "$tmpd"
}

# --------------------------------------------------------------------------
# Test P-M (integration): 実 journal.sh が --telemetry-json を受理する環境で、
#          resolved_evidence が journal entry へ欠損なく永続化され、per-key で
#          drop される route（out-of-enum）は不変で到達しないことを
#          確認する。未配置 / 未対応の環境では skip。
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

    make_base_handoff "${tmpd}/journal/pending/pm.json" "$REAL_JOURNAL" \
      "${RESOLVED_EVIDENCE_FILTER} | .telemetry += {route: \"bogus\"}"

    run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

    entry=$(ls "${tmpd}/journal"/*.json 2>/dev/null | head -1 || true)
    if [[ -z $entry ]]; then
      fail "integration_resolved_evidence_entry_written" "no journal entry created. hook output: ${RUN_OUT}"
    else
      pass "integration_resolved_evidence_entry_written"
      if [[ $(jq -r '.telemetry.resolved_evidence.ledger_resolved | length' "$entry") == "21" ]] &&
        [[ $(jq -r '.telemetry.resolved_evidence.security_cleared[0].danger_class' "$entry") == "config" ]] &&
        [[ $(jq -r '.telemetry.resolved_evidence.ledger_resolved[0].evidence | startswith("e|`\n")' "$entry") == "true" ]] &&
        [[ $(jq -r '.telemetry | has("route")' "$entry") == "false" ]] &&
        [[ $(jq -r '.telemetry.merge_tier' "$entry") == "REVIEW" ]]; then
        pass "integration_resolved_evidence_persisted"
      else
        fail "integration_resolved_evidence_persisted" "resolved_evidence mismatch in entry: $(jq -c '.telemetry.resolved_evidence | {cap: .cap_chars, ledger_len: (.ledger_resolved | length)}' "$entry")"
      fi
    fi

    rm -rf "$tmpd"
  fi
}

# --------------------------------------------------------------------------
# Test P-N (integration): 新規 telemetry キー vdelta_not_started（number）/
#          redgreen_headdiff（array）が hook にハードコードされず、passthrough 経由で
#          journal.sh へ欠損なく到達する（hook 本体・journal.sh は変更しない）
# --------------------------------------------------------------------------
{
  if [[ "$(grep -c 'vdelta_not_started' "$HOOK")" -eq 0 ]] && [[ "$(grep -c 'redgreen_headdiff' "$HOOK")" -eq 0 ]]; then
    pass "passthrough_redgreen_headdiff_hook_has_no_literal"
  else
    fail "passthrough_redgreen_headdiff_hook_has_no_literal" "hook should not hardcode vdelta_not_started/redgreen_headdiff — it must reach journal via passthrough only"
  fi

  REAL_JOURNAL="${SCRIPT_DIR}/../../playpark-core/skill-retrospective/scripts/journal.sh"
  if [[ ! -x $REAL_JOURNAL ]]; then
    echo "  (skip: real journal.sh not found — integration test skipped)"
  else
    tmpd=$(make_tmpdir)
    mkdir -p "${tmpd}/journal/pending"

    make_base_handoff "${tmpd}/journal/pending/pn.json" "$REAL_JOURNAL" \
      '.telemetry += {vdelta_not_started: 2, vdelta_fail_open: 1, redgreen_headdiff: [{ac:"AC-1",status:"clean",new:1,modified:0,unchanged:0,total:1},{ac:"AC-2",status:"test_modified",new:0,modified:1,unchanged:0,total:1}]}'

    run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

    entry=$(ls "${tmpd}/journal"/*.json 2>/dev/null | head -1 || true)
    if [[ -z $entry ]]; then
      fail "integration_redgreen_headdiff_persisted" "no journal entry created. hook output: ${RUN_OUT}"
    else
      if [[ $(jq -r '.telemetry.vdelta_not_started' "$entry") == "2" ]] &&
        [[ $(jq -r '.telemetry.vdelta_fail_open' "$entry") == "1" ]] &&
        [[ $(jq -r '.telemetry.redgreen_headdiff | length' "$entry") == "2" ]] &&
        [[ $(jq -r '.telemetry.redgreen_headdiff[1].status' "$entry") == "test_modified" ]] &&
        [[ $(jq -r '.telemetry.merge_tier' "$entry") == "REVIEW" ]]; then
        pass "integration_redgreen_headdiff_persisted"
      else
        fail "integration_redgreen_headdiff_persisted" "vdelta_not_started/redgreen_headdiff mismatch in entry: $(jq -c '.telemetry | {vdelta_not_started, vdelta_fail_open, redgreen_headdiff}' "$entry")"
      fi
    fi

    rm -rf "$tmpd"
  fi
}


# --------------------------------------------------------------------------
# Test S-A (integration, issue #640 / #676): 実効 shape の根拠 / analyze 経路の 6 キー
#          （shape_reason / realized_file_count / realized_file_count_raw /
#          ac_count / analyze_path / analyze_ineligible_reason）は per-key 配線無しで
#          passthrough（--telemetry-json）により実 journal entry の telemetry へ到達する。
#          null 値（realized_file_count 取得不能）は passthrough が落とすので
#          entry ではキー欠落になる（doctor は欠落と null を同一に扱う契約）。
# --------------------------------------------------------------------------
{
  REAL_JOURNAL="${SCRIPT_DIR}/../../playpark-core/skill-retrospective/scripts/journal.sh"
  if [[ ! -x $REAL_JOURNAL ]]; then
    echo "  (skip: real journal.sh not found — integration test skipped)"
  else
    tmpd=$(make_tmpdir)
    mkdir -p "${tmpd}/journal/pending"

    make_base_handoff "${tmpd}/journal/pending/shapecal.json" "$REAL_JOURNAL" \
      '.telemetry += {shape_reason: "realized 3 file(s), 2 AC, type=fix → shape=standard", realized_file_count: 3, realized_file_count_raw: 6, ac_count: 2, analyze_path: "sonnet", analyze_ineligible_reason: "comments present (2) — body/comment reconciliation requires sonnet analyze"}'

    run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"

    entry=$(ls "${tmpd}/journal"/*.json 2>/dev/null | head -1 || true)
    if [[ -z $entry ]]; then
      fail "integration_shape_calibration_entry_written" "no journal entry created. hook output: ${RUN_OUT}"
    else
      pass "integration_shape_calibration_entry_written"
      if jq -e '.telemetry.shape_reason == "realized 3 file(s), 2 AC, type=fix → shape=standard"
                and .telemetry.realized_file_count == 3
                and .telemetry.realized_file_count_raw == 6
                and .telemetry.ac_count == 2
                and .telemetry.analyze_path == "sonnet"
                and (.telemetry.analyze_ineligible_reason | startswith("comments present"))
                and .telemetry.merge_tier == "REVIEW"' "$entry" >/dev/null 2>&1; then
        pass "integration_shape_calibration_keys_persisted"
      else
        fail "integration_shape_calibration_keys_persisted" "keys missing/altered in entry: $(jq -c '.telemetry' "$entry")"
      fi
    fi

    rm -rf "$tmpd"

    # null の realized_file_count（取得不能）はキー欠落として到達する（passthrough の null 除外）
    tmpd=$(make_tmpdir)
    mkdir -p "${tmpd}/journal/pending"
    make_base_handoff "${tmpd}/journal/pending/shapenull.json" "$REAL_JOURNAL" \
      '.telemetry += {shape_reason: "realized file count missing or invalid → safe floor=complex", realized_file_count: null, realized_file_count_raw: null, ac_count: 2, analyze_path: "contract"}'
    run_hook "CLAUDE_JOURNAL_DIR=${tmpd}/journal" "HOME=${tmpd}"
    entry=$(ls "${tmpd}/journal"/*.json 2>/dev/null | head -1 || true)
    if [[ -n $entry ]] && jq -e '(.telemetry | has("realized_file_count") | not)
                                 and (.telemetry | has("realized_file_count_raw") | not)
                                 and .telemetry.shape_reason == "realized file count missing or invalid → safe floor=complex"
                                 and .telemetry.analyze_path == "contract"
                                 and (.telemetry | has("analyze_ineligible_reason") | not)' "$entry" >/dev/null 2>&1; then
      pass "integration_shape_calibration_null_dropped"
    else
      fail "integration_shape_calibration_null_dropped" "expected realized_file_count absent / analyze_path=contract. entry: $(jq -c '.telemetry' "$entry" 2>/dev/null)"
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
