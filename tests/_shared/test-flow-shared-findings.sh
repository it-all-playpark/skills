#!/usr/bin/env bash
# Integration tests for shared_findings channel (issue #51).
# Exercises flow-append-finding.sh, flow-read-findings.sh, and
# dev-integrate/scripts/check-unacked-findings.sh.
#
# Run: bash tests/_shared/test-flow-shared-findings.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APPEND_SH="$REPO_ROOT/_shared/scripts/flow-append-finding.sh"
READ_SH="$REPO_ROOT/_shared/scripts/flow-read-findings.sh"
CHECK_SH="$REPO_ROOT/dev-integrate/scripts/check-unacked-findings.sh"

command -v jq >/dev/null || { echo "jq required"; exit 1; }

PASS=0
FAIL=0
pass() { PASS=$((PASS+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL: $1"; echo "  $2"; }

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

make_flow() {
    local path="$1"
    cat > "$path" <<'JSON'
{
  "version": "1.0.0",
  "issue": 51,
  "status": "implementing",
  "subtasks": [
    {"id": "task1", "scope": "A", "files": ["a.ts"], "status": "completed", "checklist": [{"item":"x","done":true}]},
    {"id": "task2", "scope": "B", "files": ["b.ts"], "status": "completed", "checklist": [{"item":"x","done":true}]},
    {"id": "task3", "scope": "C", "files": ["c.ts"], "status": "completed", "checklist": [{"item":"x","done":true}]}
  ],
  "shared_findings": [],
  "config": {"strategy": "tdd", "depth": "standard", "lang": "ja", "base_branch": "dev", "env_mode": "hardlink"}
}
JSON
}

# ---------- Test 1: append-basic ----------
T=$TMP_ROOT/t1; mkdir -p "$T"; FLOW=$T/flow.json; make_flow "$FLOW"
OUT=$("$APPEND_SH" --flow-state "$FLOW" --task-id task1 \
    --category breaking_change --title "User 型に email_verified 追加" \
    --description "optional field" --scope "src/types/user.ts" \
    --action-required "consumers must handle optional")
ID=$(echo "$OUT" | jq -r '.finding_id')
if [[ "$ID" == "sf_001" ]] && [[ "$(jq '.shared_findings | length' "$FLOW")" == "1" ]]; then
    pass "append-basic"
else
    fail "append-basic" "got id=$ID, len=$(jq '.shared_findings | length' "$FLOW")"
fi

# ---------- Test 2: append-increments-id ----------
T=$TMP_ROOT/t2; mkdir -p "$T"; FLOW=$T/flow.json; make_flow "$FLOW"
"$APPEND_SH" --flow-state "$FLOW" --task-id task1 --category api_contract --title "a" --description "a" >/dev/null
OUT2=$("$APPEND_SH" --flow-state "$FLOW" --task-id task1 --category api_contract --title "b" --description "b")
ID2=$(echo "$OUT2" | jq -r '.finding_id')
if [[ "$ID2" == "sf_002" ]]; then
    pass "append-increments-id"
else
    fail "append-increments-id" "expected sf_002, got $ID2"
fi

# ---------- Test 3: read-all ----------
ALL=$("$READ_SH" --flow-state "$FLOW")
if [[ "$(echo "$ALL" | jq 'length')" == "2" ]]; then
    pass "read-all"
else
    fail "read-all" "expected len=2, got $(echo "$ALL" | jq 'length')"
fi

# ---------- Test 4: read-unacked-by-task ----------
# task1 authored both findings, so task2 should see both as unacked,
# but task1 should see none (own findings).
UNACK_T2=$("$READ_SH" --flow-state "$FLOW" --task-id task2 --unacked-only)
UNACK_T1=$("$READ_SH" --flow-state "$FLOW" --task-id task1 --unacked-only)
if [[ "$(echo "$UNACK_T2" | jq 'length')" == "2" ]] && [[ "$(echo "$UNACK_T1" | jq 'length')" == "0" ]]; then
    pass "read-unacked-by-task"
else
    fail "read-unacked-by-task" "t2=$(echo "$UNACK_T2" | jq 'length') t1=$(echo "$UNACK_T1" | jq 'length')"
fi

# ---------- Test 5: ack-semantics ----------
"$READ_SH" --flow-state "$FLOW" --task-id task2 --unacked-only --ack >/dev/null
UNACK_T2_AFTER=$("$READ_SH" --flow-state "$FLOW" --task-id task2 --unacked-only)
# Also verify ack is persisted
ACKED_BY=$(jq -r '.shared_findings[0].acknowledged_by | join(",")' "$FLOW")
if [[ "$(echo "$UNACK_T2_AFTER" | jq 'length')" == "0" ]] && [[ "$ACKED_BY" == "task2" ]]; then
    pass "ack-semantics"
else
    fail "ack-semantics" "unack=$(echo "$UNACK_T2_AFTER" | jq 'length') acked_by=$ACKED_BY"
fi

# ---------- Test 7: integration-check-warning ----------
T=$TMP_ROOT/t7; mkdir -p "$T"; FLOW=$T/flow.json; make_flow "$FLOW"
"$APPEND_SH" --flow-state "$FLOW" --task-id task1 --category breaking_change --title "T1" --description "d" >/dev/null
CHECK_OUT=$("$CHECK_SH" --flow-state "$FLOW")
CHECK_RC=$?
UNACKED_COUNT=$(echo "$CHECK_OUT" | jq -r '.unacked_count')
if [[ "$CHECK_RC" == "0" ]] && [[ "$UNACKED_COUNT" == "1" ]]; then
    pass "integration-check-warning"
else
    fail "integration-check-warning" "rc=$CHECK_RC count=$UNACKED_COUNT"
fi

# With all tasks having acked, unacked_count should be 0.
"$READ_SH" --flow-state "$FLOW" --task-id task2 --unacked-only --ack >/dev/null
"$READ_SH" --flow-state "$FLOW" --task-id task3 --unacked-only --ack >/dev/null
CHECK_OUT2=$("$CHECK_SH" --flow-state "$FLOW")
if [[ "$(echo "$CHECK_OUT2" | jq -r '.unacked_count')" == "0" ]]; then
    pass "integration-check-all-acked"
else
    fail "integration-check-all-acked" "expected 0, got $(echo "$CHECK_OUT2" | jq -r '.unacked_count')"
fi

# ---------- Test 8: concurrent-append ----------
T=$TMP_ROOT/t8; mkdir -p "$T"; FLOW=$T/flow.json; make_flow "$FLOW"
for i in 1 2 3 4 5; do
    ("$APPEND_SH" --flow-state "$FLOW" --task-id "task1" \
        --category design_decision --title "p$i" --description "p$i" >/dev/null) &
done
wait
COUNT=$(jq '.shared_findings | length' "$FLOW")
UNIQUE=$(jq '[.shared_findings[].id] | unique | length' "$FLOW")
if [[ "$COUNT" == "5" ]] && [[ "$UNIQUE" == "5" ]]; then
    pass "concurrent-append"
else
    fail "concurrent-append" "count=$COUNT unique=$UNIQUE"
fi

# ---------- Test 9: schema-validates (optional) ----------
if command -v check-jsonschema >/dev/null 2>&1; then
    if check-jsonschema --schemafile "$REPO_ROOT/_lib/schemas/flow.schema.json" "$FLOW" >/dev/null 2>&1; then
        pass "schema-validates"
    else
        fail "schema-validates" "check-jsonschema rejected sample"
    fi
else
    echo "SKIP: schema-validates (check-jsonschema not installed)"
fi

echo "----"
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
