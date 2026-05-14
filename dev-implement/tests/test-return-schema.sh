#!/usr/bin/env bash
# test-return-schema.sh - Verify dev-implement SKILL.md documents the 4-value
# status enum (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT) and the
# associated optional fields (concerns / blocking_reason / missing_context).
#
# This is a documentation/contract test — dev-implement does not execute as a
# bash script. We assert that the SKILL.md (and the Return Contract reference)
# contain the canonical wording so a worker LLM has a single source of truth.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILL_MD="$REPO_ROOT/dev-implement/SKILL.md"
RETURN_CONTRACT="$REPO_ROOT/dev-implement/references/return-contract.md"

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
    fail "$label" "expected to find '$needle' in $file"
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
    fail "$label" "expected regex '$pattern' in $file"
  fi
}

printf 'Test suite: dev-implement return schema contract\n\n'

# ----------------------------------------------------------------------------
# AC1a: 4-value status enum is documented in SKILL.md
# ----------------------------------------------------------------------------
assert_contains "SKILL.md mentions DONE status"               "$SKILL_MD" "DONE"
assert_contains "SKILL.md mentions DONE_WITH_CONCERNS status" "$SKILL_MD" "DONE_WITH_CONCERNS"
assert_contains "SKILL.md mentions BLOCKED status"            "$SKILL_MD" "BLOCKED"
assert_contains "SKILL.md mentions NEEDS_CONTEXT status"      "$SKILL_MD" "NEEDS_CONTEXT"

# ----------------------------------------------------------------------------
# Return Contract reference must exist with field-level spec
# ----------------------------------------------------------------------------
if [[ ! -f "$RETURN_CONTRACT" ]]; then
  fail "Return Contract reference exists" "missing: $RETURN_CONTRACT"
else
  pass "Return Contract reference exists"

  assert_contains "Return Contract: concerns[] required for DONE_WITH_CONCERNS" \
    "$RETURN_CONTRACT" "concerns"
  assert_contains "Return Contract: blocking_reason required for BLOCKED" \
    "$RETURN_CONTRACT" "blocking_reason"
  assert_contains "Return Contract: missing_context[] for NEEDS_CONTEXT" \
    "$RETURN_CONTRACT" "missing_context"
fi

# ----------------------------------------------------------------------------
# SKILL.md must reference the new "Return Contract" section name
# ----------------------------------------------------------------------------
assert_regex "SKILL.md has a 'Return Contract' header" \
  "$SKILL_MD" '^#{2,3}\s+Return Contract'

# ----------------------------------------------------------------------------
# SKILL.md must explicitly state task_body takes precedence over impl-plan.md
# ----------------------------------------------------------------------------
assert_contains "SKILL.md: task_body input documented" \
  "$SKILL_MD" "task_body"
assert_regex "SKILL.md: impl-plan.md only as fallback" \
  "$SKILL_MD" '(standalone|fallback).*impl-plan\.md|impl-plan\.md.*(standalone|fallback)'

# ----------------------------------------------------------------------------
printf '\n  %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
exit $(( FAIL_COUNT > 0 ? 1 : 0 ))
