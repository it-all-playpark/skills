#!/usr/bin/env bash
# AC1-AC5 (v2 / issue #93): dev-integrate v2 は merge worker を spawn しない。
# child PR は dev-flow の auto-merge-child.sh が integration branch に直接 merge する。
# dev-integrate は最終 verify (verify-children-merged.sh + type check + dev-validate) のみ。
#
# 検査対象: dev-integrate/SKILL.md および dev-integrate/references/ 配下
#   - merge worker dispatch / Kahn 法 / merge-subtasks.sh が記述されていない
#   - verify-children-merged.sh が呼ばれている
#   - integration branch (integration/issue-*) が文書化されている
#   - dev-validate を最終 validation として呼んでいる
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_MD="$REPO_ROOT/dev-integrate/SKILL.md"
REFS_DIR="$REPO_ROOT/dev-integrate/references"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

search_union() {
    local pattern="$1"
    grep -qE "$pattern" "$SKILL_MD" "$REFS_DIR"/*.md 2>/dev/null
}

# Case 1: SKILL.md exists
[[ -f "$SKILL_MD" ]] || fail "Case 1: $SKILL_MD not found"
pass "Case 1: dev-integrate/SKILL.md exists"

# Case 2: legacy v1 merge worker dispatch must NOT be invoked.
# 「No Kahn-sort topological merge」「previous v1 design (Kahn's algorithm) ... has been removed」
# のような **撤廃を明記する文脈** は許容する (no / removed / 撤廃 / previous / 廃止 /
# no longer / deleted / 削除 が同一行に出現する場合)。それ以外で legacy mechanism を
# 呼んでいたら fail。
check_no_legacy_invocation() {
    local pattern="$1"
    local matches
    matches=$(grep -nE "$pattern" "$SKILL_MD" 2>/dev/null || true)
    [[ -z "$matches" ]] && return 0
    while IFS= read -r line; do
        # Strip leading line number prefix
        local content="${line#*:}"
        if echo "$content" | grep -qiE 'no |removed|撤廃|previous|廃止|no longer|deleted|削除|--no-|廃案'; then
            continue
        fi
        echo "Offending: $line" >&2
        return 1
    done <<< "$matches"
    return 0
}

LEGACY_PATTERNS=(
    'subagent_type:[[:space:]]*"dev-kickoff-worker".*mode:[[:space:]]*"?merge"?'
    'merge-subtasks\.sh'
    'Kahn'
    'topological[[:space:]]+merge'
    'check-unacked-findings'
)
for p in "${LEGACY_PATTERNS[@]}"; do
    check_no_legacy_invocation "$p" \
        || fail "Case 2: SKILL.md must NOT invoke legacy v1 mechanism (pattern: $p) — only document its removal"
done
pass "Case 2: SKILL.md does not invoke legacy v1 mechanisms (documentation of removal allowed)"

# Case 3: verify-children-merged.sh is referenced
search_union 'verify-children-merged(\.sh)?' \
    || fail "Case 3: SKILL.md/references must reference verify-children-merged.sh"
pass "Case 3: verify-children-merged.sh referenced"

# Case 4: integration branch (integration/issue-*) is documented
search_union 'integration/issue-' \
    || fail "Case 4: SKILL.md/references must document integration/issue-* branch pattern"
pass "Case 4: integration branch pattern documented"

# Case 5: dev-validate is invoked as final validation
search_union 'dev-validate' \
    || fail "Case 5: SKILL.md/references must invoke dev-validate as final validation"
pass "Case 5: dev-validate invoked as final validation"

# Case 6: child-split mode context is documented
search_union 'child-split|child[[:space:]]+PR|child issue' \
    || fail "Case 6: SKILL.md/references must mention child-split / child PR / child issue context"
pass "Case 6: child-split context documented"

echo "OK: tests/dev-integrate-worker-dispatch.sh"
