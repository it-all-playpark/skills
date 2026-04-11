#!/usr/bin/env bash
# subagent-dispatch-lint.sh
# Issue #42 の受け入れ条件を検証する lint test。
#
# 検証項目:
#   1. docs/skill-creation-guide.md に "Subagent Dispatch Rules" セクションと必須5要素が含まれる
#   2. docs/skill-creation-guide.md に routing rule table が含まれる
#   3. _shared/references/subagent-dispatch.md が存在し必須5要素と routing table を含む
#   4. 実地移行テスト対象（bug-hunt）の SKILL.md に Subagent Dispatch Rules セクションが含まれる

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail_count=0
pass_count=0

pass() { echo "  PASS: $1"; pass_count=$((pass_count + 1)); }
fail() { echo "  FAIL: $1"; fail_count=$((fail_count + 1)); }

check_file_contains() {
    local file="$1"
    local pattern="$2"
    local description="$3"
    if [[ ! -f "$file" ]]; then
        fail "$description (file not found: $file)"
        return
    fi
    if grep -q -- "$pattern" "$file"; then
        pass "$description"
    else
        fail "$description (pattern not found: $pattern)"
    fi
}

echo "=== Subagent Dispatch Lint (Issue #42) ==="

# 1. docs/skill-creation-guide.md
GUIDE="$REPO_ROOT/docs/skill-creation-guide.md"
echo ""
echo "[1] docs/skill-creation-guide.md の必須要素"
check_file_contains "$GUIDE" "Subagent Dispatch Rules" "Subagent Dispatch Rules セクション存在"
check_file_contains "$GUIDE" "Objective" "必須要素: Objective"
check_file_contains "$GUIDE" "Output format" "必須要素: Output format"
check_file_contains "$GUIDE" "Tools" "必須要素: Tools"
check_file_contains "$GUIDE" "Boundary" "必須要素: Boundary"
check_file_contains "$GUIDE" "Token cap" "必須要素: Token cap"
check_file_contains "$GUIDE" "Routing Rule Table" "Routing Rule Table セクション存在"
check_file_contains "$GUIDE" "general-purpose" "routing table: general-purpose"
check_file_contains "$GUIDE" "code-reviewer" "routing table: code-reviewer"

# 2. _shared/references/subagent-dispatch.md
REF="$REPO_ROOT/_shared/references/subagent-dispatch.md"
echo ""
echo "[2] _shared/references/subagent-dispatch.md の必須要素"
check_file_contains "$REF" "必須5要素" "必須5要素セクション存在"
check_file_contains "$REF" "Objective" "Objective 記載"
check_file_contains "$REF" "Output format" "Output format 記載"
check_file_contains "$REF" "Tools" "Tools 記載"
check_file_contains "$REF" "Boundary" "Boundary 記載"
check_file_contains "$REF" "Token cap" "Token cap 記載"
check_file_contains "$REF" "Routing Rules" "Routing Rules セクション存在"
check_file_contains "$REF" "チェックリスト" "チェックリスト存在"

# 3. 実地移行テスト: bug-hunt
BUG_HUNT="$REPO_ROOT/bug-hunt/SKILL.md"
echo ""
echo "[3] 実地移行テスト (bug-hunt/SKILL.md)"
check_file_contains "$BUG_HUNT" "Subagent Dispatch Rules" "Subagent Dispatch Rules セクション存在"
check_file_contains "$BUG_HUNT" "subagent-dispatch.md" "reference link 存在"

# Summary
echo ""
echo "=== Result ==="
echo "PASS: $pass_count"
echo "FAIL: $fail_count"

if [[ $fail_count -gt 0 ]]; then
    exit 1
fi
exit 0
