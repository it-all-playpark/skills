#!/usr/bin/env bats
# Tests for pr-iterate/scripts/check-ci.sh
#
# Strategy: stub `gh` via a PATH-prepended script that responds to
# `pr checks ... --json name,state,bucket` with canned JSON matching the
# real gh pr checks --json output schema (bucket + state, no conclusion field).
#
# gh exit code semantics mirrored from real gh:
#   0  = all checks complete
#   8  = checks still pending
#   1  = real API error

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/pr-iterate/scripts/check-ci.sh"

    STUB_DIR="$BATS_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"

    # Default gh stub: responds to `pr checks` with canned JSON stored in
    # $GH_CHECKS_OUTPUT (exit code from $GH_EXIT_CODE, default 0).
    # Supports call-count tracking via GH_CALL_COUNT_FILE.
    # GH_FAIL_TIMES controls how many initial attempts fail with exit 1.
    GH_CALL_COUNT_FILE="$BATS_TMPDIR/gh-call-count"
    rm -f "$GH_CALL_COUNT_FILE"
    GH_FAIL_TIMES=0
    CHECK_CI_RETRY_DELAYS="0 0"
    GH_CHECKS_OUTPUT="[]"
    GH_EXIT_CODE=0
    export GH_CALL_COUNT_FILE GH_FAIL_TIMES CHECK_CI_RETRY_DELAYS
    export GH_CHECKS_OUTPUT GH_EXIT_CODE

    cat > "$STUB_DIR/gh" << 'EOF'
#!/usr/bin/env bash
if [[ "$1" == "pr" && "$2" == "checks" ]]; then
    count=$(( $(cat "$GH_CALL_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
    echo "$count" > "$GH_CALL_COUNT_FILE"
    if (( count <= ${GH_FAIL_TIMES:-0} )); then
        echo "transient network error" >&2
        exit 1
    fi
    echo "$GH_CHECKS_OUTPUT"
    exit "${GH_EXIT_CODE:-0}"
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
    export GH_EXIT_CODE=0
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
    [ "$(echo "$result" | jq -r '.passed')" = "0" ]
    [ "$(echo "$result" | jq -r '.failed')" = "0" ]
    [ "$(echo "$result" | jq -r '.pending')" = "0" ]
}

# ---------------------------------------------------------------------------
# Test 2: all bucket=pass -> status 'passed'
# Real gh schema: {"bucket":"pass","name":"...","state":"SUCCESS"}
# ---------------------------------------------------------------------------
@test "all bucket=pass -> status passed" {
    export GH_CHECKS_OUTPUT='[
      {"name":"lint","state":"SUCCESS","bucket":"pass"},
      {"name":"test","state":"SUCCESS","bucket":"pass"}
    ]'
    export GH_EXIT_CODE=0
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    [ "$(echo "$result" | jq -r '.passed')" = "2" ]
    [ "$(echo "$result" | jq -r '.failed')" = "0" ]
}

# ---------------------------------------------------------------------------
# Test 3: one bucket=fail -> status 'failed', failed_checks populated
# ---------------------------------------------------------------------------
@test "one bucket=fail -> status failed with failed_checks" {
    export GH_CHECKS_OUTPUT='[
      {"name":"lint","state":"SUCCESS","bucket":"pass"},
      {"name":"test","state":"FAILURE","bucket":"fail"}
    ]'
    export GH_EXIT_CODE=0
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    [ "$(echo "$result" | jq -r '.failed')" = "1" ]
    failed_names=$(echo "$result" | jq -r '.failed_checks[].name')
    [[ "$failed_names" == *"test"* ]]
}

# ---------------------------------------------------------------------------
# Test 4: bucket=pending + gh exit 8 -> status 'pending'
# Real gh exits 8 when checks are still in progress
# ---------------------------------------------------------------------------
@test "bucket=pending with gh exit 8 -> status pending" {
    export GH_CHECKS_OUTPUT='[
      {"name":"build","state":"IN_PROGRESS","bucket":"pending"}
    ]'
    export GH_EXIT_CODE=8
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "pending" ]
    [ "$(echo "$result" | jq -r '.pending')" = "1" ]
    pending_count=$(echo "$result" | jq '.pending_checks | length')
    [ "$pending_count" -gt 0 ]
}

# ---------------------------------------------------------------------------
# Test 5: mix of bucket=fail + bucket=pending -> status 'failed' (failure wins)
# ---------------------------------------------------------------------------
@test "bucket=fail + bucket=pending -> status failed (failure wins)" {
    export GH_CHECKS_OUTPUT='[
      {"name":"test","state":"FAILURE","bucket":"fail"},
      {"name":"deploy","state":"IN_PROGRESS","bucket":"pending"}
    ]'
    export GH_EXIT_CODE=0
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    [ "$(echo "$result" | jq -r '.failed')" = "1" ]
    [ "$(echo "$result" | jq -r '.pending')" = "1" ]
}

# ---------------------------------------------------------------------------
# Test 6: bucket=skipping -> counted as passed (status 'passed')
# ---------------------------------------------------------------------------
@test "bucket=skipping -> status passed" {
    export GH_CHECKS_OUTPUT='[
      {"name":"skip-check","state":"SKIPPED","bucket":"skipping"},
      {"name":"pass-check","state":"SUCCESS","bucket":"pass"}
    ]'
    export GH_EXIT_CODE=0
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    [ "$(echo "$result" | jq -r '.failed')" = "0" ]
    skipped=$(echo "$result" | jq -r '.skipped')
    [ "$skipped" = "1" ]
}

# ---------------------------------------------------------------------------
# Test 7: gh exits 1 (real API error) -> script exits 1 with status=error
# Regression: must NOT silently degrade to no_checks (passing) on API failure.
# ---------------------------------------------------------------------------
@test "gh API error (exit 1) -> script exits 1 with status=error, not no_checks" {
    # Stub: print an error message to stderr and exit 1
    cat > "$BATS_TMPDIR/stub-bin/gh" << 'GHEOF'
#!/usr/bin/env bash
if [[ "$1" == "pr" && "$2" == "checks" ]]; then
    echo 'Unknown JSON field: "conclusion"' >&2
    exit 1
fi
exit 0
GHEOF
    chmod +x "$BATS_TMPDIR/stub-bin/gh"

    run "$SCRIPT" 42
    # Script must exit 1 on real API error
    [ "$status" -eq 1 ]
    # Output must contain status=error, NOT no_checks
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "error" ]
}

# ---------------------------------------------------------------------------
# Test 8: gh fails once then succeeds -> status passed (retry path)
# ---------------------------------------------------------------------------
@test "gh fails once then succeeds -> status passed (retry path)" {
    export GH_FAIL_TIMES=1
    export GH_CHECKS_OUTPUT='[
      {"name":"lint","state":"SUCCESS","bucket":"pass"},
      {"name":"test","state":"SUCCESS","bucket":"pass"}
    ]'
    export GH_EXIT_CODE=0
    run --separate-stderr "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    call_count=$(cat "$GH_CALL_COUNT_FILE")
    [ "$call_count" -eq 2 ]
    # stderr must contain retry log (attempt number + failure reason)
    [[ "$stderr" == *"check-ci: gh pr checks failed"* ]]
}

# ---------------------------------------------------------------------------
# Test 9: gh fails all attempts -> status error, exits 1
# With CHECK_CI_RETRY_DELAYS="0 0", max attempts = 1 initial + 2 retries = 3
# ---------------------------------------------------------------------------
@test "gh fails all attempts -> status error, exits 1, call count 3" {
    export GH_FAIL_TIMES=10
    run "$SCRIPT" 42
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "error" ]
    call_count=$(cat "$GH_CALL_COUNT_FILE")
    [ "$call_count" -eq 3 ]
}

# ---------------------------------------------------------------------------
# Test 10: failed status does not trigger retry (gh called exactly once)
# ---------------------------------------------------------------------------
@test "failed status does not trigger retry (gh called exactly once)" {
    export GH_FAIL_TIMES=0
    export GH_CHECKS_OUTPUT='[
      {"name":"test","state":"FAILURE","bucket":"fail"}
    ]'
    export GH_EXIT_CODE=0
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    call_count=$(cat "$GH_CALL_COUNT_FILE")
    [ "$call_count" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test 11: pending (gh exit 8) does not trigger retry (gh called exactly once)
# ---------------------------------------------------------------------------
@test "pending (gh exit 8) does not trigger retry (gh called exactly once)" {
    export GH_FAIL_TIMES=0
    export GH_CHECKS_OUTPUT='[
      {"name":"build","state":"IN_PROGRESS","bucket":"pending"}
    ]'
    export GH_EXIT_CODE=8
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "pending" ]
    call_count=$(cat "$GH_CALL_COUNT_FILE")
    [ "$call_count" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test 12: real gh "no checks" behavior -> status 'no_checks', exits 0
# Real gh returns EXIT 1 with empty stdout and stderr "no checks reported on
# the '<branch>' branch" when a PR has zero checks (CI not configured). This is
# a determinate state, NOT a real API error: must report no_checks and exit 0.
# Regression for pr-iterate ci_error false positive on CI-less repos.
# ---------------------------------------------------------------------------
@test "gh exit 1 + 'no checks reported' -> status no_checks, exits 0, no retry" {
    export GH_CALL_COUNT_FILE
    cat > "$BATS_TMPDIR/stub-bin/gh" << 'GHEOF'
#!/usr/bin/env bash
if [[ "$1" == "pr" && "$2" == "checks" ]]; then
    count=$(( $(cat "$GH_CALL_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
    echo "$count" > "$GH_CALL_COUNT_FILE"
    echo "no checks reported on the 'feature-branch' branch" >&2
    exit 1
fi
exit 0
GHEOF
    chmod +x "$BATS_TMPDIR/stub-bin/gh"

    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
    [ "$(echo "$result" | jq -r '.passed')" = "0" ]
    [ "$(echo "$result" | jq -r '.failed')" = "0" ]
    [ "$(echo "$result" | jq -r '.pending')" = "0" ]
    # determinate -> must NOT retry
    call_count=$(cat "$GH_CALL_COUNT_FILE")
    [ "$call_count" -eq 1 ]
}
