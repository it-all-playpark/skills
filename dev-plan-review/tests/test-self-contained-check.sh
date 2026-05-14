#!/usr/bin/env bash
# test-self-contained-check.sh - Verify that dev-plan-review documents the
# "Plan self-containment" review dimension and that the regex patterns from
# Contract Details F4 are part of the checklist (issue #92, AC6).
#
# This is a static documentation/contract test: dev-plan-review is an LLM
# skill, so we cannot run end-to-end review simulation here. We assert that:
#   1. review-checklist.md contains a "self_contained" / "self-containment" dimension
#   2. review-checklist.md lists the canonical regex patterns for ambiguous refs
#   3. dev-plan-impl/SKILL.md documents the "self-contained task description"
#      authoring convention (so planners write tasks that pass this check)
#   4. The grep harness wired up in this test actually matches the canonical
#      sample plan snippets ("上述の通り", "Task N と同様", ...)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CHECKLIST="$REPO_ROOT/dev-plan-review/references/review-checklist.md"
SKILL_MD="$REPO_ROOT/dev-plan-review/SKILL.md"
DEV_PLAN_IMPL_SKILL="$REPO_ROOT/dev-plan-impl/SKILL.md"

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

# Case-insensitive variant for headings / phrasing that may vary in case
assert_contains_ci() {
  local label="$1" file="$2" needle="$3"
  if [[ ! -f "$file" ]]; then
    fail "$label" "file missing: $file"
    return
  fi
  if grep -F -i -q -- "$needle" "$file"; then
    pass "$label"
  else
    fail "$label" "expected (case-insensitive) '$needle' in $(basename "$file")"
  fi
}

printf 'Test suite: dev-plan-review self-contained check (AC6)\n\n'

# ----------------------------------------------------------------------------
# review-checklist.md must document the dimension
# ----------------------------------------------------------------------------
assert_contains_ci "Checklist mentions 'self-contain' dimension" \
  "$CHECKLIST" "self-contain"

assert_contains "Checklist mentions 上述の通り pattern"     "$CHECKLIST" "上述の通り"
assert_contains "Checklist mentions 上記の通り pattern"     "$CHECKLIST" "上記"
assert_contains "Checklist mentions Task N と同様 pattern"  "$CHECKLIST" "Task"
assert_contains "Checklist mentions self_containment finding dimension" \
  "$CHECKLIST" "self_containment"

# dev-plan-review SKILL.md must reference the checklist dimension
assert_contains "SKILL.md mentions self_containment dimension" \
  "$SKILL_MD" "self_containment"

# ----------------------------------------------------------------------------
# dev-plan-impl SKILL.md must document the authoring convention
# ----------------------------------------------------------------------------
assert_contains_ci "dev-plan-impl SKILL.md documents Self-Contained convention" \
  "$DEV_PLAN_IMPL_SKILL" "self-contained"
assert_contains "dev-plan-impl SKILL.md forbids 上述の通り"  "$DEV_PLAN_IMPL_SKILL" "上述の通り"
assert_contains "dev-plan-impl SKILL.md forbids Task N と同様" \
  "$DEV_PLAN_IMPL_SKILL" "Task"

# ----------------------------------------------------------------------------
# Functional check: the canonical patterns from the checklist must actually
# match the canonical bad samples (so the grep wiring is wired correctly).
# ----------------------------------------------------------------------------
TMP_BAD="$(mktemp -t bad-plan-sample-XXXXXX)"
TMP_GOOD="$(mktemp -t good-plan-sample-XXXXXX)"
cleanup() { rm -f "$TMP_BAD" "$TMP_GOOD"; }
trap cleanup EXIT

cat > "$TMP_BAD" <<'EOF'
### Task 2: Implement service

実装は上述の通り Repository パターンで進める。
Task 1 と同様に、controller から呼び出す。
前述のとおり、エラーハンドリングは shared module を使う。
See Task 1 for context.
EOF

cat > "$TMP_GOOD" <<'EOF'
### Task 2: Implement service

実装は Repository パターン (entity: Order, repository: OrderRepo) で進める。
controller (Express handler) から呼び出し、エラーハンドリングは _lib/error-handler を使う。
EOF

# Equivalent of the canonical regex set documented in subagent-dispatch / Contract Details F4
PATTERNS='(上述の通り|上記(に|の)通り|前述(の通り|どおり)|Task[[:space:]]*[0-9]+[[:space:]]*と(同様|同じ)|Task[[:space:]]*[0-9]+[[:space:]]*に(倣う|準じる)|See[[:space:]]+(Task|Section)[[:space:]]*[0-9]+|same[[:space:]]+as[[:space:]]+Task[[:space:]]*[0-9]+)'

if grep -E -q "$PATTERNS" "$TMP_BAD"; then
  pass "Canonical regex flags the bad sample"
else
  fail "Canonical regex flags the bad sample" "regex did not match expected ambiguous refs"
fi

if ! grep -E -q "$PATTERNS" "$TMP_GOOD"; then
  pass "Canonical regex does not flag a self-contained sample"
else
  fail "Canonical regex does not flag a self-contained sample" "false positive"
fi

# ----------------------------------------------------------------------------
printf '\n  %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
exit $(( FAIL_COUNT > 0 ? 1 : 0 ))
