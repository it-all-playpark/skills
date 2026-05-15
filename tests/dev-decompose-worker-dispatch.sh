#!/usr/bin/env bash
# AC6 (v2 / issue #93): dev-decompose は **child-split mode** で child issue を発行する。
# v1 で行っていた subtask 用 worktree dispatch (dev-kickoff-worker mode: parallel) は
# 撤廃済み。本テストは:
#   - SKILL.md が child-split mode を文書化していること
#   - parent issue から child issue を作成する経路が記述されていること
#   - integration branch + flow.json (v2 batch 配列) の生成が記述されていること
#   - 旧 v1 機構 (`dev-contract-worker` / Kahn 法 / mode: parallel) を呼び出していない
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_MD="$REPO_ROOT/dev-decompose/SKILL.md"
REFS_DIR="$REPO_ROOT/dev-decompose/references"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

# union: SKILL.md + 配下 references/*.md
search_union() {
    local pattern="$1"
    grep -qE "$pattern" "$SKILL_MD" "$REFS_DIR"/*.md 2>/dev/null
}

# Case 1: SKILL.md exists
[[ -f "$SKILL_MD" ]] || fail "Case 1: $SKILL_MD not found"
pass "Case 1: dev-decompose/SKILL.md exists"

# Case 2: child-split mode is documented
search_union 'child-split|--child-split|child issue' \
    || fail "Case 2: SKILL.md/references must document child-split mode"
pass "Case 2: child-split mode documented"

# Case 3: integration branch concept is documented
search_union 'integration[/_-]branch|integration/issue-' \
    || fail "Case 3: SKILL.md/references must document integration branch"
pass "Case 3: integration branch documented"

# Case 4: v2 flow.json with batches[] is documented
search_union 'batches?\[?\]?|batch[[:space:]]+配列|flow\.json.*v2|version.*2\.0\.0' \
    || fail "Case 4: SKILL.md/references must document v2 flow.json (batches array)"
pass "Case 4: v2 flow.json with batches array documented"

# Case 5: legacy v1 機構 (mode: parallel / contract-worker / Kahn 法) は呼ばれていない
LEGACY_PATTERNS=(
    'dev-contract-worker'
    'mode:[[:space:]]*"?parallel"?'
    'Kahn'
    'topological[[:space:]]+merge'
    'merge-subtasks\.sh'
)
for p in "${LEGACY_PATTERNS[@]}"; do
    if grep -qE "$p" "$SKILL_MD" 2>/dev/null; then
        fail "Case 5: SKILL.md must NOT reference legacy v1 mechanism: $p"
    fi
done
pass "Case 5: SKILL.md does not invoke legacy v1 mechanisms"

# Case 6 (issue #93): dev-decompose は v2 で gh issue create による child issue 発行のみを行い、
# 自身は Agent / Task subagent を spawn しない。よって SKILL.md に
# "Subagent Dispatch Rules" セクションが無いことが期待される。
if grep -qE '^## Subagent Dispatch Rules' "$SKILL_MD"; then
    fail "Case 6: SKILL.md must NOT include 'Subagent Dispatch Rules' (v2 dev-decompose は worker dispatch せず gh issue create のみ)"
fi
pass "Case 6: dev-decompose does not declare Subagent Dispatch Rules (v2 expected)"

echo "OK: tests/dev-decompose-worker-dispatch.sh"
