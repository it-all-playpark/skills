#!/usr/bin/env bash
# test-integration-docs-cross-link.sh - Verify dev-kickoff/dev-flow references link to baseline-comparison.md (AC6)
# Run: ./dev-flow-doctor/tests/test-integration-docs-cross-link.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOC_DK="$REPO_ROOT/dev-kickoff/references/error-handling.md"
DOC_DF="$REPO_ROOT/dev-flow/references/workflow-detail.md"
DOC_TARGET="$REPO_ROOT/dev-flow-doctor/references/baseline-comparison.md"

FAIL_COUNT=0
PASS_COUNT=0

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

printf 'Test suite: integration docs cross-link (AC6)\n\n'

# ----------------------------------------------------------------------------
# Test 0: target doc exists
# ----------------------------------------------------------------------------
printf 'Test 0: dev-flow-doctor/references/baseline-comparison.md exists\n'
if [[ -f "$DOC_TARGET" ]]; then pass "baseline-comparison.md exists"; else fail "baseline-comparison.md exists at $DOC_TARGET"; fi

# ----------------------------------------------------------------------------
# Test 1: dev-kickoff/references/error-handling.md links to baseline-comparison.md
# ----------------------------------------------------------------------------
printf '\nTest 1: dev-kickoff/references/error-handling.md links to baseline-comparison.md\n'
if [[ -f "$DOC_DK" ]] && grep -qE 'baseline-comparison\.md' "$DOC_DK" 2>/dev/null; then
  pass "dev-kickoff error-handling.md links to baseline-comparison.md"
else
  fail "dev-kickoff error-handling.md links to baseline-comparison.md"
fi

# ----------------------------------------------------------------------------
# Test 2: dev-flow/references/workflow-detail.md links to baseline-comparison.md
# ----------------------------------------------------------------------------
printf '\nTest 2: dev-flow/references/workflow-detail.md links to baseline-comparison.md\n'
if [[ -f "$DOC_DF" ]] && grep -qE 'baseline-comparison\.md' "$DOC_DF" 2>/dev/null; then
  pass "dev-flow workflow-detail.md links to baseline-comparison.md"
else
  fail "dev-flow workflow-detail.md links to baseline-comparison.md"
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
printf '\n=== Summary ===\nPASS: %d\nFAIL: %d\n' "$PASS_COUNT" "$FAIL_COUNT"
if [[ "$FAIL_COUNT" -gt 0 ]]; then exit 1; else exit 0; fi
