#!/usr/bin/env bats
# Tests for pr-iterate/scripts/check-ci.sh
#
# Strategy: stub `curl` via a PATH-prepended script that inspects the request
# URL (the only arg starting with "https://") and responds per endpoint:
#   .../pulls/<n>                -> PR lookup (head.sha)
#   .../commits/<sha>/check-runs -> check-runs array
#   .../commits/<sha>/status     -> legacy combined-status array (kept empty
#                                    in all tests below except where noted;
#                                    check-runs alone exercises every bucket.
#                                    "Test 23" below is the noted exception:
#                                    it populates statuses[] and asserts the
#                                    st_bucket mapping + merge with check-runs)
#
# A single call-count file (CI_CYCLE_COUNT_FILE) increments once per fetch
# cycle (on the check-runs call, which fires exactly once per fetch cycle,
# retries included; the /pulls/ call is skipped on pending-continuation
# cycles under the call-reduction design and so cannot serve as the cycle
# marker), so it is directly comparable to the old GH_CALL_COUNT_FILE /
# "gh called N times" assertions from the `gh`-based version of this script.
#
# "Pending" / "fail" simulation ordering mirrors the old `gh` stub: the
# leading CI_PENDING_TIMES cycles report pending data, the next CI_FAIL_TIMES
# cycles report an HTTP 500 (transient API error), and everything after that
# reports the fixed CI_CHECKRUNS_BODY / CI_STATUS_BODY.

setup() {
    unset GH_TOKEN GITHUB_TOKEN

    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/pr-iterate/scripts/check-ci.sh"

    STUB_DIR="$BATS_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"

    CI_CYCLE_COUNT_FILE="$BATS_TMPDIR/curl-cycle-count"
    rm -f "$CI_CYCLE_COUNT_FILE"
    CI_FAIL_TIMES=0
    CI_PENDING_TIMES=0
    CI_PENDING_CHECKRUNS_BODY='{"total_count":1,"check_runs":[{"name":"build","status":"in_progress"}]}'
    CHECK_CI_RETRY_DELAYS="0 0"
    CI_PR_BODY='{"head":{"sha":"deadbeef"}}'
    CI_CHECKRUNS_BODY='{"total_count":0,"check_runs":[]}'
    CI_STATUS_BODY='{"state":"pending","total_count":0,"statuses":[]}'
    export CI_CYCLE_COUNT_FILE CI_FAIL_TIMES CI_PENDING_TIMES CI_PENDING_CHECKRUNS_BODY
    export CHECK_CI_RETRY_DELAYS CI_PR_BODY CI_CHECKRUNS_BODY CI_STATUS_BODY

    SLEEP_LOG_FILE="$BATS_TMPDIR/sleep-log"
    rm -f "$SLEEP_LOG_FILE"
    export SLEEP_LOG_FILE

    URL_LOG_FILE="$BATS_TMPDIR/url-log"
    rm -f "$URL_LOG_FILE"
    export URL_LOG_FILE

    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
for a in "$@"; do
    case "$a" in
        https://*) url="$a" ;;
    esac
done

case "$url" in
    */pulls/*)
        echo "pulls" >> "$URL_LOG_FILE"
        printf '%s\n%s\n' "$CI_PR_BODY" "200"
        ;;
    */check-runs*)
        echo "check-runs" >> "$URL_LOG_FILE"
        n=$(( $(cat "$CI_CYCLE_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
        echo "$n" > "$CI_CYCLE_COUNT_FILE"
        if (( n <= ${CI_PENDING_TIMES:-0} )); then
            printf '%s\n%s\n' "$CI_PENDING_CHECKRUNS_BODY" "200"
        elif (( n <= ${CI_PENDING_TIMES:-0} + ${CI_FAIL_TIMES:-0} )); then
            printf '%s\n%s\n' '{"message":"transient error"}' "500"
        else
            printf '%s\n%s\n' "$CI_CHECKRUNS_BODY" "200"
        fi
        ;;
    */status*)
        echo "status" >> "$URL_LOG_FILE"
        printf '%s\n%s\n' "$CI_STATUS_BODY" "200"
        ;;
    *)
        printf '%s\n%s\n' '{"message":"not found"}' "404"
        ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

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
# Test 1: empty check-runs + empty statuses -> status 'no_checks'
# ---------------------------------------------------------------------------
@test "empty checks -> status no_checks" {
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
    [ "$(echo "$result" | jq -r '.passed')" = "0" ]
    [ "$(echo "$result" | jq -r '.failed')" = "0" ]
    [ "$(echo "$result" | jq -r '.pending')" = "0" ]
}

# ---------------------------------------------------------------------------
# Test 2: all check-runs conclusion=success -> status 'passed'
# ---------------------------------------------------------------------------
@test "all check-runs success -> status passed" {
    export CI_CHECKRUNS_BODY='{"total_count":2,"check_runs":[
      {"name":"lint","status":"completed","conclusion":"success"},
      {"name":"test","status":"completed","conclusion":"success"}
    ]}'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    [ "$(echo "$result" | jq -r '.passed')" = "2" ]
    [ "$(echo "$result" | jq -r '.failed')" = "0" ]
}

# ---------------------------------------------------------------------------
# Test 3: one check-run failure -> status 'failed', failed_checks populated
# ---------------------------------------------------------------------------
@test "one check-run failure -> status failed with failed_checks" {
    export CI_CHECKRUNS_BODY='{"total_count":2,"check_runs":[
      {"name":"lint","status":"completed","conclusion":"success"},
      {"name":"test","status":"completed","conclusion":"failure"}
    ]}'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    [ "$(echo "$result" | jq -r '.failed')" = "1" ]
    failed_names=$(echo "$result" | jq -r '.failed_checks[].name')
    [[ "$failed_names" == *"test"* ]]
}

# ---------------------------------------------------------------------------
# Test 4: one check-run still in_progress -> status 'pending'
# ---------------------------------------------------------------------------
@test "check-run in_progress -> status pending" {
    export CI_CHECKRUNS_BODY='{"total_count":1,"check_runs":[
      {"name":"build","status":"in_progress"}
    ]}'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "pending" ]
    [ "$(echo "$result" | jq -r '.pending')" = "1" ]
    pending_count=$(echo "$result" | jq '.pending_checks | length')
    [ "$pending_count" -gt 0 ]
}

# ---------------------------------------------------------------------------
# Test 5: mix of failure + in_progress -> status 'failed' (failure wins)
# ---------------------------------------------------------------------------
@test "failure + in_progress -> status failed (failure wins)" {
    export CI_CHECKRUNS_BODY='{"total_count":2,"check_runs":[
      {"name":"test","status":"completed","conclusion":"failure"},
      {"name":"deploy","status":"in_progress"}
    ]}'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    [ "$(echo "$result" | jq -r '.failed')" = "1" ]
    [ "$(echo "$result" | jq -r '.pending')" = "1" ]
}

# ---------------------------------------------------------------------------
# Test 6: conclusion=skipped -> counted as passed (status 'passed')
# ---------------------------------------------------------------------------
@test "skipped conclusion -> status passed" {
    export CI_CHECKRUNS_BODY='{"total_count":2,"check_runs":[
      {"name":"skip-check","status":"completed","conclusion":"skipped"},
      {"name":"pass-check","status":"completed","conclusion":"success"}
    ]}'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    [ "$(echo "$result" | jq -r '.failed')" = "0" ]
    skipped=$(echo "$result" | jq -r '.skipped')
    [ "$skipped" = "1" ]
}

# ---------------------------------------------------------------------------
# Test 7: check-runs endpoint returns HTTP 500 forever -> exits 1, status=error
# Regression: must NOT silently degrade to no_checks (passing) on API failure.
# ---------------------------------------------------------------------------
@test "check-runs API error (HTTP 500) -> script exits 1 with status=error, not no_checks" {
    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
case "$url" in
    */pulls/*) printf '%s\n%s\n' '{"head":{"sha":"deadbeef"}}' "200" ;;
    */check-runs*) printf '%s\n%s\n' '{"message":"Server Error"}' "500" ;;
    */status*) printf '%s\n%s\n' '{"total_count":0,"statuses":[]}' "200" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" 42
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "error" ]
}

# ---------------------------------------------------------------------------
# Test 8: check-runs fails once then succeeds -> status passed (retry path)
# ---------------------------------------------------------------------------
@test "fetch fails once then succeeds -> status passed (retry path)" {
    export CI_FAIL_TIMES=1
    export CI_CHECKRUNS_BODY='{"total_count":2,"check_runs":[
      {"name":"lint","status":"completed","conclusion":"success"},
      {"name":"test","status":"completed","conclusion":"success"}
    ]}'
    run --separate-stderr "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    call_count=$(cat "$CI_CYCLE_COUNT_FILE")
    [ "$call_count" -eq 2 ]
    [[ "$stderr" == *"check-ci: fetch failed"* ]]
}

# ---------------------------------------------------------------------------
# Test 9: fetch fails all attempts -> status error, exits 1
# With CHECK_CI_RETRY_DELAYS="0 0", max attempts = 1 initial + 2 retries = 3
# ---------------------------------------------------------------------------
@test "fetch fails all attempts -> status error, exits 1, call count 3" {
    export CI_FAIL_TIMES=10
    run "$SCRIPT" 42
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "error" ]
    call_count=$(cat "$CI_CYCLE_COUNT_FILE")
    [ "$call_count" -eq 3 ]
}

# ---------------------------------------------------------------------------
# Test 10: failed status does not trigger retry (fetch called exactly once)
# ---------------------------------------------------------------------------
@test "failed status does not trigger retry (fetch called exactly once)" {
    export CI_CHECKRUNS_BODY='{"total_count":1,"check_runs":[
      {"name":"test","status":"completed","conclusion":"failure"}
    ]}'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    call_count=$(cat "$CI_CYCLE_COUNT_FILE")
    [ "$call_count" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test 11: pending with no --wait-seconds does not trigger retry/polling
# (fetch called exactly once)
# ---------------------------------------------------------------------------
@test "pending with no wait budget -> fetch called exactly once" {
    export CI_CHECKRUNS_BODY='{"total_count":1,"check_runs":[
      {"name":"build","status":"in_progress"}
    ]}'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "pending" ]
    call_count=$(cat "$CI_CYCLE_COUNT_FILE")
    [ "$call_count" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test 12 (AC-1): pending -> passed within wait budget (bounded polling)
# CI_PENDING_TIMES=2 -> 3rd fetch returns passed. wait=10/poll=5 ->
# sleeps 5,5 (2 sleeps), 3 fetches, waited_seconds=10, poll_attempts=3.
# ---------------------------------------------------------------------------
@test "AC-1 pending -> passed within wait budget (bounded polling)" {
    export CI_PENDING_TIMES=2
    export CI_CHECKRUNS_BODY='{"total_count":2,"check_runs":[
      {"name":"lint","status":"completed","conclusion":"success"},
      {"name":"test","status":"completed","conclusion":"success"}
    ]}'
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
# Test 13 (AC-2): timeout -> terminates finitely while still pending
# CI_PENDING_TIMES=99 (always pending). wait=12/poll=5 ->
# sleeps 5,5,2 (3 sleeps), 4 fetches, waited_seconds=12, poll_attempts=4.
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
# Test 14 (AC-3): pending -> failed cuts polling short (immediate break)
# CI_PENDING_TIMES=1 -> 2nd fetch returns failed. wait=30/poll=5 ->
# 1 sleep (5s), 2 fetches, waited_seconds=5, poll_attempts=2.
# ---------------------------------------------------------------------------
@test "AC-3 pending -> failed cuts polling short" {
    export CI_PENDING_TIMES=1
    export CI_CHECKRUNS_BODY='{"total_count":1,"check_runs":[
      {"name":"test","status":"completed","conclusion":"failure"}
    ]}'
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
# Test 15 (AC-4): pending -> API error retry budget separate from wait budget
# CI_PENDING_TIMES=1, CI_FAIL_TIMES=10, CHECK_CI_RETRY_DELAYS="0 0" (max 3
# attempts per fetch cycle: 1 initial + 2 retries). wait=30/poll=5 ->
# 1st fetch cycle: pending (1 call) -> sleep 5s -> waited=5
# 2nd fetch cycle: fail,fail,fail (3 calls, retries exhausted) -> error
# Total fetch calls = 1 + 3 = 4. poll_attempts=2 (2 fetch cycles).
# ---------------------------------------------------------------------------
@test "AC-4 pending -> API error keeps wait/retry budgets separate" {
    export CI_PENDING_TIMES=1
    export CI_FAIL_TIMES=10
    export CHECK_CI_RETRY_DELAYS="0 0"
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
# Test 16 (AC-6): validation rejects invalid --wait-seconds / --poll-seconds
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
# Test 17 (AC-5 regression): no polling options -> unchanged behavior
# ---------------------------------------------------------------------------
@test "AC-5 regression: no polling options, pending -> single call" {
    export CI_CHECKRUNS_BODY='{"total_count":1,"check_runs":[
      {"name":"build","status":"in_progress"}
    ]}'
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
# Test (AC-1 unauth warning): unauthenticated run emits a one-line stderr
# warning naming the env vars and "unauthenticated", while the stdout JSON
# contract (last line = JSON, parseable) is unchanged.
# ---------------------------------------------------------------------------
@test "unauthenticated run emits one-line stderr warning, stdout JSON contract unchanged" {
    run --separate-stderr "$SCRIPT" 42
    [ "$status" -eq 0 ]
    warning_count=$(echo "$stderr" | grep -c 'GH_TOKEN.*unauthenticated\|unauthenticated.*GH_TOKEN' || true)
    [ "$warning_count" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
}

# ---------------------------------------------------------------------------
# Test (AC-1 no warning when authenticated): GH_TOKEN set -> no unauthenticated
# warning on stderr.
# ---------------------------------------------------------------------------
@test "authenticated run (GH_TOKEN set) emits no unauthenticated warning" {
    export GH_TOKEN=dummy-token
    run --separate-stderr "$SCRIPT" 42
    unset GH_TOKEN
    [ "$status" -eq 0 ]
    ! echo "$stderr" | grep -qi 'unauthenticated'
}

# ---------------------------------------------------------------------------
# Test (AC-1 warning emitted once): polling run (multiple fetch cycles)
# still emits the warning exactly once (at startup, not per-cycle).
# ---------------------------------------------------------------------------
@test "polling run emits warning only once" {
    export CI_PENDING_TIMES=2
    export CI_CHECKRUNS_BODY='{"total_count":2,"check_runs":[
      {"name":"lint","status":"completed","conclusion":"success"},
      {"name":"test","status":"completed","conclusion":"success"}
    ]}'
    run --separate-stderr "$SCRIPT" 42 --wait-seconds 10 --poll-seconds 5
    [ "$status" -eq 0 ]
    warning_count=$(echo "$stderr" | grep -c 'unauthenticated' || true)
    [ "$warning_count" -eq 1 ]
}

# ---------------------------------------------------------------------------
# Test 18: --repo owner/repo flag is honored (no git remote lookup needed)
# ---------------------------------------------------------------------------
@test "repo resolution: --repo flag is used directly" {
    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
[[ "$url" == *"/repos/explicit-owner/explicit-repo/"* ]] || { echo "unexpected url: $url" >&2; exit 1; }
case "$url" in
    */pulls/*) printf '%s\n%s\n' '{"head":{"sha":"deadbeef"}}' "200" ;;
    */check-runs*) printf '%s\n%s\n' '{"total_count":0,"check_runs":[]}' "200" ;;
    */status*) printf '%s\n%s\n' '{"total_count":0,"statuses":[]}' "200" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" 7 --repo explicit-owner/explicit-repo
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
}

# ---------------------------------------------------------------------------
# Test 19: repo/PR number parsed from a full PR URL (overrides git remote)
# ---------------------------------------------------------------------------
@test "repo resolution: owner/repo/pr-number parsed from a PR URL" {
    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
case "$url" in
    */pulls/*)
        [[ "$url" == *"/repos/url-owner/url-repo/pulls/99"* ]] || { echo "unexpected pulls url: $url" >&2; exit 1; }
        printf '%s\n%s\n' '{"head":{"sha":"deadbeef"}}' "200" ;;
    */check-runs*)
        [[ "$url" == *"/repos/url-owner/url-repo/"* ]] || { echo "unexpected check-runs url: $url" >&2; exit 1; }
        printf '%s\n%s\n' '{"total_count":0,"check_runs":[]}' "200" ;;
    */status*)
        [[ "$url" == *"/repos/url-owner/url-repo/"* ]] || { echo "unexpected status url: $url" >&2; exit 1; }
        printf '%s\n%s\n' '{"total_count":0,"statuses":[]}' "200" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" "https://github.com/url-owner/url-repo/pull/99"
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
}

# ---------------------------------------------------------------------------
# Test 20: repo auto-detected from `git remote get-url origin` when --repo
# is not given (stubbed to https://github.com/acme/widget.git in setup()).
# ---------------------------------------------------------------------------
@test "repo resolution: falls back to git remote origin url" {
    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
[[ "$url" == *"/repos/acme/widget/"* ]] || { echo "unexpected url: $url" >&2; exit 1; }
case "$url" in
    */pulls/*) printf '%s\n%s\n' '{"head":{"sha":"deadbeef"}}' "200" ;;
    */check-runs*) printf '%s\n%s\n' '{"total_count":0,"check_runs":[]}' "200" ;;
    */status*) printf '%s\n%s\n' '{"total_count":0,"statuses":[]}' "200" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" 3
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
}

# ---------------------------------------------------------------------------
# Test 21: no --repo, no PR URL, and git remote can't be resolved -> error
# ---------------------------------------------------------------------------
@test "repo resolution: unresolvable repo -> status error, exits 1, no network call" {
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
# Test 22: repo resolution handles a repo name containing a dot (e.g.
# "acme/my.repo" - legal on GitHub, matches "next.js"-style names). Regression
# for the old ([^/.]+)(\.git)?/?$ regex, which never matched such names.
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

    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
[[ "$url" == *"/repos/acme/my.repo/"* ]] || { echo "unexpected url: $url" >&2; exit 1; }
case "$url" in
    */pulls/*) printf '%s\n%s\n' '{"head":{"sha":"deadbeef"}}' "200" ;;
    */check-runs*) printf '%s\n%s\n' '{"total_count":0,"check_runs":[]}' "200" ;;
    */status*) printf '%s\n%s\n' '{"total_count":0,"statuses":[]}' "200" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" 3
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
}

# ---------------------------------------------------------------------------
# Test 23: legacy combined status (.../status statuses[] array) is merged
# with check-runs and its state->bucket mapping (success->pass,
# pending->pending, anything else->fail) is honored. Regression: this data
# source (the second half of fetch_checks' merge) had zero test coverage.
# ---------------------------------------------------------------------------
@test "legacy commit status statuses[] merges with check-runs and maps state to bucket" {
    export CI_CHECKRUNS_BODY='{"total_count":1,"check_runs":[
      {"name":"build","status":"completed","conclusion":"success"}
    ]}'
    export CI_STATUS_BODY='{"state":"failure","total_count":4,"statuses":[
      {"context":"ci/legacy-pass","state":"success"},
      {"context":"ci/legacy-pending","state":"pending"},
      {"context":"ci/legacy-fail","state":"failure"},
      {"context":"ci/legacy-error","state":"error"}
    ]}'
    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    # 1 check-run pass + 1 legacy pass = 2; 1 legacy pending; 2 legacy fail
    # (failure, error both map to "fail") -> overall status "failed".
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    [ "$(echo "$result" | jq -r '.passed')" = "2" ]
    [ "$(echo "$result" | jq -r '.pending')" = "1" ]
    [ "$(echo "$result" | jq -r '.failed')" = "2" ]
    failed_names=$(echo "$result" | jq -r '.failed_checks[].name' | sort | tr '\n' ',')
    [ "$failed_names" = "ci/legacy-error,ci/legacy-fail," ]
    pending_names=$(echo "$result" | jq -r '.pending_checks[].name')
    [ "$pending_names" = "ci/legacy-pending" ]
}

# ---------------------------------------------------------------------------
# Test 24: non-JSON response body (e.g. an HTML page from an HTTP 502
# gateway error) must not crash the script under `set -euo pipefail`.
# Regression: the jq calls inside FETCH_ERR's command substitution had no
# `|| true`, so a jq parse-error on non-JSON body triggered errexit and the
# whole script died silently (no stdout, exit 5) instead of reporting a
# JSON status=error/exit 1 like every other API failure path.
# ---------------------------------------------------------------------------
@test "non-JSON response body (HTML 502) -> status error, exits 1, not a silent crash" {
    export CHECK_CI_RETRY_DELAYS="0"
    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
case "$url" in
    */pulls/*) printf '<html><body>502 Bad Gateway</body></html>\n%s\n' "502" ;;
    *) printf '%s\n%s\n' '{"message":"not found"}' "404" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" 42
    [ "$status" -eq 1 ]
    [ -n "$output" ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "error" ]
    message=$(echo "$result" | jq -r '.message')
    [[ "$message" == *"HTTP 502"* ]]
}

# ---------------------------------------------------------------------------
# Test 25: HTTP 403 with X-RateLimit-Remaining: 0 is surfaced distinctly
# from a generic API error, so callers/logs can tell "rate limited" apart
# from an arbitrary 4xx/5xx failure.
# ---------------------------------------------------------------------------
@test "HTTP 403 rate limit exhaustion is disambiguated via X-RateLimit-Remaining" {
    export CHECK_CI_RETRY_DELAYS="0"
    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
headerfile=""
prev=""
for a in "$@"; do
    case "$a" in https://*) url="$a" ;; esac
    [[ "$prev" == "-D" ]] && headerfile="$a"
    prev="$a"
done
case "$url" in
    */pulls/*)
        if [[ -n "$headerfile" ]]; then
            printf 'HTTP/2 403\r\nx-ratelimit-remaining: 0\r\n\r\n' > "$headerfile"
        fi
        printf '%s\n%s\n' '{"message":"API rate limit exceeded for 1.2.3.4"}' "403"
        ;;
    *) printf '%s\n%s\n' '{"message":"not found"}' "404" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" 42
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "error" ]
    message=$(echo "$result" | jq -r '.message')
    [[ "$message" == *"rate limit remaining: 0"* ]]
}

# ---------------------------------------------------------------------------
# Test 26: HTTP 200 with a non-JSON body (e.g. a middlebox/proxy returning an
# HTML interstitial with a 200 code) must not crash the script either. This is
# the sibling of Test 24 for the head-SHA extraction path: that jq runs on the
# success branch, so a 200 + non-JSON body is the only way to reach it, and an
# unguarded jq there dies via errexit (no stdout, exit 5) instead of reporting
# status=error/exit 1.
# ---------------------------------------------------------------------------
@test "HTTP 200 with non-JSON body -> status error, exits 1, not a silent crash" {
    export CHECK_CI_RETRY_DELAYS="0"
    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
case "$url" in
    */pulls/*) printf '<html><body>proxy interstitial</body></html>\n%s\n' "200" ;;
    *) printf '%s\n%s\n' '{"message":"not found"}' "404" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" 42
    [ "$status" -eq 1 ]
    [ -n "$output" ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "error" ]
    message=$(echo "$result" | jq -r '.message')
    [[ "$message" == *"head.sha"* ]]
}

# ---------------------------------------------------------------------------
# Test 27: check-runs/status endpoints paginate at per_page=100. A commit
# with more results than total_count reflects (2nd+ page silently missing)
# must not be misreported as passed/no_checks -> status=error, fail-closed.
# Regression: without this guard a failing check-run stranded on a dropped
# page would silently degrade to "passed", the wrong-green class Test 7
# already guards for outright API failures.
# ---------------------------------------------------------------------------
@test "check-runs total_count > fetched length (pagination truncation) -> status error" {
    export CI_CHECKRUNS_BODY='{"total_count":150,"check_runs":[
      {"name":"lint","status":"completed","conclusion":"success"}
    ]}'
    run "$SCRIPT" 42
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "error" ]
    message=$(echo "$result" | jq -r '.message')
    [[ "$message" == *"fetched 1 of 150 check runs"* ]]
}

@test "status total_count > fetched length (pagination truncation) -> status error" {
    export CI_STATUS_BODY='{"state":"success","total_count":150,"statuses":[
      {"context":"ci/only-one","state":"success"}
    ]}'
    run "$SCRIPT" 42
    [ "$status" -eq 1 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "error" ]
    message=$(echo "$result" | jq -r '.message')
    [[ "$message" == *"fetched 1 of 150 statuses"* ]]
}

# ---------------------------------------------------------------------------
# issue #463 (F2 -> Phase 2 revision): AC-8 "immediate settle keeps call count
# at 3" regression test (this test was previously named
# "3 API calls per fetch cycle are preserved" under the now-removed ETag
# cache design; renamed here since the call-reduction design changes what
# "preserved" means for pending cycles, but an immediate single-cycle settle
# must still cost exactly 3 calls: pulls + check-runs + status, no re-verify).
# ---------------------------------------------------------------------------

@test "immediate settle (single cycle) makes exactly 3 API calls, no terminal re-verify" {
    URL_LOG_FILE="$BATS_TMPDIR/url-log"
    rm -f "$URL_LOG_FILE"
    export URL_LOG_FILE

    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
case "$url" in
    */pulls/*) echo "pulls" >> "$URL_LOG_FILE"; printf '%s\n%s\n' "$CI_PR_BODY" "200" ;;
    */check-runs*) echo "check-runs" >> "$URL_LOG_FILE"; printf '%s\n%s\n' "$CI_CHECKRUNS_BODY" "200" ;;
    */status*) echo "status" >> "$URL_LOG_FILE"; printf '%s\n%s\n' "$CI_STATUS_BODY" "200" ;;
    *) printf '%s\n%s\n' '{"message":"not found"}' "404" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" 42
    [ "$status" -eq 0 ]

    [ "$(grep -c '^pulls$' "$URL_LOG_FILE")" -eq 1 ]
    [ "$(grep -c '^check-runs$' "$URL_LOG_FILE")" -eq 1 ]
    [ "$(grep -c '^status$' "$URL_LOG_FILE")" -eq 1 ]
    [ "$(wc -l < "$URL_LOG_FILE" | tr -d ' ')" -eq 3 ]
}

# ---------------------------------------------------------------------------
# issue #463 (F1, retained after Phase 2 ETag removal): CHECK_CI_DEBUG=1-gated
# per-request stderr instrumentation on api_get. Format is
# "check-ci-debug: GET <path> -> <code>" (no if-none-match field: the ETag
# conditional-request machinery this originally diagnosed has been removed).
# Default (unset/not "1") emits nothing; stdout JSON contract is unaffected
# either way.
# ---------------------------------------------------------------------------

@test "CHECK_CI_DEBUG=1 emits per-request stderr lines with http codes" {
    export CHECK_CI_DEBUG=1
    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
case "$url" in
    */pulls/*) printf '%s\n%s\n' "$CI_PR_BODY" "200" ;;
    */check-runs*) printf '%s\n%s\n' "$CI_CHECKRUNS_BODY" "200" ;;
    */status*) printf '%s\n%s\n' "$CI_STATUS_BODY" "200" ;;
    *) printf '%s\n%s\n' '{"message":"not found"}' "404" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run --separate-stderr "$SCRIPT" 42
    [ "$status" -eq 0 ]

    debug_lines=$(printf '%s\n' "$stderr" | grep -c 'check-ci-debug: GET ')
    [ "$debug_lines" -eq 3 ]
    [[ "$stderr" == *"-> 200"* ]]

    result=$(echo "$output" | tail -1)
    echo "$result" | jq -e . >/dev/null
}

@test "CHECK_CI_DEBUG unset emits no debug lines" {
    unset CHECK_CI_DEBUG
    run --separate-stderr "$SCRIPT" 42
    [ "$status" -eq 0 ]
    [[ "$stderr" != *"check-ci-debug:"* ]]
}

# ---------------------------------------------------------------------------
# issue #463 Phase 2: call-reduction design. A single invocation caches the
# head SHA and, once the first cycle's commit status shows total_count==0,
# skips status too, for as long as the poll loop keeps returning pending.
# Whichever cycle produces the terminal verdict (passed/failed/no_checks) by
# reusing that cache re-verifies pulls (and status, if it had been skipped)
# once immediately before returning, so a SHA/status change that happened
# mid-poll is never missed. A pending return from wait-budget exhaustion is
# not a terminal verdict, so it is not re-verified (the caller re-invokes).
# ---------------------------------------------------------------------------

@test "pending -> terminal: pulls called exactly twice (initial + terminal re-verify)" {
    export CI_PENDING_TIMES=2
    export CI_CHECKRUNS_BODY='{"total_count":2,"check_runs":[
      {"name":"lint","status":"completed","conclusion":"success"},
      {"name":"test","status":"completed","conclusion":"success"}
    ]}'
    run "$SCRIPT" 42 --wait-seconds 10 --poll-seconds 5
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    [ "$(grep -c '^pulls$' "$URL_LOG_FILE")" -eq 2 ]
    [ "$(grep -c '^check-runs$' "$URL_LOG_FILE")" -eq 3 ]
    [ "$(grep -c '^status$' "$URL_LOG_FILE")" -eq 2 ]
}

@test "SHA change during poll -> terminal verdict is based on the new SHA" {
    PULLS_COUNT_FILE="$BATS_TMPDIR/pulls-count"
    OLDSHA_CR_COUNT_FILE="$BATS_TMPDIR/oldsha-cr-count"
    CR_URL_LOG_FILE="$BATS_TMPDIR/cr-url-log"
    rm -f "$PULLS_COUNT_FILE" "$OLDSHA_CR_COUNT_FILE" "$CR_URL_LOG_FILE"
    export PULLS_COUNT_FILE OLDSHA_CR_COUNT_FILE CR_URL_LOG_FILE

    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
case "$url" in
    */pulls/*)
        n=$(( $(cat "$PULLS_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
        echo "$n" > "$PULLS_COUNT_FILE"
        if [ "$n" -eq 1 ]; then
            printf '%s\n%s\n' '{"head":{"sha":"oldsha"}}' "200"
        else
            printf '%s\n%s\n' '{"head":{"sha":"newsha"}}' "200"
        fi
        ;;
    */oldsha/check-runs*)
        echo "$url" >> "$CR_URL_LOG_FILE"
        n=$(( $(cat "$OLDSHA_CR_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
        echo "$n" > "$OLDSHA_CR_COUNT_FILE"
        if [ "$n" -eq 1 ]; then
            printf '%s\n%s\n' '{"total_count":1,"check_runs":[{"name":"build","status":"in_progress"}]}' "200"
        else
            printf '%s\n%s\n' '{"total_count":1,"check_runs":[{"name":"build","status":"completed","conclusion":"success"}]}' "200"
        fi
        ;;
    */newsha/check-runs*)
        echo "$url" >> "$CR_URL_LOG_FILE"
        printf '%s\n%s\n' '{"total_count":1,"check_runs":[{"name":"newsha-gate","status":"completed","conclusion":"failure"}]}' "200"
        ;;
    */status*)
        printf '%s\n%s\n' '{"state":"success","total_count":0,"statuses":[]}' "200"
        ;;
    *) printf '%s\n%s\n' '{"message":"not found"}' "404" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" 42 --wait-seconds 30 --poll-seconds 5
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    failed_names=$(echo "$result" | jq -r '.failed_checks[].name')
    [[ "$failed_names" == *"newsha-gate"* ]]
    grep -q "oldsha" "$CR_URL_LOG_FILE"
    grep -q "newsha" "$CR_URL_LOG_FILE"
}

@test "first status total_count>0 -> status fetched every cycle, no extra terminal status refetch" {
    export CI_STATUS_BODY='{"state":"success","total_count":1,"statuses":[{"context":"ci/legacy","state":"success"}]}'
    export CI_PENDING_TIMES=2
    export CI_CHECKRUNS_BODY='{"total_count":2,"check_runs":[
      {"name":"lint","status":"completed","conclusion":"success"},
      {"name":"test","status":"completed","conclusion":"success"}
    ]}'
    run "$SCRIPT" 42 --wait-seconds 10 --poll-seconds 5
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    [ "$(grep -c '^status$' "$URL_LOG_FILE")" -eq 3 ]
    [ "$(grep -c '^pulls$' "$URL_LOG_FILE")" -eq 2 ]
}

@test "immediate settle with wait budget -> still 3 calls, no re-verify" {
    export CI_CHECKRUNS_BODY='{"total_count":2,"check_runs":[
      {"name":"lint","status":"completed","conclusion":"success"},
      {"name":"test","status":"completed","conclusion":"success"}
    ]}'
    run "$SCRIPT" 42 --wait-seconds 30 --poll-seconds 5
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "passed" ]
    [ "$(wc -l < "$URL_LOG_FILE" | tr -d ' ')" -eq 3 ]
    [ "$(grep -c '^pulls$' "$URL_LOG_FILE")" -eq 1 ]
    [ "$(grep -c '^check-runs$' "$URL_LOG_FILE")" -eq 1 ]
    [ "$(grep -c '^status$' "$URL_LOG_FILE")" -eq 1 ]
}

@test "pending timeout -> no terminal re-verify, pulls called once" {
    export CI_PENDING_TIMES=99
    run "$SCRIPT" 42 --wait-seconds 12 --poll-seconds 5
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "pending" ]
    [ "$(echo "$result" | jq -r '.waited_seconds')" = "12" ]
    # Wait-budget exhaustion while still pending is not a terminal verdict,
    # so the design does not re-verify: pulls fires only on cycle 1.
    [ "$(grep -c '^pulls$' "$URL_LOG_FILE")" -eq 1 ]
}

@test "reverify_terminal: status total_count 0->1 on terminal re-verify flips passed to failed" {
    # First status fetch reports total_count==0 (STATUS_SKIP=1, caches the
    # empty body). A later cycle settles to a would-be "passed" verdict from
    # check-runs alone while reusing that cached status. Because the verdict
    # was terminal and used the cache, reverify_terminal re-fetches status
    # (line ~478: STATUS_SKIP==1 branch) and this second fetch now reports a
    # failing status. merge_checks/compute_verdict must be re-run against it,
    # flipping the final verdict from passed to failed instead of leaving the
    # stale passed verdict in place.
    STATUS_COUNT_FILE="$BATS_TMPDIR/status-count"
    rm -f "$STATUS_COUNT_FILE"
    export STATUS_COUNT_FILE

    export CI_PENDING_TIMES=1
    export CI_CHECKRUNS_BODY='{"total_count":1,"check_runs":[
      {"name":"lint","status":"completed","conclusion":"success"}
    ]}'

    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
case "$url" in
    */pulls/*)
        echo "pulls" >> "$URL_LOG_FILE"
        printf '%s\n%s\n' "$CI_PR_BODY" "200"
        ;;
    */check-runs*)
        echo "check-runs" >> "$URL_LOG_FILE"
        n=$(( $(cat "$CI_CYCLE_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
        echo "$n" > "$CI_CYCLE_COUNT_FILE"
        if (( n <= ${CI_PENDING_TIMES:-0} )); then
            printf '%s\n%s\n' "$CI_PENDING_CHECKRUNS_BODY" "200"
        else
            printf '%s\n%s\n' "$CI_CHECKRUNS_BODY" "200"
        fi
        ;;
    */status*)
        echo "status" >> "$URL_LOG_FILE"
        n=$(( $(cat "$STATUS_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
        echo "$n" > "$STATUS_COUNT_FILE"
        if [ "$n" -eq 1 ]; then
            printf '%s\n%s\n' '{"state":"success","total_count":0,"statuses":[]}' "200"
        else
            printf '%s\n%s\n' '{"state":"failure","total_count":1,"statuses":[{"context":"ci/legacy","state":"failure"}]}' "200"
        fi
        ;;
    *) printf '%s\n%s\n' '{"message":"not found"}' "404" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" 42 --wait-seconds 10 --poll-seconds 5
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "failed" ]
    failed_names=$(echo "$result" | jq -r '.failed_checks[].name')
    [[ "$failed_names" == *"ci/legacy"* ]]
    [ "$(grep -c '^status$' "$URL_LOG_FILE")" -eq 2 ]
}
