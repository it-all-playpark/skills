#!/usr/bin/env bash
# tests/flow-update-phase-action.sh
#
# AC2 (issue #108): flow-update.sh `phase` action 単体テスト.
# bats が無くても bash 単体で実行できるように書く。Tests:
#   T1: phase decompose done   -> status updated + updated_at set
#   T2: phase batch_loop running --attempts +1 -> attempts==1
#   T3: phase pr_iterate done --score 95       -> score==95
#   T4: phase final_pr failed --retry-target integrate -> retry_target + failed_at
#   T5: unknown phase name dies (exit != 0)
#   T6: unknown status dies (exit != 0)
#   T7: --score 150 (out of range) dies (exit != 0)
#   T8: parallel 2-process race preserves both writes (flock or fcntl fallback)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/_lib/scripts/flow-update.sh"
FIXTURE="$REPO_ROOT/tests/fixtures/flow-v2-1-initial.json"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

reset_flow() {
    cp "$FIXTURE" "$TMP_DIR/flow.json"
}

# T1
reset_flow
"$SCRIPT" --flow-state "$TMP_DIR/flow.json" phase decompose done >/dev/null
STATUS=$(jq -r '.phases[] | select(.name=="decompose").status' "$TMP_DIR/flow.json")
[[ "$STATUS" == "done" ]] || fail "T1: phase decompose status=done expected, got: $STATUS"
UPDATED=$(jq -r '.updated_at // ""' "$TMP_DIR/flow.json")
[[ -n "$UPDATED" ]] || fail "T1: updated_at not set"
pass "T1: phase decompose done updates status + updated_at"

# T2
reset_flow
"$SCRIPT" --flow-state "$TMP_DIR/flow.json" phase batch_loop running --attempts +1 >/dev/null
STATUS=$(jq -r '.phases[] | select(.name=="batch_loop").status' "$TMP_DIR/flow.json")
ATTEMPTS=$(jq -r '.phases[] | select(.name=="batch_loop").attempts' "$TMP_DIR/flow.json")
[[ "$STATUS" == "running" && "$ATTEMPTS" == "1" ]] \
    || fail "T2: batch_loop running attempts=1 expected, got status=$STATUS attempts=$ATTEMPTS"
pass "T2: phase batch_loop running --attempts +1 increments attempts"

# T3
reset_flow
"$SCRIPT" --flow-state "$TMP_DIR/flow.json" phase pr_iterate done --score 95 >/dev/null
SCORE=$(jq -r '.phases[] | select(.name=="pr_iterate").score' "$TMP_DIR/flow.json")
[[ "$SCORE" == "95" ]] || fail "T3: pr_iterate score=95 expected, got: $SCORE"
pass "T3: phase pr_iterate done --score 95 sets score"

# T4
reset_flow
"$SCRIPT" --flow-state "$TMP_DIR/flow.json" phase final_pr failed --retry-target integrate >/dev/null
RT=$(jq -r '.phases[] | select(.name=="final_pr").retry_target' "$TMP_DIR/flow.json")
FA=$(jq -r '.phases[] | select(.name=="final_pr").failed_at' "$TMP_DIR/flow.json")
[[ "$RT" == "integrate" ]] || fail "T4: retry_target=integrate expected, got: $RT"
[[ "$FA" != "null" && -n "$FA" ]] || fail "T4: failed_at expected ISO timestamp, got: $FA"
pass "T4: phase final_pr failed --retry-target sets retry_target + failed_at"

# T5
reset_flow
if "$SCRIPT" --flow-state "$TMP_DIR/flow.json" phase foo done >/dev/null 2>&1; then
    fail "T5: invalid phase name should fail"
fi
pass "T5: invalid phase name 'foo' rejected"

# T6
reset_flow
if "$SCRIPT" --flow-state "$TMP_DIR/flow.json" phase decompose unknown_status >/dev/null 2>&1; then
    fail "T6: invalid status should fail"
fi
pass "T6: invalid phase status 'unknown_status' rejected"

# T7
reset_flow
if "$SCRIPT" --flow-state "$TMP_DIR/flow.json" phase decompose done --score 150 >/dev/null 2>&1; then
    fail "T7: --score 150 should fail"
fi
pass "T7: --score out of range 0-100 rejected"

# T8 (parallel race)
reset_flow
"$SCRIPT" --flow-state "$TMP_DIR/flow.json" phase decompose done >/dev/null &
PID1=$!
"$SCRIPT" --flow-state "$TMP_DIR/flow.json" phase batch_loop running --attempts +1 >/dev/null &
PID2=$!
wait $PID1
wait $PID2
# Verify both writes were applied AND JSON is still parseable
jq empty "$TMP_DIR/flow.json" 2>/dev/null || fail "T8: flow.json corrupted by race"
S1=$(jq -r '.phases[] | select(.name=="decompose").status' "$TMP_DIR/flow.json")
S2=$(jq -r '.phases[] | select(.name=="batch_loop").status' "$TMP_DIR/flow.json")
A2=$(jq -r '.phases[] | select(.name=="batch_loop").attempts' "$TMP_DIR/flow.json")
[[ "$S1" == "done" && "$S2" == "running" && "$A2" == "1" ]] \
    || fail "T8: parallel writes not preserved (decompose=$S1, batch_loop=$S2 attempts=$A2)"
pass "T8: parallel 2-process race preserves both writes (flock OK)"

echo "OK: tests/flow-update-phase-action.sh"
