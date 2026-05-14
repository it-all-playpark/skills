#!/usr/bin/env bash
# AC1: flow.schema.json が v1/v2 dual-support を満たすことを検証
# 検査対象:
#   - properties.version が ["1.0.0", "2.0.0"] enum
#   - top-level if/then ブロック存在
#   - then 内で subtasks[].branch が required
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA="$REPO_ROOT/_lib/schemas/flow.schema.json"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

# Case 1: schema accepts both versions in enum
ENUM=$(jq -c '.properties.version.enum // null' "$SCHEMA")
[[ "$ENUM" == '["1.0.0","2.0.0"]' ]] \
    || fail "Case 1: version enum should be [\"1.0.0\",\"2.0.0\"], got: $ENUM"
pass "Case 1: version enum is [1.0.0, 2.0.0]"

# Case 2: top-level if/then exists
HAS_IF=$(jq -r 'has("if") and has("then")' "$SCHEMA")
[[ "$HAS_IF" == "true" ]] || fail "Case 2: top-level if/then block missing"
pass "Case 2: schema has top-level if/then"

# Case 3: if-condition references version 2.0.0
IF_VERSION=$(jq -r '.if.properties.version.const // ""' "$SCHEMA")
[[ "$IF_VERSION" == "2.0.0" ]] \
    || fail "Case 3: if.properties.version.const should be \"2.0.0\", got: $IF_VERSION"
pass "Case 3: if condition references version 2.0.0"

# Case 4: then block adds branch to required via allOf
THEN_ALLOF=$(jq -c '.then.properties.subtasks.items.allOf // null' "$SCHEMA")
echo "$THEN_ALLOF" | grep -q '"branch"' \
    || fail "Case 4: then.properties.subtasks.items.allOf should include {required:[\"branch\"]}, got: $THEN_ALLOF"
pass "Case 4: then block requires branch via allOf"

# Case 5: $defs/subtask.required does NOT include branch (v1 backwards-compat)
SUBTASK_REQUIRED=$(jq -c '."$defs".subtask.required // null' "$SCHEMA")
echo "$SUBTASK_REQUIRED" | grep -q '"branch"' \
    && fail "Case 5: \$defs/subtask.required must NOT include branch (would break v1), got: $SUBTASK_REQUIRED"
pass "Case 5: \$defs/subtask.required stays v1 compatible (branch optional)"

echo "OK: tests/flow-schema-v2-validate.sh"
