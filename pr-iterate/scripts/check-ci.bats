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
# cycle (on the /pulls/ call, which fires exactly once per cycle), so it is
# directly comparable to the old GH_CALL_COUNT_FILE / "gh called N times"
# assertions from the `gh`-based version of this script.
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

    CHECK_CI_CACHE_DIR="$BATS_TMPDIR/check-ci-cache"
    rm -rf "$CHECK_CI_CACHE_DIR"
    export CHECK_CI_CACHE_DIR

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
        count=$(( $(cat "$CI_CYCLE_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
        echo "$count" > "$CI_CYCLE_COUNT_FILE"
        printf '%s\n%s\n' "$CI_PR_BODY" "200"
        ;;
    */check-runs*)
        n=$(cat "$CI_CYCLE_COUNT_FILE" 2>/dev/null || echo 0)
        if (( n <= ${CI_PENDING_TIMES:-0} )); then
            printf '%s\n%s\n' "$CI_PENDING_CHECKRUNS_BODY" "200"
        elif (( n <= ${CI_PENDING_TIMES:-0} + ${CI_FAIL_TIMES:-0} )); then
            printf '%s\n%s\n' '{"message":"transient error"}' "500"
        else
            printf '%s\n%s\n' "$CI_CHECKRUNS_BODY" "200"
        fi
        ;;
    */status*)
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
# issue #463 (F2): api_get ETag conditional requests + file cache + 24h GC.
# Each stub below inspects the -D headerfile arg and any "If-None-Match:"
# arg the same way Test 25 does, so it can decide whether to answer with a
# fresh 200 (+ETag) or a cache-hit 304.
# ---------------------------------------------------------------------------

@test "200 with ETag header populates cache files" {
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
        [[ -n "$headerfile" ]] && printf 'HTTP/2 200\r\netag: W/"pr-v1"\r\n\r\n' > "$headerfile"
        printf '%s\n%s\n' "$CI_PR_BODY" "200"
        ;;
    */check-runs*) printf '%s\n%s\n' "$CI_CHECKRUNS_BODY" "200" ;;
    */status*) printf '%s\n%s\n' "$CI_STATUS_BODY" "200" ;;
    *) printf '%s\n%s\n' '{"message":"not found"}' "404" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" 42
    [ "$status" -eq 0 ]

    [ -d "$CHECK_CI_CACHE_DIR" ]
    etag_count=$(find "$CHECK_CI_CACHE_DIR" -name '*.etag' | wc -l | tr -d ' ')
    body_count=$(find "$CHECK_CI_CACHE_DIR" -name '*.body' | wc -l | tr -d ' ')
    [ "$etag_count" -ge 1 ]
    [ "$body_count" -ge 1 ]

    found=0
    for f in "$CHECK_CI_CACHE_DIR"/*.etag; do
        grep -qF 'W/"pr-v1"' "$f" && found=1
    done
    [ "$found" -eq 1 ]
}

@test "second run sends If-None-Match and reuses cached body on 304" {
    # Exercises the conditional-request round trip on all 3 endpoints
    # (pulls / check-runs / status), not just pulls: each branch below
    # checks If-None-Match against its own cached ETag and logs a
    # per-endpoint marker to INM_SEEN_FILE before answering 304, so the
    # assertions below can confirm every endpoint actually took the
    # cache-hit path rather than only one of the three.
    INM_SEEN_FILE="$BATS_TMPDIR/inm-seen"
    rm -f "$INM_SEEN_FILE"
    export INM_SEEN_FILE

    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
headerfile=""
inm=""
prev=""
for a in "$@"; do
    case "$a" in
        https://*) url="$a" ;;
        If-None-Match:*) inm="${a#If-None-Match: }" ;;
    esac
    [[ "$prev" == "-D" ]] && headerfile="$a"
    prev="$a"
done
case "$url" in
    */pulls/*)
        if [[ "$inm" == 'W/"pr-v1"' ]]; then
            echo "pulls:$inm" >> "$INM_SEEN_FILE"
            printf '\n%s\n' "304"
        else
            [[ -n "$headerfile" ]] && printf 'HTTP/2 200\r\netag: W/"pr-v1"\r\n\r\n' > "$headerfile"
            printf '%s\n%s\n' "$CI_PR_BODY" "200"
        fi
        ;;
    */check-runs*)
        if [[ "$inm" == 'W/"cr-v1"' ]]; then
            echo "check-runs:$inm" >> "$INM_SEEN_FILE"
            printf '\n%s\n' "304"
        else
            [[ -n "$headerfile" ]] && printf 'HTTP/2 200\r\netag: W/"cr-v1"\r\n\r\n' > "$headerfile"
            printf '%s\n%s\n' "$CI_CHECKRUNS_BODY" "200"
        fi
        ;;
    */status*)
        if [[ "$inm" == 'W/"st-v1"' ]]; then
            echo "status:$inm" >> "$INM_SEEN_FILE"
            printf '\n%s\n' "304"
        else
            [[ -n "$headerfile" ]] && printf 'HTTP/2 200\r\netag: W/"st-v1"\r\n\r\n' > "$headerfile"
            printf '%s\n%s\n' "$CI_STATUS_BODY" "200"
        fi
        ;;
    *) printf '%s\n%s\n' '{"message":"not found"}' "404" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
    [ ! -s "$INM_SEEN_FILE" ]

    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
    [ -s "$INM_SEEN_FILE" ]
    grep -qF 'pulls:W/"pr-v1"' "$INM_SEEN_FILE"
    grep -qF 'check-runs:W/"cr-v1"' "$INM_SEEN_FILE"
    grep -qF 'status:W/"st-v1"' "$INM_SEEN_FILE"
}

@test "304 with missing cached body falls back to unconditional refetch (fail-open)" {
    # All 3 endpoints check If-None-Match symmetrically (matching the
    # "second run..." test above) so removing every cached *.body file
    # exercises the same fail-open fallback on check-runs/status as on
    # pulls, not just pulls.
    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
headerfile=""
inm=""
prev=""
for a in "$@"; do
    case "$a" in
        https://*) url="$a" ;;
        If-None-Match:*) inm="${a#If-None-Match: }" ;;
    esac
    [[ "$prev" == "-D" ]] && headerfile="$a"
    prev="$a"
done
case "$url" in
    */pulls/*)
        if [[ -n "$inm" ]]; then
            printf '\n%s\n' "304"
        else
            [[ -n "$headerfile" ]] && printf 'HTTP/2 200\r\netag: W/"pr-v1"\r\n\r\n' > "$headerfile"
            printf '%s\n%s\n' "$CI_PR_BODY" "200"
        fi
        ;;
    */check-runs*)
        if [[ -n "$inm" ]]; then
            printf '\n%s\n' "304"
        else
            [[ -n "$headerfile" ]] && printf 'HTTP/2 200\r\netag: W/"cr-v1"\r\n\r\n' > "$headerfile"
            printf '%s\n%s\n' "$CI_CHECKRUNS_BODY" "200"
        fi
        ;;
    */status*)
        if [[ -n "$inm" ]]; then
            printf '\n%s\n' "304"
        else
            [[ -n "$headerfile" ]] && printf 'HTTP/2 200\r\netag: W/"st-v1"\r\n\r\n' > "$headerfile"
            printf '%s\n%s\n' "$CI_STATUS_BODY" "200"
        fi
        ;;
    *) printf '%s\n%s\n' '{"message":"not found"}' "404" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run "$SCRIPT" 42
    [ "$status" -eq 0 ]

    rm -f "$CHECK_CI_CACHE_DIR"/*.body

    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
}

@test "unwritable cache dir is fail-open" {
    UNWRITABLE_FILE="$BATS_TMPDIR/not-a-dir-cache"
    rm -rf "$UNWRITABLE_FILE"
    : > "$UNWRITABLE_FILE"
    export CHECK_CI_CACHE_DIR="$UNWRITABLE_FILE"

    run "$SCRIPT" 42
    [ "$status" -eq 0 ]
    result=$(echo "$output" | tail -1)
    [ "$(echo "$result" | jq -r '.status')" = "no_checks" ]
}

@test "newly created cache dir is mode 700 (owner-only, cache poisoning defense)" {
    # issue #463 (F3, security-vuln): the cache dir path is predictable
    # (${CHECK_CI_CACHE_DIR:-${TMPDIR:-/tmp}/check-ci-cache}), so on a
    # shared multi-user machine another user could pre-create it and
    # plant a forged ETag+body pair to inject a wrong-green 304 response.
    # Creating it 700 blocks other users from reading/writing into it.
    # (The companion `[[ ! -O "$CACHE_DIR" ]]` ownership check that
    # disables the cache when an existing dir isn't owned by the current
    # user can't be exercised here: non-root bats runs can't create a
    # dir owned by another user, so that fail-open branch is verified by
    # code review instead of a test.)
    [ ! -e "$CHECK_CI_CACHE_DIR" ]

    run "$SCRIPT" 42
    [ "$status" -eq 0 ]

    [ -d "$CHECK_CI_CACHE_DIR" ]
    perms="$(ls -ld "$CHECK_CI_CACHE_DIR")"
    [[ "$perms" == drwx------* ]]
}

@test "startup GC removes entries older than 24h and keeps fresh ones" {
    mkdir -p "$CHECK_CI_CACHE_DIR"
    touch -t 202601010000 "$CHECK_CI_CACHE_DIR/old.etag" "$CHECK_CI_CACHE_DIR/old.body"
    touch "$CHECK_CI_CACHE_DIR/fresh.body"

    run "$SCRIPT" 42
    [ "$status" -eq 0 ]

    [ ! -e "$CHECK_CI_CACHE_DIR/old.etag" ]
    [ ! -e "$CHECK_CI_CACHE_DIR/old.body" ]
    [ -e "$CHECK_CI_CACHE_DIR/fresh.body" ]
}

@test "3 API calls per fetch cycle are preserved" {
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
# issue #463 (F1): CHECK_CI_DEBUG=1-gated per-request stderr instrumentation
# on api_get, so a diagnosis can tell "If-None-Match not sent" apart from
# "sent but 304 never comes back" (bats-stub 304 handling alone doesn't
# prove that against the real GitHub API). Default (unset/not "1") emits
# nothing; stdout JSON contract is unaffected either way.
# ---------------------------------------------------------------------------

@test "CHECK_CI_DEBUG=1 emits per-request stderr lines with http codes" {
    export CHECK_CI_DEBUG=1
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
        [[ -n "$headerfile" ]] && printf 'HTTP/2 200\r\netag: W/"pr-v1"\r\n\r\n' > "$headerfile"
        printf '%s\n%s\n' "$CI_PR_BODY" "200"
        ;;
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

@test "CHECK_CI_DEBUG=1 shows sent If-None-Match and 304" {
    export CHECK_CI_DEBUG=1
    cat > "$STUB_DIR/curl" << 'EOF'
#!/usr/bin/env bash
url=""
headerfile=""
inm=""
prev=""
for a in "$@"; do
    case "$a" in
        https://*) url="$a" ;;
        If-None-Match:*) inm="${a#If-None-Match: }" ;;
    esac
    [[ "$prev" == "-D" ]] && headerfile="$a"
    prev="$a"
done
case "$url" in
    */pulls/*)
        if [[ "$inm" == 'W/"pr-v1"' ]]; then
            printf '\n%s\n' "304"
        else
            [[ -n "$headerfile" ]] && printf 'HTTP/2 200\r\netag: W/"pr-v1"\r\n\r\n' > "$headerfile"
            printf '%s\n%s\n' "$CI_PR_BODY" "200"
        fi
        ;;
    */check-runs*) printf '%s\n%s\n' "$CI_CHECKRUNS_BODY" "200" ;;
    */status*) printf '%s\n%s\n' "$CI_STATUS_BODY" "200" ;;
    *) printf '%s\n%s\n' '{"message":"not found"}' "404" ;;
esac
exit 0
EOF
    chmod +x "$STUB_DIR/curl"

    run --separate-stderr "$SCRIPT" 42
    [ "$status" -eq 0 ]

    run --separate-stderr "$SCRIPT" 42
    [ "$status" -eq 0 ]
    [[ "$stderr" == *"if-none-match=W/"* ]]
    [[ "$stderr" == *"-> 304"* ]]
}
