#!/usr/bin/env bash
# AC6: dev-decompose が subtask worktree 作成のために dev-kickoff-worker subagent を
# Agent(isolation: worktree) で dispatch する経路の lint 検証。
#
# 検査対象: dev-decompose/SKILL.md および dev-decompose/references/ 配下
#   - Step 8 で Agent(subagent_type: "dev-kickoff-worker", isolation: "worktree") を使用
#   - 必須引数 (issue_number / branch_name / base_ref / mode=parallel / task_id) が記述
#   - subtask 用に `git-prepare.sh --suffix task...` を直接呼び出していない
#     (contract worktree 作成での --suffix contract は許可)
#   - flow.json 生成手順で subtask.branch を populate することが文書化されている
#
# SKILL.md は progressive disclosure 方針で worker dispatch 詳細を references/ に分離するため、
# Case 2/3/4/6/8 は SKILL.md + references/ の union を検査する。Case 5/7 は SKILL.md 本体のみ。
#
# Issue #81 で導入。
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

# Case 2: Agent(subagent_type: "dev-kickoff-worker") is referenced (SKILL.md or references)
search_union 'subagent_type:[[:space:]]*"dev-kickoff-worker"' \
    || fail "Case 2: SKILL.md or references must reference subagent_type: \"dev-kickoff-worker\""
pass "Case 2: SKILL.md/references reference dev-kickoff-worker subagent"

# Case 3: isolation: "worktree" is specified for the dispatch (SKILL.md or references)
search_union 'isolation:[[:space:]]*"worktree"' \
    || fail "Case 3: SKILL.md or references must specify isolation: \"worktree\" for the worker dispatch"
pass "Case 3: SKILL.md/references specify isolation: \"worktree\""

# Case 4: required worker prompt fields are documented (SKILL.md or references)
for field in issue_number branch_name base_ref mode task_id; do
    search_union "^[[:space:]]*${field}:" \
        || fail "Case 4: SKILL.md or references must document worker prompt field '${field}:'"
done
pass "Case 4: worker prompt fields (issue_number/branch_name/base_ref/mode/task_id) documented"

# Case 5: subtask worktree must NOT be created via direct git-prepare --suffix task...
# (SKILL.md 本体のみチェック。references の散文記述で禁止理由を述べるのは許容)
if grep -nE '(^|[[:space:]])(\$[A-Z_]+/)?(.*/)?git-prepare\.sh[[:space:]]+[^#]*--suffix[[:space:]]+task[0-9$]' "$SKILL_MD" >/dev/null 2>&1; then
    echo "Offending line(s):" >&2
    grep -nE '(^|[[:space:]])(\$[A-Z_]+/)?(.*/)?git-prepare\.sh[[:space:]]+[^#]*--suffix[[:space:]]+task[0-9$]' "$SKILL_MD" >&2
    fail "Case 5: dev-decompose/SKILL.md must not invoke git-prepare.sh --suffix task... directly for subtasks"
fi
pass "Case 5: no direct git-prepare.sh --suffix task... invocation (worker dispatch required)"

# Case 6: Step 9 documents that subtask.branch is populated (SKILL.md or references)
search_union '(subtask\.branch|"branch":|branch\b.*required.*flow\.json|populate.*branch|populated from worker)' \
    || fail "Case 6: SKILL.md/references Step 9 must document that subtask.branch is populated in flow.json"
pass "Case 6: Step 9 documents subtask.branch population"

# Case 7: Subagent Dispatch Rules section is present in SKILL.md
# (subagent-dispatch-lint requires the section to exist in SKILL.md because Agent( is mentioned there)
grep -qE '^## Subagent Dispatch Rules' "$SKILL_MD" \
    || fail "Case 7: SKILL.md must include '## Subagent Dispatch Rules' section"
pass "Case 7: Subagent Dispatch Rules section present in SKILL.md"

# Case 8: required 5 elements present (SKILL.md or references)
for elem in "Objective" "Output format" "Tools" "Boundary" "Token cap"; do
    search_union "$elem" \
        || fail "Case 8: required element '$elem' missing from SKILL.md/references"
done
pass "Case 8: required 5 elements present in dispatch documentation"

echo "OK: tests/dev-decompose-worker-dispatch.sh"
