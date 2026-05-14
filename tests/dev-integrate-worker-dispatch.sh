#!/usr/bin/env bash
# AC1-AC5: dev-integrate が merge worktree 作成のために dev-kickoff-worker subagent を
# Agent(isolation: worktree, mode: merge) で dispatch する経路の lint 検証。
#
# 検査対象: dev-integrate/SKILL.md および dev-integrate/references/ 配下
#   - Step 4 で Agent(subagent_type: "dev-kickoff-worker", isolation: "worktree") を使用
#   - 必須 prompt 引数 (issue_number / branch_name / base_ref / mode=merge / flow_state) が記述
#   - merge worktree 作成で `git-prepare.sh --suffix merge` を直接呼び出していない
#   - integration 結果 (merge_results / conflicts) が flow.json.integration に転記されることが文書化
#   - merge-retry も worker 再 spawn (branch_name=...-merge-retry) で再現可能と文書化
#
# SKILL.md は progressive disclosure 方針で worker dispatch 詳細を references/ に分離するため、
# Case 2/3/4/8/9 は SKILL.md + references/ の union を検査する。Case 5/6/7 は SKILL.md 本体のみ。
#
# Issue #82 で導入 (dev-decompose-worker-dispatch.sh と対称設計)。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_MD="$REPO_ROOT/dev-integrate/SKILL.md"
REFS_DIR="$REPO_ROOT/dev-integrate/references"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

# union: SKILL.md + 配下 references/*.md
search_union() {
    local pattern="$1"
    grep -qE "$pattern" "$SKILL_MD" "$REFS_DIR"/*.md 2>/dev/null
}

# Case 1: SKILL.md exists
[[ -f "$SKILL_MD" ]] || fail "Case 1: $SKILL_MD not found"
pass "Case 1: dev-integrate/SKILL.md exists"

# Case 2: Agent(subagent_type: "dev-kickoff-worker") is referenced (SKILL.md or references)
search_union 'subagent_type:[[:space:]]*"dev-kickoff-worker"' \
    || fail "Case 2: SKILL.md or references must reference subagent_type: \"dev-kickoff-worker\""
pass "Case 2: SKILL.md/references reference dev-kickoff-worker subagent"

# Case 3: isolation: "worktree" is specified for the dispatch (SKILL.md or references)
search_union 'isolation:[[:space:]]*"worktree"' \
    || fail "Case 3: SKILL.md or references must specify isolation: \"worktree\" for the worker dispatch"
pass "Case 3: SKILL.md/references specify isolation: \"worktree\""

# Case 4: required worker prompt fields are documented (SKILL.md or references)
# merge mode は task_id を使わず flow_state を必須とする (single/parallel との差分)
for field in issue_number branch_name base_ref mode flow_state; do
    search_union "^[[:space:]]*${field}:" \
        || fail "Case 4: SKILL.md or references must document worker prompt field '${field}:'"
done
# mode: merge であることが明示されていること
search_union 'mode:[[:space:]]*merge' \
    || fail "Case 4: SKILL.md or references must document 'mode: merge' for the dispatch"
pass "Case 4: worker prompt fields (issue_number/branch_name/base_ref/mode=merge/flow_state) documented"

# Case 5: merge worktree must NOT be created via direct git-prepare --suffix merge...
# (SKILL.md 本体のみチェック。references の散文で禁止理由を述べるのは許容)
if grep -nE '(^|[[:space:]])(\$[A-Z_]+/)?(.*/)?git-prepare\.sh[[:space:]]+[^#]*--suffix[[:space:]]+merge' "$SKILL_MD" >/dev/null 2>&1; then
    echo "Offending line(s):" >&2
    grep -nE '(^|[[:space:]])(\$[A-Z_]+/)?(.*/)?git-prepare\.sh[[:space:]]+[^#]*--suffix[[:space:]]+merge' "$SKILL_MD" >&2
    fail "Case 5: dev-integrate/SKILL.md must not invoke git-prepare.sh --suffix merge... directly for merge worktree"
fi
pass "Case 5: no direct git-prepare.sh --suffix merge... invocation (worker dispatch required)"

# Case 6: Subagent Dispatch Rules section is present in SKILL.md
# (subagent-dispatch-lint requires the section to exist in SKILL.md because Agent( is mentioned there)
grep -qE '^## Subagent Dispatch Rules' "$SKILL_MD" \
    || fail "Case 6: SKILL.md must include '## Subagent Dispatch Rules' section"
pass "Case 6: Subagent Dispatch Rules section present in SKILL.md"

# Case 7: required 5 elements present in SKILL.md (global subagent-dispatch-lint との整合)
for elem in "Objective" "Output format" "Tools" "Boundary" "Token cap"; do
    grep -q -- "$elem" "$SKILL_MD" \
        || fail "Case 7: required element '$elem' missing from SKILL.md (global lint requirement)"
done
pass "Case 7: required 5 elements present in dev-integrate/SKILL.md"

# Case 8: integration result transcription is documented
# worker JSON return (merge_results / conflicts) が flow.json.integration に転記されることが
# SKILL.md か references のどこかに書かれている
search_union 'merge_results' \
    || fail "Case 8: SKILL.md/references must document worker return field 'merge_results'"
search_union 'conflicts' \
    || fail "Case 8: SKILL.md/references must document worker return field 'conflicts'"
search_union '(flow\.json|flow-update|integration[^"]{0,40})' \
    || fail "Case 8: SKILL.md/references must document writing the worker result back to flow.json integration section"
pass "Case 8: integration result transcription documented (merge_results / conflicts → flow.json integration)"

# Case 9: merge-retry pattern documented via worker re-spawn with branch_name: ...-merge-retry
search_union 'merge-retry' \
    || fail "Case 9: SKILL.md/references must document the merge-retry pattern (worker re-spawn)"
pass "Case 9: merge-retry pattern documented via worker re-spawn"

echo "OK: tests/dev-integrate-worker-dispatch.sh"
