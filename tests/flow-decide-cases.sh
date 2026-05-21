#!/usr/bin/env bash
# tests/flow-decide-cases.sh
#
# AC3 (issue #108): flow-decide.sh の bash-level cases (bats 不要).
# Cases cover all 5 phase transitions, abort branches, retry, dry-run integration.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/_lib/scripts/flow-decide.sh"
UPDATE="$REPO_ROOT/_lib/scripts/flow-update.sh"
FIXTURE="$REPO_ROOT/tests/fixtures/flow-v2-1-initial.json"
FX_DIR="$REPO_ROOT/tests/fixtures/decision-input"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

reset_flow() {
    cp "$FIXTURE" "$TMP_DIR/flow.json"
}

run_decide() {
    # Usage: run_decide <phase> <result-fixture> [extra-args]
    local phase="$1" fx="$2"; shift 2
    "$SCRIPT" --flow-state "$TMP_DIR/flow.json" --phase "$phase" --result "$fx" "$@"
}

# AC3.1
reset_flow
OUT=$(run_decide decompose "$FX_DIR/decompose-success.json")
NA=$(echo "$OUT" | jq -r '.next_action')
SK=$(echo "$OUT" | jq -r '.skill')
PH=$(echo "$OUT" | jq -r '.phase')
[[ "$NA" == "skill" && "$SK" == "run-batch-loop" && "$PH" == "batch_loop" ]] \
    || fail "AC3.1: decompose done -> skill run-batch-loop / phase batch_loop, got: $OUT"
pass "AC3.1: decompose done -> next_action=skill, skill=run-batch-loop, phase=batch_loop"

# AC3.2
reset_flow
OUT=$(run_decide batch_loop "$FX_DIR/batch_loop-success.json")
NA=$(echo "$OUT" | jq -r '.next_action')
SK=$(echo "$OUT" | jq -r '.skill')
[[ "$NA" == "skill" && "$SK" == "dev-integrate" ]] \
    || fail "AC3.2: batch_loop done all -> dev-integrate, got: $OUT"
pass "AC3.2: batch_loop done + all completed -> dev-integrate"

# AC3.3
reset_flow
if OUT=$(run_decide batch_loop "$FX_DIR/batch_loop-partial.json" 2>&1); then
    NA=$(echo "$OUT" | jq -r '.next_action')
    [[ "$NA" == "abort" ]] || fail "AC3.3: batch_loop failed>0 default -> abort, got: $OUT"
else
    fail "AC3.3: should emit JSON (next_action=abort), not error exit"
fi
pass "AC3.3: batch_loop failed>0 default -> abort"

# AC3.4
reset_flow
OUT=$(run_decide batch_loop "$FX_DIR/batch_loop-partial.json" --allow-partial)
NA=$(echo "$OUT" | jq -r '.next_action')
SK=$(echo "$OUT" | jq -r '.skill')
[[ "$NA" == "skill" && "$SK" == "dev-integrate" ]] \
    || fail "AC3.4: batch_loop --allow-partial -> dev-integrate, got: $OUT"
pass "AC3.4: batch_loop failed>0 + --allow-partial -> dev-integrate"

# AC3.5
reset_flow
OUT=$(run_decide integrate "$FX_DIR/integrate-success.json")
NA=$(echo "$OUT" | jq -r '.next_action')
SK=$(echo "$OUT" | jq -r '.skill')
[[ "$NA" == "skill" && "$SK" == "git-pr" ]] \
    || fail "AC3.5: integrate tests_pass -> git-pr, got: $OUT"
pass "AC3.5: integrate done + tests_pass -> git-pr"

# AC3.6 / AC3.7
reset_flow
OUT=$(run_decide integrate "$FX_DIR/integrate-failed.json")
NA=$(echo "$OUT" | jq -r '.next_action')
[[ "$NA" == "abort" ]] || fail "AC3.6/7: integrate failed/conflicts -> abort, got: $OUT"
pass "AC3.6/7: integrate failed (tests_pass=false or conflicts) -> abort"

# AC3.8
reset_flow
OUT=$(run_decide final_pr "$FX_DIR/final_pr-success.json")
NA=$(echo "$OUT" | jq -r '.next_action')
SK=$(echo "$OUT" | jq -r '.skill')
[[ "$NA" == "skill" && "$SK" == "pr-iterate" ]] \
    || fail "AC3.8: final_pr passed -> pr-iterate, got: $OUT"
pass "AC3.8: final_pr passed -> pr-iterate"

# AC3.9
reset_flow
OUT=$(run_decide pr_iterate "$FX_DIR/pr_iterate-lgtm.json")
NA=$(echo "$OUT" | jq -r '.next_action')
[[ "$NA" == "complete" ]] || fail "AC3.9: pr_iterate lgtm -> complete, got: $OUT"
pass "AC3.9: pr_iterate lgtm -> complete"

# AC3.10
reset_flow
OUT=$(run_decide pr_iterate "$FX_DIR/pr_iterate-max.json")
NA=$(echo "$OUT" | jq -r '.next_action')
RS=$(echo "$OUT" | jq -r '.reason')
[[ "$NA" == "complete" && "$RS" == *"partial"* ]] \
    || fail "AC3.10: pr_iterate max_reached -> complete (partial), got: $OUT"
pass "AC3.10: pr_iterate max_reached -> complete (partial in reason)"

# AC3.11
reset_flow
OUT=$(run_decide pr_iterate "$FX_DIR/pr_iterate-failed.json")
NA=$(echo "$OUT" | jq -r '.next_action')
[[ "$NA" == "abort" ]] || fail "AC3.11: pr_iterate failed -> abort, got: $OUT"
pass "AC3.11: pr_iterate failed -> abort"

# AC3.12: invalid phase enum
reset_flow
if "$SCRIPT" --flow-state "$TMP_DIR/flow.json" --phase foo --result "$FX_DIR/decompose-success.json" >/dev/null 2>&1; then
    fail "AC3.12: invalid phase should exit 1"
fi
pass "AC3.12: invalid phase enum exits 1"

# AC3.13: result missing required
reset_flow
echo '{"phase":"decompose"}' > "$TMP_DIR/missing.json"
if "$SCRIPT" --flow-state "$TMP_DIR/flow.json" --phase decompose --result "$TMP_DIR/missing.json" >/dev/null 2>&1; then
    fail "AC3.13: missing required field should exit 1"
fi
pass "AC3.13: missing required field exits 1"

# AC3.14: wrong flow.json version
reset_flow
jq '.version = "2.0.0"' "$TMP_DIR/flow.json" > "$TMP_DIR/flow-v2_0.json" && mv "$TMP_DIR/flow-v2_0.json" "$TMP_DIR/flow.json"
if "$SCRIPT" --flow-state "$TMP_DIR/flow.json" --phase decompose --result "$FX_DIR/decompose-success.json" >/dev/null 2>&1; then
    fail "AC3.14: wrong version should exit 1"
fi
pass "AC3.14: flow.json version != 2.1.0 exits 1"

# AC3.15: attempts >= MAX_RETRY (3) -> abort
reset_flow
jq '(.phases[] | select(.name=="batch_loop")).attempts = 3' "$TMP_DIR/flow.json" > "$TMP_DIR/flow.json.tmp" && mv "$TMP_DIR/flow.json.tmp" "$TMP_DIR/flow.json"
OUT=$(run_decide batch_loop "$FX_DIR/batch_loop-success.json" || true)
NA=$(echo "$OUT" | jq -r '.next_action')
[[ "$NA" == "abort" ]] || fail "AC3.15: attempts==3 -> abort, got: $OUT"
pass "AC3.15: phases[].attempts >= 3 -> abort (max retry exceeded)"

# AC3.16: retry_target path
reset_flow
jq '(.phases[] | select(.name=="final_pr")).status = "failed" | (.phases[] | select(.name=="final_pr")).retry_target = "integrate" | (.phases[] | select(.name=="final_pr")).attempts = 1' "$TMP_DIR/flow.json" > "$TMP_DIR/flow.json.tmp" && mv "$TMP_DIR/flow.json.tmp" "$TMP_DIR/flow.json"
OUT=$(run_decide final_pr "$FX_DIR/final_pr-success.json")
NA=$(echo "$OUT" | jq -r '.next_action')
PH=$(echo "$OUT" | jq -r '.phase')
[[ "$NA" == "retry" && "$PH" == "integrate" ]] \
    || fail "AC3.16: retry path -> retry / phase=integrate, got: $OUT"
pass "AC3.16: failed phase with retry_target -> next_action=retry"

# AC3.17: dry-run integration: 5 phase fixtures fed in order
reset_flow
# Phase 1: decompose
OUT=$(run_decide decompose "$FX_DIR/decompose-success.json")
[[ $(echo "$OUT" | jq -r '.next_action') == "skill" ]] || fail "AC3.17 step1 fail"
"$UPDATE" --flow-state "$TMP_DIR/flow.json" phase decompose done >/dev/null
"$UPDATE" --flow-state "$TMP_DIR/flow.json" phase batch_loop running --attempts +1 >/dev/null

# Phase 2: batch_loop
OUT=$(run_decide batch_loop "$FX_DIR/batch_loop-success.json")
[[ $(echo "$OUT" | jq -r '.next_action') == "skill" ]] || fail "AC3.17 step2 fail"
"$UPDATE" --flow-state "$TMP_DIR/flow.json" phase batch_loop done >/dev/null
"$UPDATE" --flow-state "$TMP_DIR/flow.json" phase integrate running --attempts +1 >/dev/null

# Phase 3: integrate
OUT=$(run_decide integrate "$FX_DIR/integrate-success.json")
[[ $(echo "$OUT" | jq -r '.next_action') == "skill" ]] || fail "AC3.17 step3 fail"
"$UPDATE" --flow-state "$TMP_DIR/flow.json" phase integrate done >/dev/null
"$UPDATE" --flow-state "$TMP_DIR/flow.json" phase final_pr running --attempts +1 >/dev/null

# Phase 4: final_pr
OUT=$(run_decide final_pr "$FX_DIR/final_pr-success.json")
[[ $(echo "$OUT" | jq -r '.next_action') == "skill" ]] || fail "AC3.17 step4 fail"
"$UPDATE" --flow-state "$TMP_DIR/flow.json" phase final_pr done >/dev/null
"$UPDATE" --flow-state "$TMP_DIR/flow.json" phase pr_iterate running --attempts +1 >/dev/null

# Phase 5: pr_iterate -> complete
OUT=$(run_decide pr_iterate "$FX_DIR/pr_iterate-lgtm.json")
NA=$(echo "$OUT" | jq -r '.next_action')
[[ "$NA" == "complete" ]] || fail "AC3.17 final step expected complete, got: $NA"
pass "AC3.17: dry-run integration: 5 phases reach complete"

# AC3.18: result phase mismatch
reset_flow
if "$SCRIPT" --flow-state "$TMP_DIR/flow.json" --phase decompose --result "$FX_DIR/batch_loop-success.json" >/dev/null 2>&1; then
    fail "AC3.18: result.phase mismatch should exit 1"
fi
pass "AC3.18: result.phase != --phase exits 1"

# AC3.19: output JSON has next_action/skill/phase/args/reason
reset_flow
OUT=$(run_decide decompose "$FX_DIR/decompose-success.json")
for f in next_action skill phase args reason; do
    if ! echo "$OUT" | jq -e "has(\"$f\")" >/dev/null 2>&1; then
        fail "AC3.19: output missing field: $f"
    fi
done
pass "AC3.19: output JSON conforms to schema (next_action/skill/phase/args/reason)"

# AC3.20: decision-input.schema.json envelope mismatch (wrong-phase content) - handled via AC3.18
echo "OK: tests/flow-decide-cases.sh"
