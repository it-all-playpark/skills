#!/usr/bin/env bash
# AC1: flow.schema.json v2 (issue #93 child-split mode) を検証
# 検査対象:
#   - properties.version が const "2.0.0"
#   - top-level required に integration_branch / children / batches を含む
#   - $defs/child.required に issue / slug / scope / status を含む
#   - $defs/batch.required に mode / issues を含む
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

# Case 2: top-level required includes integration_branch / children / batches
TOP_REQUIRED=$(jq -c '.required // []' "$SCHEMA")
for f in integration_branch children batches; do
  echo "$TOP_REQUIRED" | grep -q "\"$f\"" \
      || fail "Case 2: top-level .required must include \"$f\", got: $TOP_REQUIRED"
done
pass "Case 2: top-level required includes integration_branch / children / batches"

# Case 3: v2 must NOT have legacy subtasks / contract / shared_findings in required
LEGACY_FIELDS=("subtasks" "contract" "shared_findings")
for f in "${LEGACY_FIELDS[@]}"; do
  if echo "$TOP_REQUIRED" | grep -q "\"$f\""; then
    fail "Case 3: v2 schema must NOT require legacy field \"$f\""
  fi
done
pass "Case 3: legacy fields (subtasks/contract/shared_findings) not in v2 required"

# Case 4: $defs/child.required includes issue / slug / scope / status
CHILD_REQUIRED=$(jq -c '."$defs".child.required // []' "$SCHEMA")
for f in issue slug scope status; do
  echo "$CHILD_REQUIRED" | grep -q "\"$f\"" \
      || fail "Case 4: \$defs/child.required must include \"$f\", got: $CHILD_REQUIRED"
done
pass "Case 4: \$defs/child.required includes issue/slug/scope/status"

# Case 5: $defs/batch.required includes batch / mode / children
BATCH_REQUIRED=$(jq -c '."$defs".batch.required // []' "$SCHEMA")
for f in batch mode children; do
  echo "$BATCH_REQUIRED" | grep -q "\"$f\"" \
      || fail "Case 5: \$defs/batch.required must include \"$f\", got: $BATCH_REQUIRED"
done
pass "Case 5: \$defs/batch.required includes batch/mode/children"

# Case 6: $defs/batch.properties.mode.enum is exactly [serial, parallel]
BATCH_MODES=$(jq -c '."$defs".batch.properties.mode.enum // []' "$SCHEMA")
[[ "$BATCH_MODES" == '["serial","parallel"]' ]] \
    || fail "Case 6: batch.mode.enum should be [serial, parallel], got: $BATCH_MODES"
pass "Case 6: batch.mode.enum is [serial, parallel]"

echo "OK: tests/flow-schema-v2-validate.sh"
