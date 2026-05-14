#!/usr/bin/env bash
# AC6: dev-decompose が subtask worktree 作成のために dev-kickoff-worker subagent を
# Agent(isolation: worktree) で dispatch する経路の lint 検証。
#
# 検査対象: dev-decompose/SKILL.md
#   - Step 8 で Agent(subagent_type: "dev-kickoff-worker", isolation: "worktree") を使用
#   - 必須引数 (issue_number / branch_name / base_ref / mode=parallel / task_id) が記述
#   - subtask 用に `git-prepare.sh --suffix task...` を直接呼び出していない
#     (contract worktree 作成での --suffix contract は許可)
#   - flow.json 生成手順で subtask.branch を populate することが文書化されている
#
# Issue #81 で導入。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_MD="$REPO_ROOT/dev-decompose/SKILL.md"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

# Case 1: SKILL.md exists
[[ -f "$SKILL_MD" ]] || fail "Case 1: $SKILL_MD not found"
pass "Case 1: dev-decompose/SKILL.md exists"

# Case 2: Agent(subagent_type: "dev-kickoff-worker") is referenced
grep -qE 'subagent_type:[[:space:]]*"dev-kickoff-worker"' "$SKILL_MD" \
    || fail "Case 2: dev-decompose/SKILL.md must reference subagent_type: \"dev-kickoff-worker\""
pass "Case 2: SKILL.md references dev-kickoff-worker subagent"

# Case 3: isolation: "worktree" is specified for the dispatch
grep -qE 'isolation:[[:space:]]*"worktree"' "$SKILL_MD" \
    || fail "Case 3: dev-decompose/SKILL.md must specify isolation: \"worktree\" for the worker dispatch"
pass "Case 3: SKILL.md specifies isolation: \"worktree\""

# Case 4: required worker prompt fields are documented
# - issue_number, branch_name, base_ref, mode, task_id
for field in issue_number branch_name base_ref mode task_id; do
    grep -qE "^[[:space:]]*${field}:" "$SKILL_MD" \
        || fail "Case 4: SKILL.md must document worker prompt field '${field}:'"
done
pass "Case 4: worker prompt fields (issue_number/branch_name/base_ref/mode/task_id) documented"

# Case 5: subtask worktree must NOT be created via direct git-prepare --suffix task...
# (contract worktree creation via --suffix contract is still allowed)
# Detect actual command invocations only: lines that start with `$SKILLS_DIR` or `bash` invoking
# the git-prepare.sh script with a --suffix task argument. Prohibition descriptions referencing
# the pattern in prose (e.g. "git-prepare.sh --suffix task... is prohibited") are excluded.
if grep -nE '(^|[[:space:]])(\$[A-Z_]+/)?(.*/)?git-prepare\.sh[[:space:]]+[^#]*--suffix[[:space:]]+task[0-9$]' "$SKILL_MD" >/dev/null 2>&1; then
    echo "Offending line(s):" >&2
    grep -nE '(^|[[:space:]])(\$[A-Z_]+/)?(.*/)?git-prepare\.sh[[:space:]]+[^#]*--suffix[[:space:]]+task[0-9$]' "$SKILL_MD" >&2
    fail "Case 5: dev-decompose/SKILL.md must not invoke git-prepare.sh --suffix task... directly for subtasks"
fi
pass "Case 5: no direct git-prepare.sh --suffix task... invocation (worker dispatch required)"

# Case 6: Step 9 documents that subtask.branch is populated
# Look for a 'branch' field mention close to flow.json subtask population.
grep -qE '(subtask\.branch|"branch":|branch\b.*required.*flow\.json|populate.*branch)' "$SKILL_MD" \
    || fail "Case 6: SKILL.md Step 9 must document that subtask.branch is populated in flow.json"
pass "Case 6: Step 9 documents subtask.branch population"

# Case 7: Subagent Dispatch Rules section is present (required by subagent-dispatch-lint
# because the SKILL.md uses Agent( / subagent_type)
grep -qE '^## Subagent Dispatch Rules' "$SKILL_MD" \
    || fail "Case 7: SKILL.md must include '## Subagent Dispatch Rules' section"
pass "Case 7: Subagent Dispatch Rules section present"

# Case 8: required 5 elements present (Objective / Output format / Tools / Boundary / Token cap)
for elem in "Objective" "Output format" "Tools" "Boundary" "Token cap"; do
    grep -q -- "$elem" "$SKILL_MD" \
        || fail "Case 8: required element '$elem' missing from SKILL.md"
done
pass "Case 8: required 5 elements present in dispatch documentation"

echo "OK: tests/dev-decompose-worker-dispatch.sh"
