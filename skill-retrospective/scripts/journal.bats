#\!/usr/bin/env bats
# Tests for skill-retrospective/scripts/journal.sh
# Focus: telemetry fields (--merge-tier, --gate-policy, --danger-hits) in cmd_log.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/skill-retrospective/scripts/journal.sh"

    # Isolate journal output to a temp directory for each test
    export CLAUDE_JOURNAL_DIR="$BATS_TMPDIR/journal-$$"
    mkdir -p "$CLAUDE_JOURNAL_DIR"
}

teardown() {
    rm -rf "$CLAUDE_JOURNAL_DIR"
}

# Helper: get the most recently written journal JSON file
latest_entry() {
    # Find the most recent .json file in CLAUDE_JOURNAL_DIR
    ls -t "$CLAUDE_JOURNAL_DIR"/*.json 2>/dev/null | head -n 1
}

# ---------------------------------------------------------------------------
# Test 1: All three telemetry options are recorded
# ---------------------------------------------------------------------------
@test "all three telemetry options recorded correctly" {
    run "$SCRIPT" log dev-flow success \
        --merge-tier REVIEW \
        --gate-policy llm-major-advisory \
        --danger-hits '["auth","crypto"]'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    merge_tier=$(jq -r '.telemetry.merge_tier' "$entry_file")
    gate_policy=$(jq -r '.telemetry.gate_policy' "$entry_file")
    danger_hits=$(jq -c '.telemetry.danger_hits' "$entry_file")

    [ "$merge_tier" = "REVIEW" ]
    [ "$gate_policy" = "llm-major-advisory" ]
    [ "$danger_hits" = '["auth","crypto"]' ]
}

# ---------------------------------------------------------------------------
# Test 2: No telemetry options -> no .telemetry key in entry
# ---------------------------------------------------------------------------
@test "no telemetry options -> no telemetry key in entry" {
    run "$SCRIPT" log dev-flow success
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_telemetry=$(jq 'has("telemetry")' "$entry_file")
    [ "$has_telemetry" = "false" ]
}

# ---------------------------------------------------------------------------
# Test 3: Only --merge-tier -> .telemetry.merge_tier recorded,
#          gate_policy and danger_hits keys absent
# ---------------------------------------------------------------------------
@test "only --merge-tier -> telemetry.merge_tier present, others absent" {
    run "$SCRIPT" log dev-flow success --merge-tier REVIEW
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    # merge_tier must be present
    merge_tier=$(jq -r '.telemetry.merge_tier' "$entry_file")
    [ "$merge_tier" = "REVIEW" ]

    # gate_policy and danger_hits must be absent
    has_gate_policy=$(jq '.telemetry | has("gate_policy")' "$entry_file")
    has_danger_hits=$(jq '.telemetry | has("danger_hits")' "$entry_file")
    [ "$has_gate_policy" = "false" ]
    [ "$has_danger_hits" = "false" ]
}

# ---------------------------------------------------------------------------
# Test 4: All 6 new telemetry fields recorded with correct types
# ---------------------------------------------------------------------------
@test "all 6 new telemetry fields recorded with correct types" {
    run "$SCRIPT" log dev-flow success \
        --merge-tier REVIEW \
        --shape standard \
        --shape-refloored false \
        --eval-verdict pass \
        --iterate-status lgtm \
        --plan-iter 2 \
        --eval-iter 1
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    shape=$(jq -r '.telemetry.shape' "$entry_file")
    eval_verdict=$(jq -r '.telemetry.eval_verdict' "$entry_file")
    iterate_status=$(jq -r '.telemetry.iterate_status' "$entry_file")

    [ "$shape" = "standard" ]
    [ "$eval_verdict" = "pass" ]
    [ "$iterate_status" = "lgtm" ]

    # shape_refloored must be boolean false (not string "false")
    shape_refloored_type=$(jq '.telemetry.shape_refloored | type' "$entry_file")
    [ "$shape_refloored_type" = '"boolean"' ]

    shape_refloored_val=$(jq '.telemetry.shape_refloored' "$entry_file")
    [ "$shape_refloored_val" = "false" ]

    # plan_iter and eval_iter must be numbers
    plan_iter_type=$(jq '.telemetry.plan_iter | type' "$entry_file")
    [ "$plan_iter_type" = '"number"' ]

    eval_iter_type=$(jq '.telemetry.eval_iter | type' "$entry_file")
    [ "$eval_iter_type" = '"number"' ]

    plan_iter_val=$(jq '.telemetry.plan_iter' "$entry_file")
    [ "$plan_iter_val" = "2" ]

    eval_iter_val=$(jq '.telemetry.eval_iter' "$entry_file")
    [ "$eval_iter_val" = "1" ]
}

# ---------------------------------------------------------------------------
# Test 5: --shape-refloored false is recorded as boolean false, not string
# ---------------------------------------------------------------------------
@test "--shape-refloored false is boolean false not string" {
    run "$SCRIPT" log dev-flow success --shape-refloored false
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    shape_refloored_type=$(jq '.telemetry.shape_refloored | type' "$entry_file")
    [ "$shape_refloored_type" = '"boolean"' ]

    shape_refloored_val=$(jq '.telemetry.shape_refloored' "$entry_file")
    [ "$shape_refloored_val" = "false" ]
}

# ---------------------------------------------------------------------------
# Test 6: --shape-refloored with invalid value exits non-zero
# ---------------------------------------------------------------------------
@test "--shape-refloored yes exits non-zero" {
    run "$SCRIPT" log dev-flow success --shape-refloored yes
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Test 7: --plan-iter with non-numeric value exits non-zero
# ---------------------------------------------------------------------------
@test "--plan-iter abc exits non-zero" {
    run "$SCRIPT" log dev-flow success --plan-iter abc
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Test 8: Partial new flags - only specified keys present, others absent
# ---------------------------------------------------------------------------
@test "only --iterate-status specified -> only that key present among new 6" {
    run "$SCRIPT" log dev-flow success --iterate-status lgtm
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    iterate_status=$(jq -r '.telemetry.iterate_status' "$entry_file")
    [ "$iterate_status" = "lgtm" ]

    # The other 5 new keys must be absent
    has_shape=$(jq '.telemetry | has("shape")' "$entry_file")
    has_shape_refloored=$(jq '.telemetry | has("shape_refloored")' "$entry_file")
    has_eval_verdict=$(jq '.telemetry | has("eval_verdict")' "$entry_file")
    has_plan_iter=$(jq '.telemetry | has("plan_iter")' "$entry_file")
    has_eval_iter=$(jq '.telemetry | has("eval_iter")' "$entry_file")

    [ "$has_shape" = "false" ]
    [ "$has_shape_refloored" = "false" ]
    [ "$has_eval_verdict" = "false" ]
    [ "$has_plan_iter" = "false" ]
    [ "$has_eval_iter" = "false" ]
}

# ---------------------------------------------------------------------------
# Test 9: Existing 3 flags only -> new 6 keys absent
# ---------------------------------------------------------------------------
@test "existing 3 telemetry flags only -> new 6 keys absent" {
    run "$SCRIPT" log dev-flow success \
        --merge-tier REVIEW \
        --gate-policy llm-major-advisory \
        --danger-hits '[]'
    [ "$status" -eq 0 ]

    entry_file=$(latest_entry)
    [ -n "$entry_file" ]

    has_shape=$(jq '.telemetry | has("shape")' "$entry_file")
    has_shape_refloored=$(jq '.telemetry | has("shape_refloored")' "$entry_file")
    has_eval_verdict=$(jq '.telemetry | has("eval_verdict")' "$entry_file")
    has_iterate_status=$(jq '.telemetry | has("iterate_status")' "$entry_file")
    has_plan_iter=$(jq '.telemetry | has("plan_iter")' "$entry_file")
    has_eval_iter=$(jq '.telemetry | has("eval_iter")' "$entry_file")

    [ "$has_shape" = "false" ]
    [ "$has_shape_refloored" = "false" ]
    [ "$has_eval_verdict" = "false" ]
    [ "$has_iterate_status" = "false" ]
    [ "$has_plan_iter" = "false" ]
    [ "$has_eval_iter" = "false" ]
}
