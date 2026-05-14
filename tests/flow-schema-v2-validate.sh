#!/usr/bin/env bash
# AC1: flow.schema.json が v2 仕様を満たすことを検証
# 検査対象:
#   - properties.version が const "2.0.0"
#   - $defs/subtask.required に branch が含まれる
#   - $defs/subtask.properties.branch.minLength == 1
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA="$REPO_ROOT/_lib/schemas/flow.schema.json"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

# Case 1: version is const "2.0.0"
VERSION_CONST=$(jq -r '.properties.version.const // ""' "$SCHEMA")
[[ "$VERSION_CONST" == "2.0.0" ]] \
    || fail "Case 1: version.const should be \"2.0.0\", got: $VERSION_CONST"
pass "Case 1: version is const 2.0.0"

# Case 2: $defs/subtask.required includes "branch"
SUBTASK_REQUIRED=$(jq -c '."$defs".subtask.required // null' "$SCHEMA")
echo "$SUBTASK_REQUIRED" | grep -q '"branch"' \
    || fail "Case 2: \$defs/subtask.required must include \"branch\", got: $SUBTASK_REQUIRED"
pass "Case 2: \$defs/subtask.required includes branch"

# Case 3: branch property has minLength: 1
BRANCH_MIN=$(jq -r '."$defs".subtask.properties.branch.minLength // 0' "$SCHEMA")
[[ "$BRANCH_MIN" == "1" ]] \
    || fail "Case 3: branch.minLength should be 1, got: $BRANCH_MIN"
pass "Case 3: branch.minLength is 1"

echo "OK: tests/flow-schema-v2-validate.sh"
