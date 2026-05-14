#!/usr/bin/env bash
# test-status-branching.sh - Verify dev-kickoff documentation captures the
# status branching contract for the 4-value status enum returned by
# dev-implement workers (issue #92, AC1b + AC2).
#
# Because dev-kickoff is an LLM-driven orchestrator, we cannot run an
# end-to-end simulation in pure bash. Instead this test asserts that:
#   - dev-kickoff/references/evaluate-retry.md documents the status branching
#     ladder (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT)
#   - dev-kickoff/SKILL.md mentions the four states and the task_body paste
#     contract (so the orchestrator's prompt cannot drift away from the rule)
#   - .claude/agents/dev-kickoff-worker.md declares `task_body` as an Input
#     for parallel mode and removes the explicit "Read impl-plan.md" instruction

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILL_MD="$REPO_ROOT/dev-kickoff/SKILL.md"
EVAL_RETRY_MD="$REPO_ROOT/dev-kickoff/references/evaluate-retry.md"
PHASE_DETAIL_MD="$REPO_ROOT/dev-kickoff/references/phase-detail.md"
WORKER_MD="$REPO_ROOT/.claude/agents/dev-kickoff-worker.md"

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

assert_contains() {
  local label="$1" file="$2" needle="$3"
  if [[ ! -f "$file" ]]; then
    fail "$label" "file missing: $file"
    return
  fi
  if grep -F -q -- "$needle" "$file"; then
    pass "$label"
  else
    fail "$label" "expected '$needle' in $(basename "$file")"
  fi
}

assert_regex() {
  local label="$1" file="$2" pattern="$3"
  if [[ ! -f "$file" ]]; then
    fail "$label" "file missing: $file"
    return
  fi
  if grep -E -q -- "$pattern" "$file"; then
    pass "$label"
  else
    fail "$label" "expected regex '$pattern' in $(basename "$file")"
  fi
}

assert_not_contains() {
  local label="$1" file="$2" needle="$3"
  if [[ ! -f "$file" ]]; then
    fail "$label" "file missing: $file"
    return
  fi
  if grep -F -q -- "$needle" "$file"; then
    fail "$label" "did NOT expect '$needle' but found it in $(basename "$file")"
  else
    pass "$label"
  fi
}

printf 'Test suite: dev-kickoff status branching contract (AC1b + AC2)\n\n'

# ============================================================================
# AC1b: BLOCKED branches denies same-approach retry, resets to Phase 3
# ============================================================================
printf '\n[AC1b] Phase 6 BLOCKED branching\n'

assert_contains "evaluate-retry.md mentions BLOCKED status"          "$EVAL_RETRY_MD" "BLOCKED"
assert_contains "evaluate-retry.md mentions DONE_WITH_CONCERNS"      "$EVAL_RETRY_MD" "DONE_WITH_CONCERNS"
assert_contains "evaluate-retry.md mentions NEEDS_CONTEXT"           "$EVAL_RETRY_MD" "NEEDS_CONTEXT"
assert_contains "evaluate-retry.md mentions DONE (clean status)"     "$EVAL_RETRY_MD" "DONE"
assert_regex    "evaluate-retry.md ties BLOCKED to reset-to 3_plan_impl" \
  "$EVAL_RETRY_MD" 'BLOCKED.*reset-to.*3_plan_impl|reset-to.*3_plan_impl.*BLOCKED'
assert_contains "evaluate-retry.md forbids same-approach retry on BLOCKED" \
  "$EVAL_RETRY_MD" "同アプローチ"
assert_contains "evaluate-retry.md mentions plan-review-feedback.json hand-off" \
  "$EVAL_RETRY_MD" "plan-review-feedback.json"

# ============================================================================
# AC2: task_body verbatim paste + impl-plan.md not Read by worker
# ============================================================================
printf '\n[AC2] task_body paste contract\n'

assert_contains "dev-kickoff SKILL.md mentions task_body"            "$SKILL_MD" "task_body"
assert_regex    "dev-kickoff SKILL.md states 'paste' for task_body"  "$SKILL_MD" 'paste|verbatim'

# worker definition
assert_contains "dev-kickoff-worker.md lists task_body input"        "$WORKER_MD" "task_body"

# worker must NOT instruct Read of impl-plan.md anymore
assert_not_contains "dev-kickoff-worker.md does NOT instruct Reading impl-plan.md whole" \
  "$WORKER_MD" "Read で全部読む"
assert_regex "dev-kickoff-worker.md disallows full impl-plan.md Read" \
  "$WORKER_MD" '(impl-plan\.md.*[Rr]ead.*しない|MUST NOT Read.*impl-plan|DO NOT Read.*impl-plan|do not Read.*impl-plan)'

# phase-detail.md describes paste step (if file exists)
if [[ -f "$PHASE_DETAIL_MD" ]]; then
  assert_contains "phase-detail.md mentions task_body in dispatch" "$PHASE_DETAIL_MD" "task_body"
fi

# ============================================================================
# AC2 (cont.): legacy mapping documentation
# ============================================================================
printf '\n[AC2-legacy] legacy success/fail mapping\n'

assert_contains "evaluate-retry.md mentions legacy_mapped flag"      "$EVAL_RETRY_MD" "legacy_mapped"

# ============================================================================
printf '\n  %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
exit $(( FAIL_COUNT > 0 ? 1 : 0 ))
