#!/usr/bin/env bash
# test-adversarial-opener.sh - Verify dev-evaluate/SKILL.md opens with an
# adversarial framing paragraph that forces independent verification of
# the implementer's self-report (issue #92, AC4).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILL_MD="$REPO_ROOT/dev-evaluate/SKILL.md"

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
  if [[ ! -f "$SKILL_MD" ]]; then
    fail "$label" "file missing: $SKILL_MD"
    return
  fi
  if grep -F -q -- "$needle" "$SKILL_MD"; then
    pass "$label"
  else
    fail "$label" "expected '$needle' in dev-evaluate/SKILL.md"
  fi
}

assert_first_n_lines_contain() {
  local label="$1" n="$2" needle="$3"
  if [[ ! -f "$SKILL_MD" ]]; then
    fail "$label" "file missing"
    return
  fi
  if head -n "$n" "$SKILL_MD" | grep -F -q -- "$needle"; then
    pass "$label"
  else
    fail "$label" "expected '$needle' in first $n lines"
  fi
}

printf 'Test suite: dev-evaluate adversarial opener (AC4)\n\n'

# ----------------------------------------------------------------------------
# Canonical adversarial-framing phrases must appear
# ----------------------------------------------------------------------------
assert_contains "Contains 'finished suspiciously quickly'"      "finished suspiciously quickly"
assert_contains "Contains 'verify everything independently'"    "verify everything independently"

# Must appear EARLY (before Step 1 / Workflow body)
assert_first_n_lines_contain "Opener appears in first 60 lines (suspiciously)" 60 "suspiciously quickly"
assert_first_n_lines_contain "Opener appears in first 60 lines (verify)"       60 "verify everything independently"

# Section heading for the opener
if grep -E -q '^##[[:space:]]+Adversarial[[:space:]]+(Opener|Framing|Stance)' "$SKILL_MD"; then
  pass "Has dedicated 'Adversarial Opener/Framing/Stance' section"
else
  fail "Has dedicated 'Adversarial Opener/Framing/Stance' section" \
    "expected heading like '## Adversarial Opener'"
fi

# ----------------------------------------------------------------------------
# Concerns / focus_areas handling described
# ----------------------------------------------------------------------------
assert_contains "Documents focus_areas input from concerns[]" "focus_areas"
assert_contains "Documents DONE_WITH_CONCERNS handling"       "DONE_WITH_CONCERNS"
assert_contains "Documents legacy_mapped focus-area skip"     "legacy_mapped"

# ----------------------------------------------------------------------------
printf '\n  %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
exit $(( FAIL_COUNT > 0 ? 1 : 0 ))
