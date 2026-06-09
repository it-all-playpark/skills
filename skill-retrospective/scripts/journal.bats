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
