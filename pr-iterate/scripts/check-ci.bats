#!/usr/bin/env bats
# Tests for pr-iterate/scripts/check-ci.sh
#
# issue #488: check-ci.sh is a pure transform over a `gh pr checks --json
# name,state,bucket` snapshot the caller has already fetched. It performs no
# network I/O and no waiting, so these tests need no `gh`/`curl` stub and no
# fake clock — they write snapshot files and assert on the emitted JSON.
#
# Tests removed from the previous (in-script fetch) versions with no successor
# here: gh/curl stub protocols, transient-fetch retry/backoff accounting,
# unauthenticated-request warnings, rate-limit disambiguation, REST pagination
# guards, and PR-reference/owner-repo resolution — all of those existed only
# because the fetch lived inside this script. Fetch failures now reach the
# script as "the snapshot file is not a JSON array" plus the caller's captured
# stderr, which is covered below.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/pr-iterate/scripts/check-ci.sh"

    CHECKS_FILE="$BATS_TMPDIR/ci-checks.json"
    ERR_FILE="$BATS_TMPDIR/ci-err.txt"
    rm -f "$CHECKS_FILE" "$ERR_FILE"
}

# write_checks <json> - writes the gh pr checks snapshot under test.
write_checks() {
    printf '%s\n' "$1" > "$CHECKS_FILE"
}

# write_err <text> - writes the stderr the caller captured from its gh call.
write_err() {
    printf '%s\n' "$1" > "$ERR_FILE"
}

# ---------------------------------------------------------------------------
# verdict derivation (pure function of the bucket field)
# ---------------------------------------------------------------------------

@test "passed: all pass buckets -> status passed" {
    write_checks '[{"name":"lint","state":"SUCCESS","bucket":"pass"},{"name":"test","state":"SUCCESS","bucket":"pass"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "2" ]
    [ "$(echo "$output" | jq -r '.failed')" = "0" ]
}

@test "passed: skipping counts as passed and is also reported as skipped" {
    write_checks '[{"name":"lint","state":"SUCCESS","bucket":"pass"},{"name":"e2e","state":"SKIPPED","bucket":"skipping"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "passed" ]
    [ "$(echo "$output" | jq -r '.passed')" = "2" ]
    [ "$(echo "$output" | jq -r '.skipped')" = "1" ]
}

@test "failed: fail bucket -> status failed with failed_checks entry" {
    write_checks '[{"name":"bats","state":"FAILURE","bucket":"fail"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed')" = "1" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].name')" = "bats" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].bucket')" = "fail" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].state')" = "FAILURE" ]
}

@test "failed: cancel bucket folds into failed (fail-closed)" {
    write_checks '[{"name":"build","state":"CANCELLED","bucket":"cancel"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed')" = "1" ]
}

@test "failed: unknown bucket folds into failed, never into passed (fail-closed)" {
    write_checks '[{"name":"lint","state":"SUCCESS","bucket":"pass"},{"name":"new","state":"WHATEVER","bucket":"quarantined"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
    [ "$(echo "$output" | jq -r '.failed')" = "1" ]
    [ "$(echo "$output" | jq -r '.failed_checks[0].bucket')" = "quarantined" ]
}

@test "pending: pending bucket -> status pending with pending_checks entry" {
    write_checks '[{"name":"lint","state":"SUCCESS","bucket":"pass"},{"name":"e2e","state":"IN_PROGRESS","bucket":"pending"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "pending" ]
    [ "$(echo "$output" | jq -r '.pending')" = "1" ]
    [ "$(echo "$output" | jq -r '.pending_checks[0].name')" = "e2e" ]
}

@test "pending: failure takes precedence over pending" {
    write_checks '[{"name":"bats","state":"FAILURE","bucket":"fail"},{"name":"e2e","state":"IN_PROGRESS","bucket":"pending"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE"
    [ "$(echo "$output" | jq -r '.status')" = "failed" ]
}

@test "no_checks: empty array -> status no_checks (not passed, not error)" {
    write_checks '[]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "no_checks" ]
}

# ---------------------------------------------------------------------------
# fetch-failure classification (the caller's gh call failed)
# ---------------------------------------------------------------------------

@test "no_checks: non-array snapshot + 'no checks reported' stderr -> no_checks, exit 0" {
    write_checks 'no checks reported on this branch'
    write_err "no checks reported on the 'feature/x' branch"
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --fetch-error "$ERR_FILE"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.status')" = "no_checks" ]
}

@test "error: non-array snapshot + auth/network stderr -> status error, exit 1" {
    write_checks ''
    write_err 'gh: Not Found (HTTP 404)'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --fetch-error "$ERR_FILE"
    [ "$status" -eq 1 ]
    [ "$(echo "$output" | jq -r '.status')" = "error" ]
    [[ "$(echo "$output" | jq -r '.message')" == *"404"* ]]
}

@test "error: non-array snapshot with no stderr file still fails closed" {
    write_checks 'garbage'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE"
    [ "$status" -eq 1 ]
    [ "$(echo "$output" | jq -r '.status')" = "error" ]
}

@test "error: error output still carries the bounded-wait accounting keys" {
    write_checks ''
    write_err 'gh: Not Found (HTTP 404)'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --fetch-error "$ERR_FILE" --attempt 2 --max-attempts 3 --poll-seconds 45
    [ "$status" -eq 1 ]
    [ "$(echo "$output" | jq -r '.waited_seconds')" = "45" ]
    [ "$(echo "$output" | jq -r '.poll_attempts')" = "2" ]
    [ "$(echo "$output" | jq -r '.next_action')" = "done" ]
}

# ---------------------------------------------------------------------------
# bounded-wait accounting (the caller polls; the script only reports)
# ---------------------------------------------------------------------------

@test "accounting: waited_seconds is (attempt-1)*poll-seconds and poll_attempts is attempt" {
    write_checks '[{"name":"lint","state":"SUCCESS","bucket":"pass"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --attempt 3 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.waited_seconds')" = "90" ]
    [ "$(echo "$output" | jq -r '.poll_attempts')" = "3" ]
}

@test "accounting: first attempt has waited_seconds 0" {
    write_checks '[{"name":"lint","state":"SUCCESS","bucket":"pass"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --attempt 1 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.waited_seconds')" = "0" ]
    [ "$(echo "$output" | jq -r '.poll_attempts')" = "1" ]
}

@test "accounting: defaults are attempt 1 / max-attempts 1 / poll-seconds 15" {
    write_checks '[{"name":"e2e","state":"IN_PROGRESS","bucket":"pending"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE"
    [ "$(echo "$output" | jq -r '.waited_seconds')" = "0" ]
    [ "$(echo "$output" | jq -r '.poll_attempts')" = "1" ]
    # max-attempts defaults to 1, so a single-shot call never asks for another poll.
    [ "$(echo "$output" | jq -r '.next_action')" = "done" ]
}

@test "next_action: pending with attempts remaining -> poll" {
    write_checks '[{"name":"e2e","state":"IN_PROGRESS","bucket":"pending"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --attempt 1 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.next_action')" = "poll" ]
}

@test "next_action: pending on the final attempt -> done" {
    write_checks '[{"name":"e2e","state":"IN_PROGRESS","bucket":"pending"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --attempt 3 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.next_action')" = "done" ]
}

@test "next_action: a settled verdict never asks for another poll" {
    write_checks '[{"name":"lint","state":"SUCCESS","bucket":"pass"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --attempt 1 --max-attempts 3 --poll-seconds 45
    [ "$(echo "$output" | jq -r '.next_action')" = "done" ]
}

@test "epoch: emitted as a number on success" {
    write_checks '[{"name":"lint","state":"SUCCESS","bucket":"pass"}]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE"
    [ "$(echo "$output" | jq -r '.epoch | type')" = "number" ]
}

# ---------------------------------------------------------------------------
# argument validation (deterministic, before any file read)
# ---------------------------------------------------------------------------

@test "validation: --checks-json is required" {
    run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"--checks-json"* ]]
}

@test "validation: missing snapshot file is rejected" {
    run bash "$SCRIPT" --checks-json "$BATS_TMPDIR/does-not-exist.json"
    [ "$status" -eq 1 ]
    [[ "$output" == *"not found"* ]]
}

@test "validation: --poll-seconds below 5 is rejected" {
    write_checks '[]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --poll-seconds 4
    [ "$status" -eq 1 ]
    [[ "$output" == *"--poll-seconds"* ]]
}

@test "validation: non-numeric --poll-seconds is rejected" {
    write_checks '[]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --poll-seconds abc
    [ "$status" -eq 1 ]
    [[ "$output" == *"--poll-seconds"* ]]
}

@test "validation: --attempt 0 is rejected" {
    write_checks '[]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --attempt 0
    [ "$status" -eq 1 ]
    [[ "$output" == *"--attempt"* ]]
}

@test "validation: --attempt beyond --max-attempts is rejected" {
    write_checks '[]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --attempt 4 --max-attempts 3
    [ "$status" -eq 1 ]
    [[ "$output" == *"exceeds"* ]]
}

@test "validation: --max-attempts 0 is rejected" {
    write_checks '[]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --max-attempts 0
    [ "$status" -eq 1 ]
    [[ "$output" == *"--max-attempts"* ]]
}

@test "validation: implied wait ceiling above 1800s is rejected" {
    write_checks '[]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --attempt 1 --max-attempts 100 --poll-seconds 60
    [ "$status" -eq 1 ]
    [[ "$output" == *"1800"* ]]
}

@test "validation: unknown option is rejected" {
    write_checks '[]'
    run bash "$SCRIPT" --checks-json "$CHECKS_FILE" --bogus 1
    [ "$status" -eq 1 ]
    [[ "$output" == *"Unknown option"* ]]
}

# ---------------------------------------------------------------------------
# architectural invariant (issue #488)
# ---------------------------------------------------------------------------

# NET_CMD_AT_COMMAND_POSITION matches gh/curl/wget only where a command can
# start (line start, or after ; & | or an opening paren such as `$(`). Comments
# are stripped first, and error strings like FETCH_ERR="gh pr checks: ..." are
# not matched because there the name follows `="`.
NET_CMD_AT_COMMAND_POSITION='(^|[;&|(])[[:space:]]*(gh|curl|wget)[[:space:]]'

@test "invariant: the script performs no network I/O of its own" {
    # An exec-proxy script must not carry authenticated network I/O: correctness
    # would then depend on how the script was launched. Fetching belongs to the caller.
    run bash -c "grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -nE '$NET_CMD_AT_COMMAND_POSITION'"
    [ "$status" -ne 0 ]
}

@test "invariant: the network-I/O guard actually catches an invocation (positive control)" {
    # Guards that can never fire are worse than no guard: pin that this one fires.
    probe="$BATS_TMPDIR/probe.sh"
    printf '%s\n' '#!/usr/bin/env bash' 'out=$(gh pr checks 1 --json bucket)' > "$probe"
    run bash -c "grep -vE '^[[:space:]]*#' '$probe' | grep -nE '$NET_CMD_AT_COMMAND_POSITION'"
    [ "$status" -eq 0 ]
}

@test "invariant: the script does not sleep (the caller owns wall-clock waiting)" {
    run bash -c "grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -nE '(^|[;&|(])[[:space:]]*sleep[[:space:]]'"
    [ "$status" -ne 0 ]
}
