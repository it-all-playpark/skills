#!/usr/bin/env bats
# Tests for pr-iterate/scripts/ci-wait.sh
#
# ci-wait.sh is the body of the `ci-wait` exec-proxy: it must actually block
# for the requested seconds and report `slept:true` only afterwards, because
# pr-iterate.js accumulates CI wait time from that flag alone. The tests keep
# the real waits short (a few seconds) and assert on elapsed wall-clock so a
# regression that stops waiting (or reports before waiting) fails here rather
# than silently in a run.

setup() {
    PLUGIN_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$PLUGIN_ROOT/pr-iterate/scripts/ci-wait.sh"
    BIN="$PLUGIN_ROOT/bin/ci-wait"
}

@test "ci-wait: zero seconds returns slept:true immediately" {
    run bash "$SCRIPT" 0
    [ "$status" -eq 0 ]
    [ "$output" = '{"slept":true,"seconds":0}' ]
}

@test "ci-wait: waits at least the requested seconds before reporting slept:true" {
    local start end
    start=$(date +%s)
    run bash "$SCRIPT" 2
    end=$(date +%s)
    [ "$status" -eq 0 ]
    [ "$output" = '{"slept":true,"seconds":2}' ]
    [ $(( end - start )) -ge 2 ]
}

@test "ci-wait: durations longer than one internal step are chained to the exact total" {
    # STEP=5 inside the script; 6 exercises the remainder chunk.
    local start end
    start=$(date +%s)
    run bash "$SCRIPT" 6
    end=$(date +%s)
    [ "$status" -eq 0 ]
    [ "$output" = '{"slept":true,"seconds":6}' ]
    [ $(( end - start )) -ge 6 ]
}

@test "ci-wait: rejects a missing argument with no stdout" {
    run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"must be a non-negative integer"* ]]
    [[ "$output" != *'"slept"'* ]]
}

@test "ci-wait: rejects a non-integer argument" {
    run bash "$SCRIPT" 4.5
    [ "$status" -eq 1 ]
    [[ "$output" == *"must be a non-negative integer"* ]]
}

@test "ci-wait: rejects a negative argument" {
    run bash "$SCRIPT" -3
    [ "$status" -eq 1 ]
    [[ "$output" == *"must be a non-negative integer"* ]]
}

@test "ci-wait: rejects durations above the safety ceiling" {
    run bash "$SCRIPT" 1801
    [ "$status" -eq 1 ]
    [[ "$output" == *"must be <= 1800"* ]]
}

@test "ci-wait: bin/ci-wait wrapper delegates to the script" {
    [ -x "$BIN" ]
    run "$BIN" 0
    [ "$status" -eq 0 ]
    [ "$output" = '{"slept":true,"seconds":0}' ]
}
