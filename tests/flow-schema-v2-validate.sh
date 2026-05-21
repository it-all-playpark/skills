#!/usr/bin/env bash
# AC1: flow.schema.json v2.1 (issue #108 child-split mode + phases[]) を検証
# 検査対象:
#   - properties.version が const "2.1.0"
#   - top-level required に integration_branch / children / batches / phases を含む
#   - $defs/child.required に issue / slug / scope / status を含む
#   - $defs/batch.required に batch / mode / children を含む
#   - $defs/batch.properties.mode.enum が [serial, parallel]
#   - $defs/phase.additionalProperties == false + required に name/status/attempts
#   - $defs/phase.properties.name.enum が 5 値固定
#   - top-level required に phases + properties.phases.minItems == maxItems == 5
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA="$REPO_ROOT/_lib/schemas/flow.schema.json"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

# Case 1: version is const "2.1.0"
VERSION_CONST=$(jq -r '.properties.version.const // ""' "$SCHEMA")
[[ "$VERSION_CONST" == "2.1.0" ]] \
    || fail "Case 1: version.const should be \"2.1.0\", got: $VERSION_CONST"
pass "Case 1: version is const 2.1.0"

# Case 2: top-level required includes integration_branch / children / batches / phases
TOP_REQUIRED=$(jq -c '.required // []' "$SCHEMA")
for f in integration_branch children batches phases; do
  echo "$TOP_REQUIRED" | grep -q "\"$f\"" \
      || fail "Case 2: top-level .required must include \"$f\", got: $TOP_REQUIRED"
done
pass "Case 2: top-level required includes integration_branch / children / batches / phases"

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

# Case 7 (NEW, issue #108): phase has additionalProperties:false + required [name, status, attempts]
# jq quirk: `false // "missing"` evaluates to "missing" because jq treats false as falsy.
# Use `if has("additionalProperties") then .additionalProperties else "missing" end`
PHASE_ADDPROP=$(jq -r '."$defs".phase | if has("additionalProperties") then .additionalProperties|tostring else "missing" end' "$SCHEMA")
[[ "$PHASE_ADDPROP" == "false" ]] \
    || fail "Case 7: phase.additionalProperties must be false, got: $PHASE_ADDPROP"
PHASE_REQUIRED=$(jq -c '."$defs".phase.required // []' "$SCHEMA")
for f in name status attempts; do
  echo "$PHASE_REQUIRED" | grep -q "\"$f\"" \
      || fail "Case 7: phase.required must include \"$f\", got: $PHASE_REQUIRED"
done
pass "Case 7: phase.additionalProperties=false + required includes name/status/attempts"

# Case 8 (NEW, issue #108): phase.properties.name.enum exactly 5 fixed values
PHASE_NAME_ENUM=$(jq -c '."$defs".phase.properties.name.enum // []' "$SCHEMA")
EXPECTED='["decompose","batch_loop","integrate","final_pr","pr_iterate"]'
[[ "$PHASE_NAME_ENUM" == "$EXPECTED" ]] \
    || fail "Case 8: phase.name.enum should be $EXPECTED, got: $PHASE_NAME_ENUM"
pass "Case 8: phase.name.enum is fixed 5 values"

# Case 9 (NEW, issue #108): top-level properties.phases.minItems == maxItems == 5
PHASES_MIN=$(jq -r '.properties.phases.minItems // "missing"' "$SCHEMA")
[[ "$PHASES_MIN" == "5" ]] \
    || fail "Case 9: properties.phases.minItems should be 5, got: $PHASES_MIN"
PHASES_MAX=$(jq -r '.properties.phases.maxItems // "missing"' "$SCHEMA")
[[ "$PHASES_MAX" == "5" ]] \
    || fail "Case 9: properties.phases.maxItems should be 5, got: $PHASES_MAX"
pass "Case 9: properties.phases.minItems == maxItems == 5"

echo "OK: tests/flow-schema-v2-validate.sh"
