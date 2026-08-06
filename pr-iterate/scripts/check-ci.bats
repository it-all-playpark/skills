#!/usr/bin/env bats
# Tests for pr-iterate/scripts/check-ci.sh
#
# issue #488: check-ci.sh now fetches CI state via bare `gh pr checks --json
# name,state,bucket` instead of curl + GitHub REST API (pulls/check-runs/
# status) directly. This file stubs `gh` (not `curl`) and asserts against
# the gh-pr-checks bucket vocabulary (pass/fail/pending/skipping/cancel).
#
# gh stub protocol:
# - every invocation appends its full argument list to GH_ARGS_LOG_FILE
#   (`echo "$*" >>`).
# - only `pr checks ...` invocations are honored; anything else exits 1.
# - a single call-count file (CI_CYCLE_COUNT_FILE) increments once per gh
#   invocation, so it is directly comparable to "1 gh call = 1 fetch
#   attempt" (retries included).
# - the leading CI_PENDING_TIMES calls print CI_PENDING_CHECKS_JSON to
#   stdout and exit 8 (gh's real exit code while checks are still running);
#   the next CI_FAIL_TIMES calls print a transient-error message to stderr,
#   nothing to stdout, and exit 1; every call after that prints
#   CI_CHECKS_JSON to stdout and exits ${CI_GH_EXIT:-0}.
#
# Tests removed from the previous (curl+REST) version with no successor
# here: unauthenticated-request warnings, legacy commit-status merging
# (gh pr checks already folds that in), X-RateLimit-Remaining rate-limit
# disambiguation, check-runs/status pagination-truncation guards, and the
# issue #463 in-invocation call-reduction / terminal-reverify suite — all of
# those existed only because the old fetch layer hand-assembled 3 REST
# endpoints; `gh pr checks` does that assembly itself.

setup() {
    unset GH_TOKEN GITHUB_TOKEN

    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/pr-iterate/scripts/check-ci.sh"

    STUB_DIR="$BATS_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"

    CI_CYCLE_COUNT_FILE="$BATS_TMPDIR/gh-cycle-count"
    rm -f "$CI_CYCLE_COUNT_FILE"
    GH_ARGS_LOG_FILE="$BATS_TMPDIR/gh-args-log"
    rm -f "$GH_ARGS_LOG_FILE"

    CI_CHECKS_JSON='[]'
    CI_GH_EXIT=0
    CI_PENDING_CHECKS_JSON='[{"name":"build","state":"IN_PROGRESS","bucket":"pending"}]'
    CI_PENDING_TIMES=0
    CI_FAIL_TIMES=0
    CHECK_CI_RETRY_DELAYS="0 0"
    export CI_CYCLE_COUNT_FILE GH_ARGS_LOG_FILE CI_CHECKS_JSON CI_GH_EXIT
    export CI_PENDING_CHECKS_JSON CI_PENDING_TIMES CI_FAIL_TIMES CHECK_CI_RETRY_DELAYS

    SLEEP_LOG_FILE="$BATS_TMPDIR/sleep-log"
    rm -f "$SLEEP_LOG_FILE"
    export SLEEP_LOG_FILE

    cat > "$STUB_DIR/gh" << 'EOF'
#!/usr/bin/env bash
echo "$*" >> "$GH_ARGS_LOG_FILE"
if [[ "$1 $2" != "pr checks" ]]; then
    exit 1
fi
n=$(( $(cat "$CI_CYCLE_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$CI_CYCLE_COUNT_FILE"
if (( n <= ${CI_PENDING_TIMES:-0} )); then
    printf '%s\n' "$CI_PENDING_CHECKS_JSON"
    exit 8
elif (( n <= ${CI_PENDING_TIMES:-0} + ${CI_FAIL_TIMES:-0} )); then
    echo "HTTP 500: transient server error" >&2
    exit 1
else
    printf '%s\n' "$CI_CHECKS_JSON"
    exit "${CI_GH_EXIT:-0}"
fi
EOF
    chmod +x "$STUB_DIR/gh"

    cat > "$STUB_DIR/sleep" << 'EOF'
#!/usr/bin/env bash
echo "$1" >> "$SLEEP_LOG_FILE"
exit 0
EOF
    chmod +x "$STUB_DIR/sleep"

    cat > "$STUB_DIR/git" << 'EOF'
#!/usr/bin/env bash
if [[ "$1" == "config" && "$2" == "--get" && "$3" == "remote.origin.url" ]]; then
    echo "https://github.com/acme/widget.git"
    exit 0
fi
exit 1
EOF
    chmod +x "$STUB_DIR/git"

    export PATH="$STUB_DIR:$PATH"
}

# ---------------------------------------------------------------------------
# Test 1: empty array + exit 0 -> status no_checks
# ---------------------------------------------------------------------------
@test "empty array -> status no_checks" {
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
    [ "$(echo "$result" | jq -r '.passed')" = "0" ]
    [ "$(echo "$result" | jq -r '.failed')" = "0" ]
    [ "$(echo "$result" | jq -r '.pending')" = "0" ]
    [ "$(echo "$result" | jq -r '.epoch | type')" = "number" ]
}

# ---------------------------------------------------------------------------
# Test 2: gh exits non-zero with empty stdout and a "no checks reported"
# stderr message (a real `gh` behavior variant on branches with zero
# configured checks) -> status no_checks, script still exits 0.
# ---------------------------------------------------------------------------
@test "gh 'no checks reported' stderr + exit 1 -> status no_checks, script exit 0" {
    cat > "$STUB_DIR/gh" << 'EOF'
#!/usr/bin/env bash
echo "$*" >> "$GH_ARGS_LOG_FILE"
[[ "$1 $2" == "pr checks" ]] || exit 1
n=$(( $(cat "$CI_CYCLE_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$CI_CYCLE_COUNT_FILE"
echo "no checks reported on the 'feature' branch" >&2
exit 1
EOF
    chmod +x "$STUB_DIR/gh"

    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
}

# ---------------------------------------------------------------------------
# Test 3: all bucket pass -> status passed
# ---------------------------------------------------------------------------
@test "all bucket pass -> status passed" {
    export CI_CHECKS_JSON='[
      {"name":"lint","state":"SUCCESS","bucket":"pass"},
      {"name":"test","state":"SUCCESS","bucket":"pass"}
    ]'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    [ "$(echo "$result" | jq -r '.passed')" = "2" ]
    [ "$(echo "$result" | jq -r '.failed')" = "0" ]
    grep -q -- '--json name,state,bucket' "$GH_ARGS_LOG_FILE"
}

# ---------------------------------------------------------------------------
# Test 4 (AC-3 / c7ada02 regression): bucket fail + gh exit 1 -> status
# failed, NOT error. `gh pr checks` returns exit 1 when a check has failed;
# the verdict must come from the bucket JSON, not the exit code.
# ---------------------------------------------------------------------------
@test "bucket fail with gh exit 1 -> status failed, not error" {
    export CI_CHECKS_JSON='[
      {"name":"lint","state":"SUCCESS","bucket":"pass"},
      {"name":"test","state":"FAILURE","bucket":"fail"}
    ]'
    export CI_GH_EXIT=1
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    [ "$(echo "$result" | jq -r '.failed')" = "1" ]
    failed_names=$(echo "$result" | jq -r '.failed_checks[].name')
    [[ "$failed_names" == *"test"* ]]
}

# ---------------------------------------------------------------------------
# Test 5 (AC-3 regression): bucket pending + gh exit 8 -> status pending,
# NOT error. `gh pr checks` returns exit 8 while checks are still running.
# ---------------------------------------------------------------------------
@test "bucket pending with gh exit 8 -> status pending, not error" {
    export CI_PENDING_TIMES=1
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "pending" ]
    pending_count=$(echo "$result" | jq '.pending_checks | length')
    [ "$pending_count" -gt 0 ]
}

# ---------------------------------------------------------------------------
# Test 6: fail + pending mixed -> status failed (failure wins)
# ---------------------------------------------------------------------------
@test "fail + pending mixed -> status failed (failure wins)" {
    export CI_CHECKS_JSON='[
      {"name":"test","state":"FAILURE","bucket":"fail"},
      {"name":"deploy","state":"IN_PROGRESS","bucket":"pending"}
    ]'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    [ "$(echo "$result" | jq -r '.failed')" = "1" ]
    [ "$(echo "$result" | jq -r '.pending')" = "1" ]
}

# ---------------------------------------------------------------------------
# Test 7: bucket skipping + pass -> status passed, skipped=1, failed=0
# ---------------------------------------------------------------------------
@test "bucket skipping + pass -> status passed, skipped counted, failed 0" {
    export CI_CHECKS_JSON='[
      {"name":"skip-check","state":"SKIPPED","bucket":"skipping"},
      {"name":"pass-check","state":"SUCCESS","bucket":"pass"}
    ]'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    [ "$(echo "$result" | jq -r '.failed')" = "0" ]
    [ "$(echo "$result" | jq -r '.skipped')" = "1" ]
}

# ---------------------------------------------------------------------------
# Test 8: bucket cancel -> status failed, failed_checks includes the
# cancelled check as {name,bucket,state}.
# ---------------------------------------------------------------------------
@test "bucket cancel -> status failed, cancel check included in failed_checks" {
    export CI_CHECKS_JSON='[
      {"name":"deploy","state":"CANCELLED","bucket":"cancel"}
    ]'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    [ "$(echo "$result" | jq -r '.failed')" = "1" ]
    entry=$(echo "$result" | jq -c '.failed_checks[0]')
    [ "$(echo "$entry" | jq -r '.name')" = "deploy" ]
    [ "$(echo "$entry" | jq -r '.bucket')" = "cancel" ]
    [ "$(echo "$entry" | jq -r '.state')" = "CANCELLED" ]
}

# ---------------------------------------------------------------------------
# Test 9: gh fails every attempt -> script exits 1, status error, call
# count 3 (1 initial + 2 retries, CHECK_CI_RETRY_DELAYS="0 0").
# ---------------------------------------------------------------------------
@test "gh fails every attempt -> exit 1, status error, call count 3" {
    export CI_FAIL_TIMES=10
    run "$SCRIPT" 42
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "error" ]
    call_count=$(cat "$CI_CYCLE_COUNT_FILE")
    [ "$call_count" -eq 3 ]
    [ "$(echo "$result" | jq -r '.epoch | type')" = "number" ]
}

# ---------------------------------------------------------------------------
# Test 10: gh fails once then succeeds -> status passed, count 2, retry
# message on stderr.
# ---------------------------------------------------------------------------
@test "gh fails once then succeeds -> status passed (retry path)" {
    export CI_FAIL_TIMES=1
    export CI_CHECKS_JSON='[
      {"name":"lint","state":"SUCCESS","bucket":"pass"},
      {"name":"test","state":"SUCCESS","bucket":"pass"}
    ]'
    run --separate-stderr "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    call_count=$(cat "$CI_CYCLE_COUNT_FILE")
    [ "$call_count" -eq 2 ]
    [[ "$stderr" == *"check-ci: fetch failed"* ]]
}

# ---------------------------------------------------------------------------
# Test 11: a failed verdict does not trigger a retry (gh called exactly
# once).
# ---------------------------------------------------------------------------
@test "failed verdict does not trigger retry (gh called exactly once)" {
    export CI_CHECKS_JSON='[
      {"name":"test","state":"FAILURE","bucket":"fail"}
    ]'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    call_count=$(cat "$CI_CYCLE_COUNT_FILE")
    [ "$call_count" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test 12: `date +%s` failure on the success path -> epoch is JSON null,
# exit code and other keys unaffected.
# ---------------------------------------------------------------------------
@test "date +%s failure (success path) -> epoch null, status passed, exit 0" {
    cat > "$STUB_DIR/date" << 'EOF'
#!/usr/bin/env bash
exit 1
EOF
    chmod +x "$STUB_DIR/date"

    export CI_CHECKS_JSON='[
      {"name":"lint","state":"SUCCESS","bucket":"pass"},
      {"name":"test","state":"SUCCESS","bucket":"pass"}
    ]'
    run "$SCRIPT" 42
    rm -f "$STUB_DIR/date"
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    [ "$(echo "$result" | jq -r '.epoch')" = "null" ]
}

# ---------------------------------------------------------------------------
# Test 13: `date +%s` failure on the error path -> epoch still null, status
# still error, exit still 1.
# ---------------------------------------------------------------------------
@test "date +%s failure (error path) -> epoch null, status error, exit 1" {
    cat > "$STUB_DIR/date" << 'EOF'
#!/usr/bin/env bash
exit 1
EOF
    chmod +x "$STUB_DIR/date"

    export CI_FAIL_TIMES=10
    run "$SCRIPT" 42
    rm -f "$STUB_DIR/date"
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "error" ]
    [ "$(echo "$result" | jq -r '.epoch')" = "null" ]
}

# ---------------------------------------------------------------------------
# Test 14: pending with no --wait-seconds does not poll (gh called exactly
# once).
# ---------------------------------------------------------------------------
@test "pending with no wait budget -> gh called exactly once" {
    export CI_PENDING_TIMES=1
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "pending" ]
    call_count=$(cat "$CI_CYCLE_COUNT_FILE")
    [ "$call_count" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test 15 (AC-1): pending -> passed within wait budget (bounded polling).
# CI_PENDING_TIMES=2 -> 3rd fetch returns passed. wait=10/poll=5 -> sleeps
# 5,5 (2 sleeps), 3 fetches, waited_seconds=10, poll_attempts=3.
# ---------------------------------------------------------------------------
@test "AC-1 pending -> passed within wait budget (bounded polling)" {
    export CI_PENDING_TIMES=2
    export CI_CHECKS_JSON='[
      {"name":"lint","state":"SUCCESS","bucket":"pass"},
      {"name":"test","state":"SUCCESS","bucket":"pass"}
    ]'
    run "$SCRIPT" 42 --wait-seconds 10 --poll-seconds 5
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    [ "$(echo "$result" | jq -r '.waited_seconds')" = "10" ]
    [ "$(echo "$result" | jq -r '.poll_attempts')" = "3" ]
    call_count=$(cat "$CI_CYCLE_COUNT_FILE")
    [ "$call_count" -eq 3 ]
    [ "$(cat "$SLEEP_LOG_FILE" | tr '\n' ',')" = "5,5," ]
}

# ---------------------------------------------------------------------------
# Test 16 (AC-2): timeout -> terminates finitely while still pending.
# CI_PENDING_TIMES=99 (always pending). wait=12/poll=5 -> sleeps 5,5,2
# (3 sleeps), 4 fetches, waited_seconds=12, poll_attempts=4.
# ---------------------------------------------------------------------------
@test "AC-2 timeout -> terminates finitely still pending" {
    export CI_PENDING_TIMES=99
    run "$SCRIPT" 42 --wait-seconds 12 --poll-seconds 5
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "pending" ]
    [ "$(echo "$result" | jq -r '.waited_seconds')" = "12" ]
    [ "$(echo "$result" | jq -r '.poll_attempts')" = "4" ]
    call_count=$(cat "$CI_CYCLE_COUNT_FILE")
    [ "$call_count" -eq 4 ]
    [ "$(cat "$SLEEP_LOG_FILE" | tr '\n' ',')" = "5,5,2," ]
}

# ---------------------------------------------------------------------------
# Test 17 (AC-3): pending -> failed cuts polling short (immediate break).
# CI_PENDING_TIMES=1 -> 2nd fetch returns failed. wait=30/poll=5 -> 1 sleep
# (5s), 2 fetches, waited_seconds=5, poll_attempts=2.
# ---------------------------------------------------------------------------
@test "AC-3 pending -> failed cuts polling short" {
    export CI_PENDING_TIMES=1
    export CI_CHECKS_JSON='[
      {"name":"test","state":"FAILURE","bucket":"fail"}
    ]'
    run "$SCRIPT" 42 --wait-seconds 30 --poll-seconds 5
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    [ "$(echo "$result" | jq -r '.waited_seconds')" = "5" ]
    [ "$(echo "$result" | jq -r '.poll_attempts')" = "2" ]
    call_count=$(cat "$CI_CYCLE_COUNT_FILE")
    [ "$call_count" -eq 2 ]
}

# ---------------------------------------------------------------------------
# Test 18 (AC-4): pending -> API error retry budget separate from wait
# budget. CI_PENDING_TIMES=1, CI_FAIL_TIMES=10, CHECK_CI_RETRY_DELAYS="0 0"
# (max 3 attempts per fetch cycle). wait=30/poll=5 ->
# cycle 1: pending (1 call) -> sleep 5s -> waited=5
# cycle 2: fail,fail,fail (3 calls, retries exhausted) -> error
# Total gh calls = 1 + 3 = 4. poll_attempts=2 (2 fetch cycles).
# ---------------------------------------------------------------------------
@test "AC-4 pending -> API error keeps wait/retry budgets separate" {
    export CI_PENDING_TIMES=1
    export CI_FAIL_TIMES=10
    run "$SCRIPT" 42 --wait-seconds 30 --poll-seconds 5
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "error" ]
    [ "$(echo "$result" | jq -r '.waited_seconds')" = "5" ]
    [ "$(echo "$result" | jq -r '.poll_attempts')" = "2" ]
    call_count=$(cat "$CI_CYCLE_COUNT_FILE")
    [ "$call_count" -eq 4 ]
}

# ---------------------------------------------------------------------------
# Tests 19-22 (AC-6): validation rejects invalid --wait-seconds /
# --poll-seconds before any gh call.
# ---------------------------------------------------------------------------
@test "AC-6 validation rejects non-numeric --wait-seconds" {
    run "$SCRIPT" 42 --wait-seconds abc
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [[ "$(echo "$result" | jq -r '.error')" == *"Invalid"* ]]
    [ ! -f "$CI_CYCLE_COUNT_FILE" ]
}

@test "AC-6 validation rejects negative --wait-seconds" {
    run "$SCRIPT" 42 --wait-seconds -1
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [[ "$(echo "$result" | jq -r '.error')" == *"Invalid"* ]]
    [ ! -f "$CI_CYCLE_COUNT_FILE" ]
}

@test "AC-6 validation rejects --wait-seconds over 1800" {
    run "$SCRIPT" 42 --wait-seconds 1801
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [[ "$(echo "$result" | jq -r '.error')" == *"Invalid"* ]]
    [ ! -f "$CI_CYCLE_COUNT_FILE" ]
}

@test "AC-6 validation rejects --poll-seconds under 5" {
    run "$SCRIPT" 42 --wait-seconds 60 --poll-seconds 4
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [[ "$(echo "$result" | jq -r '.error')" == *"Invalid"* ]]
    [ ! -f "$CI_CYCLE_COUNT_FILE" ]
}

# ---------------------------------------------------------------------------
# Test 23 (AC-5 regression): no polling options -> unchanged behavior.
# ---------------------------------------------------------------------------
@test "AC-5 regression: no polling options, pending -> single call" {
    export CI_PENDING_TIMES=1
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "pending" ]
    [ "$(echo "$result" | jq -r '.waited_seconds')" = "0" ]
    [ "$(echo "$result" | jq -r '.poll_attempts')" = "1" ]
    call_count=$(cat "$CI_CYCLE_COUNT_FILE")
    [ "$call_count" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test 24: --repo owner/repo flag is passed through to gh directly (no git
# remote lookup needed).
# ---------------------------------------------------------------------------
@test "repo resolution: --repo flag is passed to gh directly" {
    run "$SCRIPT" 7 --repo explicit-owner/explicit-repo
    [ "$status" -eq 0 ]
    grep -q -- "--repo explicit-owner/explicit-repo" "$GH_ARGS_LOG_FILE"
    grep -qE '^pr checks 7 ' "$GH_ARGS_LOG_FILE"
}

# ---------------------------------------------------------------------------
# Test 25: repo/PR number parsed from a full PR URL (overrides git remote).
# ---------------------------------------------------------------------------
@test "repo resolution: owner/repo/pr-number parsed from a PR URL" {
    run "$SCRIPT" "https://github.com/url-owner/url-repo/pull/99"
    [ "$status" -eq 0 ]
    grep -qE '^pr checks 99 ' "$GH_ARGS_LOG_FILE"
    grep -q -- "--repo url-owner/url-repo" "$GH_ARGS_LOG_FILE"
}

# ---------------------------------------------------------------------------
# Test 26: repo auto-detected from `git remote get-url origin` when --repo
# is not given (stubbed to https://github.com/acme/widget.git in setup()).
# ---------------------------------------------------------------------------
@test "repo resolution: falls back to git remote origin url" {
    run "$SCRIPT" 3
    [ "$status" -eq 0 ]
    grep -q -- "--repo acme/widget" "$GH_ARGS_LOG_FILE"
}

# ---------------------------------------------------------------------------
# Test 27: no --repo, no PR URL, and git remote can't be resolved -> error,
# gh is never called.
# ---------------------------------------------------------------------------
@test "repo resolution: unresolvable repo -> status error, exits 1, gh not called" {
    cat > "$STUB_DIR/git" << 'EOF'
#!/usr/bin/env bash
exit 1
EOF
    chmod +x "$STUB_DIR/git"

    run "$SCRIPT" 3
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [[ "$(echo "$result" | jq -r '.error')" == *"repo"* ]]
    [ ! -f "$CI_CYCLE_COUNT_FILE" ]
}

# ---------------------------------------------------------------------------
# Test 28: repo resolution handles a repo name containing a dot (e.g.
# "acme/my.repo" - legal on GitHub, matches "next.js"-style names).
# ---------------------------------------------------------------------------
@test "repo resolution: git remote origin url with a dot in the repo name" {
    cat > "$STUB_DIR/git" << 'EOF'
#!/usr/bin/env bash
if [[ "$1" == "config" && "$2" == "--get" && "$3" == "remote.origin.url" ]]; then
    echo "https://github.com/acme/my.repo.git"
    exit 0
fi
exit 1
EOF
    chmod +x "$STUB_DIR/git"

    run "$SCRIPT" 3
    [ "$status" -eq 0 ]
    grep -q -- "--repo acme/my.repo" "$GH_ARGS_LOG_FILE"
}

# ---------------------------------------------------------------------------
# Test 29: gh exits 0 but stdout is not valid JSON (e.g. a proxy
# interstitial page) -> must not crash the script; retries then reports
# status=error, exit 1.
# ---------------------------------------------------------------------------
@test "gh exit 0 with non-JSON stdout -> retries then status error, exit 1" {
    export CHECK_CI_RETRY_DELAYS="0"
    cat > "$STUB_DIR/gh" << 'EOF'
#!/usr/bin/env bash
echo "$*" >> "$GH_ARGS_LOG_FILE"
[[ "$1 $2" == "pr checks" ]] || exit 1
n=$(( $(cat "$CI_CYCLE_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$CI_CYCLE_COUNT_FILE"
printf '<html>proxy interstitial</html>\n'
exit 0
EOF
    chmod +x "$STUB_DIR/gh"

    run "$SCRIPT" 42
    [ "$status" -eq 1 ]
    [ -n "$output" ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "error" ]
}

# ---------------------------------------------------------------------------
# Test 30: the gh invocation is called with the bucket-contract --json flag.
# ---------------------------------------------------------------------------
@test "gh is invoked with --json name,state,bucket" {
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    grep -q -- '--json name,state,bucket' "$GH_ARGS_LOG_FILE"
}

# ---------------------------------------------------------------------------
# Test 31: CHECK_CI_DEBUG=1 emits one stderr line per gh invocation.
# ---------------------------------------------------------------------------
@test "CHECK_CI_DEBUG=1 emits one stderr line with the gh exit code" {
    export CHECK_CI_DEBUG=1
    run --separate-stderr "$SCRIPT" 42
    [ "$status" -eq 0 ]
    debug_lines=$(printf '%s\n' "$stderr" | grep -c 'check-ci-debug: gh pr checks -> exit 0')
    [ "$debug_lines" -eq 1 ]
    result=$(echo "$output" | tail -1)
    echo "$result" | jq -e . >/dev/null
}

# ---------------------------------------------------------------------------
# Test 32: CHECK_CI_DEBUG unset emits no debug lines.
# ---------------------------------------------------------------------------
@test "CHECK_CI_DEBUG unset emits no debug lines" {
    unset CHECK_CI_DEBUG
    run --separate-stderr "$SCRIPT" 42
    [ "$status" -eq 0 ]
    [[ "$stderr" != *"check-ci-debug:"* ]]
}

# ---------------------------------------------------------------------------
# Test 33 (AC-2 static regression): the script must not talk to the GitHub
# REST API directly (curl) or via `gh api` (issue #458 prescription
# regression). Deterministic enforcement, independent of any LLM review.
# ---------------------------------------------------------------------------
@test "static regression: script body contains no curl and no gh api" {
    ! grep -qE '\bcurl\b' "$SCRIPT"
    ! grep -qE 'gh[[:space:]]+api\b' "$SCRIPT"
}
