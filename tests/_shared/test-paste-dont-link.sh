#!/usr/bin/env bash
# test-paste-dont-link.sh - Verify _shared/references/subagent-dispatch.md
# contains the central definitions for:
#   1. "Paste, Don't Link" rule (do not Read impl-plan.md; paste task_body verbatim)
#   2. 4-value status enum (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT)
#
# This satisfies AC3 of issue #92.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DISPATCH_MD="$REPO_ROOT/_shared/references/subagent-dispatch.md"

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
  local label="$1" needle="$2"
  if [[ ! -f "$DISPATCH_MD" ]]; then
    fail "$label" "file missing: $DISPATCH_MD"
    return
  fi
  if grep -F -q -- "$needle" "$DISPATCH_MD"; then
    pass "$label"
  else
    fail "$label" "expected to find '$needle'"
  fi
}

assert_regex() {
  local label="$1" pattern="$2"
  if grep -E -q -- "$pattern" "$DISPATCH_MD"; then
    pass "$label"
  else
    fail "$label" "expected regex '$pattern'"
  fi
}

printf 'Test suite: _shared/references/subagent-dispatch.md central definitions\n\n'

# ----------------------------------------------------------------------------
# Section presence
# ----------------------------------------------------------------------------
assert_regex "Has 'Paste, Don't Link' section header"      '^##[[:space:]]+Paste,[[:space:]]+Don'
assert_regex "Has '4 値 Status Enum' or similar header"    '^##[[:space:]]+4[[:space:]]*値[[:space:]]*Status[[:space:]]+Enum|^##[[:space:]]+4-Value[[:space:]]+Status[[:space:]]+Enum'

# ----------------------------------------------------------------------------
# Paste, Don't Link key phrases
# ----------------------------------------------------------------------------
assert_contains "Mentions 'task_body' as the verbatim source"        "task_body"
assert_contains "Forbids reading impl-plan.md from worker"            "impl-plan.md"
assert_regex    "Verbatim paste rule stated"                          'verbatim[[:space:]]+paste'
assert_contains "Mentions Read-not 'impl-plan.md 全体を Read しない'" "全体を Read しない"

# ----------------------------------------------------------------------------
# 4-value status enum key phrases
# ----------------------------------------------------------------------------
assert_contains "Documents DONE status"                  "DONE"
assert_contains "Documents DONE_WITH_CONCERNS status"    "DONE_WITH_CONCERNS"
assert_contains "Documents BLOCKED status"               "BLOCKED"
assert_contains "Documents NEEDS_CONTEXT status"         "NEEDS_CONTEXT"
assert_contains "Documents concerns field"               "concerns"
assert_contains "Documents blocking_reason field"        "blocking_reason"
assert_contains "Documents missing_context field"        "missing_context"

# ----------------------------------------------------------------------------
printf '\n  %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
exit $(( FAIL_COUNT > 0 ? 1 : 0 ))
