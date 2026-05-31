#!/usr/bin/env bats
# Tests for pr-iterate/scripts/check-ci.sh
#
# Strategy: stub `gh` via a PATH-prepended script that responds to
# `pr checks ... --json name,state,conclusion` with canned JSON.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/pr-iterate/scripts/check-ci.sh"

    STUB_DIR="$BATS_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"

    # Default gh stub: responds to `pr checks` with canned JSON stored in
    # $GH_CHECKS_OUTPUT. Other sub-commands are no-ops.
    GH_CHECKS_OUTPUT="[]"
    export GH_CHECKS_OUTPUT

    cat > "$STUB_DIR/gh" << 'EOF'
#!/usr/bin/env bash
if [[ "$1" == "pr" && "$2" == "checks" ]]; then
    echo "$GH_CHECKS_OUTPUT"
    exit 0
fi
exit 0
EOF
    chmod +x "$STUB_DIR/gh"
    export PATH="$STUB_DIR:$PATH"
}

# ---------------------------------------------------------------------------
# Test 1: empty checks array -> status 'no_checks'
# ---------------------------------------------------------------------------
@test "empty checks array -> status no_checks" {
    export GH_CHECKS_OUTPUT='[]'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
    [ "$(echo "$result" | jq -r '.passed')" = "0" ]
    [ "$(echo "$result" | jq -r '.failed')" = "0" ]
    [ "$(echo "$result" | jq -r '.pending')" = "0" ]
}

# ---------------------------------------------------------------------------
# Test 2: all SUCCESS conclusions -> status 'passed'
# ---------------------------------------------------------------------------
@test "all SUCCESS conclusions -> status passed" {
    export GH_CHECKS_OUTPUT='[
      {"name":"lint","state":"COMPLETED","conclusion":"SUCCESS"},
      {"name":"test","state":"COMPLETED","conclusion":"SUCCESS"}
    ]'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    [ "$(echo "$result" | jq -r '.passed')" = "2" ]
    [ "$(echo "$result" | jq -r '.failed')" = "0" ]
}

# ---------------------------------------------------------------------------
# Test 3: one FAILURE conclusion -> status 'failed', failed_checks populated
# ---------------------------------------------------------------------------
@test "one FAILURE conclusion -> status failed with failed_checks" {
    export GH_CHECKS_OUTPUT='[
      {"name":"lint","state":"COMPLETED","conclusion":"SUCCESS"},
      {"name":"test","state":"COMPLETED","conclusion":"FAILURE"}
    ]'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    [ "$(echo "$result" | jq -r '.failed')" = "1" ]
    failed_names=$(echo "$result" | jq -r '.failed_checks[].name')
    [[ "$failed_names" == *"test"* ]]
}

# ---------------------------------------------------------------------------
# Test 4: null conclusion + non-COMPLETED state -> status 'pending'
# ---------------------------------------------------------------------------
@test "null conclusion with IN_PROGRESS state -> status pending" {
    export GH_CHECKS_OUTPUT='[
      {"name":"build","state":"IN_PROGRESS","conclusion":null}
    ]'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "pending" ]
    [ "$(echo "$result" | jq -r '.pending')" = "1" ]
    pending_count=$(echo "$result" | jq '.pending_checks | length')
    [ "$pending_count" -gt 0 ]
}

# ---------------------------------------------------------------------------
# Test 5: mix of FAILURE + pending -> status 'failed' (failure takes priority)
# ---------------------------------------------------------------------------
@test "FAILURE + pending -> status failed (failure wins)" {
    export GH_CHECKS_OUTPUT='[
      {"name":"test","state":"COMPLETED","conclusion":"FAILURE"},
      {"name":"deploy","state":"IN_PROGRESS","conclusion":null}
    ]'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    [ "$(echo "$result" | jq -r '.failed')" = "1" ]
    [ "$(echo "$result" | jq -r '.pending')" = "1" ]
}

# ---------------------------------------------------------------------------
# Test 6: SKIPPED/NEUTRAL conclusions -> counted as passed (status 'passed')
# ---------------------------------------------------------------------------
@test "SKIPPED and NEUTRAL conclusions -> status passed" {
    export GH_CHECKS_OUTPUT='[
      {"name":"skip-check","state":"COMPLETED","conclusion":"SKIPPED"},
      {"name":"neutral-check","state":"COMPLETED","conclusion":"NEUTRAL"}
    ]'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    [ "$(echo "$result" | jq -r '.failed')" = "0" ]
    skipped=$(echo "$result" | jq -r '.skipped')
    [ "$skipped" = "1" ]
}
