#!/usr/bin/env bash
# check-ci.sh - Query PR CI status with pending vs failure disambiguation.
# Usage: check-ci.sh <pr-number-or-url> [--repo <owner/repo>]
#                     [--wait-seconds N] [--poll-seconds M]
#
# Exits 0 when CI status is determined (passed/failed/pending/no_checks).
# Exits 1 when the GitHub API fails with a real error (auth, network, unknown
# repo/PR) or when --wait-seconds/--poll-seconds validation fails.
# CI state is reported via stdout JSON so the caller can treat pending != failure.
#
# issue #458: this script talks to the GitHub REST API directly via curl
# instead of shelling out to `gh`, so it runs fully inside the sandboxed
# Bash tool with no special invocation requirements — `gh` needed its own
# config file and had known TLS verification issues under sandboxing that
# curl does not have.
#
# --wait-seconds N (default 0): total seconds to keep polling while CI is
#   pending, in bounded increments of --poll-seconds. 0 = no polling
#   (single fetch, current/legacy behavior). Must be an integer 0-1800.
# --poll-seconds M (default 30): sleep interval between polls while pending.
#   Must be an integer >= 5. Validated even when --wait-seconds is 0.
#
# Output JSON:
#   { "status": "passed" | "failed" | "pending" | "no_checks" | "error",
#     "passed": N, "failed": N, "pending": N, "skipped": N,
#     "failed_checks": [...], "pending_checks": [...],
#     "waited_seconds": N, "poll_attempts": N }
#
# Auth: if GH_TOKEN or GITHUB_TOKEN is set, requests are authenticated
# (Bearer token) for a higher rate limit and private-repo access. Otherwise
# requests are unauthenticated (60 req/hour/IP — fine for public repos at
# normal dev-flow run volume; see the in-invocation call reduction note
# below for the actual per-cycle call cost). When unauthenticated, a
# one-line warning is printed to stderr at startup.
#
# Transient failures (network error, non-2xx HTTP response from any of the
# API calls a fetch cycle makes) are retried with backoff within each poll
# cycle. Max retries = number of delay entries in CHECK_CI_RETRY_DELAYS
# (default 10s/30s). The retry budget resets every poll cycle and is
# independent from the --wait-seconds wait budget (AC-4): API-error retries
# never consume waited_seconds.
#
# In-invocation call reduction (issue #463 Phase 2): a single invocation
# keeps two shell variables only (CACHED_SHA, STATUS_SKIP) — nothing is
# persisted to disk across invocations. The first cycle costs 3 calls
# (pulls -> head SHA, check-runs, status). Once the head SHA is resolved,
# subsequent pending-continuation cycles skip the pulls GET and reuse
# CACHED_SHA; once a status GET reports total_count==0, subsequent cycles
# skip the status GET too and reuse that empty body (a status GET with
# total_count>0 is refetched every cycle, since new statuses can still
# post). Right before returning a non-pending (terminal) verdict that was
# produced using this cache, the script re-fetches pulls once (and status
# once too, if it had been skipped) to catch a head SHA or status change
# that happened mid-poll; if the head SHA changed, the cache is reset and
# a fresh fetch cycle runs before returning, so a stale SHA never yields a
# wrong-green result. A pending verdict returned due to --wait-seconds
# exhaustion is not re-verified, since it isn't a final answer — the caller
# is expected to invoke this script again. Set CHECK_CI_DEBUG=1 to emit one
# stderr line per API request (path and received HTTP code) for diagnosing
# call counts; default is silent and stdout is never affected.

set -euo pipefail

# fd 3: a stable duplicate of the real stderr, used by _dbg_log below. Each
# api_get call site in fetch_checks (up to 3 per cycle, fewer once the
# in-invocation cache skips a call) wraps its call with `2>&1` to capture
# curl-level network-error text into the same variable as the response
# body; writing debug lines straight to fd 2 there would get merged into
# that captured body/http_code parsing instead of reaching the terminal.
# fd 3 is untouched by that local `2>&1` redirection.
exec 3>&2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq
require_cmd curl

PR_REF=""
REPO=""
WAIT_SECONDS=0
POLL_SECONDS=30
while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo) REPO="$2"; shift 2 ;;
        --wait-seconds) WAIT_SECONDS="$2"; shift 2 ;;
        --poll-seconds) POLL_SECONDS="$2"; shift 2 ;;
        -*) die_json "Unknown option: $1" 1 ;;
        *) PR_REF="$1"; shift ;;
    esac
done

[[ -n "$PR_REF" ]] || die_json "PR reference required" 1

# Validation (deterministic, before any network call — AC-6).
POLL_MIN=5
WAIT_MAX=1800
[[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || die_json "Invalid --wait-seconds: $WAIT_SECONDS. Must be an integer 0-1800" 1
[[ "$POLL_SECONDS" =~ ^[0-9]+$ ]] || die_json "Invalid --poll-seconds: $POLL_SECONDS. Must be an integer >= 5" 1
(( WAIT_SECONDS <= WAIT_MAX )) || die_json "Invalid --wait-seconds: $WAIT_SECONDS. Must be an integer 0-1800" 1
(( POLL_SECONDS >= POLL_MIN )) || die_json "Invalid --poll-seconds: $POLL_SECONDS. Must be an integer >= 5" 1

# Resolve PR_NUM / REPO from a full PR URL if given, otherwise from --repo /
# the local git remote (mirrors `gh`'s own auto-detection from cwd).
PR_NUM="$PR_REF"
if [[ "$PR_REF" =~ ^https?://github\.com/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then
    [[ -n "$REPO" ]] || REPO="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    PR_NUM="${BASH_REMATCH[3]}"
fi
[[ "$PR_NUM" =~ ^[0-9]+$ ]] || die_json "Invalid PR reference: $PR_REF. Must be a PR number or https://github.com/<owner>/<repo>/pull/<n> URL" 1

if [[ -z "$REPO" ]]; then
    origin_url="$(git config --get remote.origin.url 2>/dev/null || true)"
    # Strip a trailing .git suffix first so repo names containing dots
    # (e.g. "next.js", "my.repo" — both valid on GitHub) still match; a
    # combined "strip .git in the regex" approach mismatches those names.
    origin_url="${origin_url%.git}"
    if [[ "$origin_url" =~ github\.com[:/]+([^/]+)/([^/]+)/?$ ]]; then
        REPO="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    fi
fi
[[ -n "$REPO" ]] || die_json "Could not resolve owner/repo. Pass --repo <owner/repo> or run inside a github.com git repo" 1

AUTH_ARGS=()
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
[[ -n "$TOKEN" ]] && AUTH_ARGS=(-H "Authorization: Bearer ${TOKEN}")

if [[ -z "$TOKEN" ]]; then
    echo "check-ci: warning: GH_TOKEN/GITHUB_TOKEN not set - using unauthenticated GitHub API (60 req/hour/IP rate limit)" >&2
fi

read -r -a RETRY_DELAYS <<< "${CHECK_CI_RETRY_DELAYS:-10 30}"

# Unauthenticated requests are rate-limited at 60 req/hour/IP; see the
# in-invocation call reduction note in the header comment for the actual
# per-cycle call cost. api_get captures response headers to
# API_HEADERS_FILE so a 403/429 can be told apart from an ordinary API
# error via X-RateLimit-Remaining (see rate_limit_suffix below).
API_HEADERS_FILE="$(mktemp)"
trap 'rm -f "$API_HEADERS_FILE"' EXIT

# _api_curl - internal helper: truncates API_HEADERS_FILE, then GETs $1
# (the path passed to api_get, captured via the caller's local "$path").
# Prints curl's raw output (body + final http_code line).
_api_curl() {
    : > "$API_HEADERS_FILE"
    curl -sS -D "$API_HEADERS_FILE" -w '\n%{http_code}' \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "${AUTH_ARGS[@]}" \
        "https://api.github.com$path"
}

# _dbg_log <http-code> - CHECK_CI_DEBUG=1-gated stderr instrumentation for
# one api_get request (path taken from the caller's local "$path", same as
# _api_curl). No-op, no stdout output, unless CHECK_CI_DEBUG=1. Writes to
# fd 3 (see the `exec 3>&2` above), not fd 2, because api_get's callers
# wrap it with `2>&1` to capture curl-level errors; a plain `>&2` here
# would leak into that captured body/http_code parsing on the success path.
_dbg_log() {
    [[ "${CHECK_CI_DEBUG:-0}" == "1" ]] || return 0
    local code="$1"
    echo "check-ci-debug: GET ${path} -> ${code}" >&3
}

# api_get <path-with-query> - GETs https://api.github.com<path>, prints the
# response body followed by a final line with the HTTP status code. Returns
# non-zero only on a curl-level failure (network unreachable, DNS, etc.);
# a non-2xx HTTP response is still printed (with its status code) so the
# caller can classify it.
api_get() {
    local path="$1"
    local resp http_code body
    resp=$(_api_curl) || return $?
    http_code=$(echo "$resp" | tail -1)
    _dbg_log "$http_code"
    body=$(echo "$resp" | sed '$d')
    printf '%s\n%s\n' "$body" "$http_code"
}

# rate_limit_suffix <http_code> - on 403/429 (GitHub's rate-limit status
# codes), reads X-RateLimit-Remaining from the last api_get response headers
# and returns a distinguishing suffix (e.g. " (rate limit remaining: 0)")
# so a caller/log can tell "rate limited" apart from an ordinary API error
# instead of both surfacing as an opaque HTTP 403/429.
rate_limit_suffix() {
    local http_code="$1"
    [[ "$http_code" == "403" || "$http_code" == "429" ]] || return 0
    local remaining
    remaining=$(grep -i '^x-ratelimit-remaining:' "$API_HEADERS_FILE" 2>/dev/null | tail -1 | tr -d '\r' | awk '{print $2}')
    [[ -n "$remaining" ]] && printf ' (rate limit remaining: %s)' "$remaining"
    return 0
}

# In-invocation call reduction state (issue #463 Phase 2). Shell variables
# only, scoped to this process; never persisted to disk.
#   CACHED_SHA  - the PR's head SHA once resolved; "" means "not yet fetched".
#   STATUS_SKIP - 1 once a status fetch has reported total_count==0 (no
#                 legacy commit statuses on this commit); subsequent cycles
#                 reuse LAST_ST_BODY instead of refetching. 0 keeps fetching
#                 every cycle (a nonempty statuses[] can still change).
#   LAST_ST_BODY / LAST_CR_BODY - most recent status / check-runs response
#                 body, reused by cache-skipped cycles and by re-verify's
#                 recompute.
#   USED_CACHE  - set by fetch_checks for the cycle just run: 1 if it
#                 skipped the pulls GET and/or the status GET, 0 if it
#                 fetched everything fresh (e.g. the first cycle).
CACHED_SHA=""
STATUS_SKIP=0
LAST_ST_BODY=""
LAST_CR_BODY=""
USED_CACHE=0

# merge_checks <check-runs-body> <status-body> - merges a check-runs
# response and a legacy commit-status response into a gh-pr-checks-
# compatible array (name/state/bucket), matching the shape the rest of
# this script already knows how to reduce to a status.
merge_checks() {
    local cr_body="$1" st_body="$2"
    jq -cn --argjson cr "$cr_body" --argjson st "$st_body" '
      def cr_bucket:
        if .status != "completed" then "pending"
        elif .conclusion == "success" then "pass"
        elif (.conclusion == "neutral" or .conclusion == "skipped") then "skipping"
        else "fail"
        end;
      def st_bucket:
        if .state == "success" then "pass"
        elif .state == "pending" then "pending"
        else "fail"
        end;
      ([$cr.check_runs[]? | {name, state: (.conclusion // .status), bucket: cr_bucket}])
      + ([$st.statuses[]?  | {name: .context, state, bucket: st_bucket}])
    '
}

# fetch_checks - one fetch cycle: resolve the PR's head SHA (skipped if
# CACHED_SHA is already set), fetch check-runs (always), fetch the legacy
# commit status (skipped if STATUS_SKIP is set), then merge them via
# merge_checks. Sets FETCH_OK (0/1), CHECKS_JSON, FETCH_ERR, USED_CACHE.
fetch_checks() {
    FETCH_OK=0
    CHECKS_JSON="[]"
    FETCH_ERR=""
    USED_CACHE=0

    local sha="$CACHED_SHA"
    if [[ -z "$sha" ]]; then
        local resp http_code body
        if ! resp=$(api_get "/repos/${REPO}/pulls/${PR_NUM}" 2>&1); then
            FETCH_ERR="network error fetching PR #${PR_NUM}: $resp"
            return
        fi
        http_code=$(echo "$resp" | tail -1)
        body=$(echo "$resp" | sed '$d')
        if [[ "$http_code" != "200" ]]; then
            FETCH_ERR="GET pulls/${PR_NUM} -> HTTP $http_code$(rate_limit_suffix "$http_code"): $(echo "$body" | jq -r '.message // "unknown error"' 2>/dev/null || true)"
            return
        fi
        # `|| true`: under `set -e` the assignment inherits jq's exit status, so
        # a parse error on a non-JSON 200 body would kill the script silently
        # instead of falling into the "no head.sha" error path below.
        sha=$(echo "$body" | jq -r '.head.sha // empty' 2>/dev/null || true)
        if [[ -z "$sha" ]]; then
            FETCH_ERR="GET pulls/${PR_NUM}: response had no head.sha"
            return
        fi
        CACHED_SHA="$sha"
    else
        USED_CACHE=1
    fi

    local cr_resp cr_code cr_body
    if ! cr_resp=$(api_get "/repos/${REPO}/commits/${sha}/check-runs?per_page=100" 2>&1); then
        FETCH_ERR="network error fetching check-runs: $cr_resp"
        return
    fi
    cr_code=$(echo "$cr_resp" | tail -1)
    cr_body=$(echo "$cr_resp" | sed '$d')
    if [[ "$cr_code" != "200" ]]; then
        FETCH_ERR="GET check-runs -> HTTP $cr_code$(rate_limit_suffix "$cr_code"): $(echo "$cr_body" | jq -r '.message // "unknown error"' 2>/dev/null || true)"
        return
    fi
    # per_page=100 with no pagination follow-up: a commit with >100 check
    # runs would otherwise silently drop runs past page 1, and a failing run
    # on a dropped page would make this cycle misreport "passed" (the exact
    # wrong-green regression Test 7 guards against for API failures). Compare
    # the fetched array length against the API's total_count and fail closed
    # (status=error) instead of silently truncating.
    local cr_total cr_len
    cr_total=$(echo "$cr_body" | jq -r '.total_count // empty' 2>/dev/null || true)
    cr_len=$(echo "$cr_body" | jq -r '(.check_runs // []) | length' 2>/dev/null || true)
    if [[ ! "$cr_total" =~ ^[0-9]+$ || ! "$cr_len" =~ ^[0-9]+$ ]]; then
        FETCH_ERR="GET check-runs: response missing total_count/check_runs"
        return
    fi
    if (( cr_len != cr_total )); then
        FETCH_ERR="GET check-runs: fetched ${cr_len} of ${cr_total} check runs (>100 check runs on this commit; pagination not implemented)"
        return
    fi
    LAST_CR_BODY="$cr_body"

    local st_body
    if (( STATUS_SKIP == 1 )); then
        USED_CACHE=1
        st_body="$LAST_ST_BODY"
    else
        local st_resp st_code
        if ! st_resp=$(api_get "/repos/${REPO}/commits/${sha}/status?per_page=100" 2>&1); then
            FETCH_ERR="network error fetching commit status: $st_resp"
            return
        fi
        st_code=$(echo "$st_resp" | tail -1)
        st_body=$(echo "$st_resp" | sed '$d')
        if [[ "$st_code" != "200" ]]; then
            FETCH_ERR="GET status -> HTTP $st_code$(rate_limit_suffix "$st_code"): $(echo "$st_body" | jq -r '.message // "unknown error"' 2>/dev/null || true)"
            return
        fi
        # Same silent-truncation guard as check-runs above, for the legacy
        # combined-status statuses[] array.
        local st_total st_len
        st_total=$(echo "$st_body" | jq -r '.total_count // empty' 2>/dev/null || true)
        st_len=$(echo "$st_body" | jq -r '(.statuses // []) | length' 2>/dev/null || true)
        if [[ ! "$st_total" =~ ^[0-9]+$ || ! "$st_len" =~ ^[0-9]+$ ]]; then
            FETCH_ERR="GET status: response missing total_count/statuses"
            return
        fi
        if (( st_len != st_total )); then
            FETCH_ERR="GET status: fetched ${st_len} of ${st_total} statuses (>100 statuses on this commit; pagination not implemented)"
            return
        fi
        LAST_ST_BODY="$st_body"
        [[ "$st_total" == "0" ]] && STATUS_SKIP=1
    fi

    CHECKS_JSON=$(merge_checks "$cr_body" "$st_body") || { FETCH_ERR="failed to merge check-runs/status responses"; return; }
    FETCH_OK=1
}

# compute_verdict - reduces $CHECKS_JSON to $result_json / $status.
# bucket field values: pass | fail | pending | skipping
# is_passed:  bucket IN("pass", "skipping")   — completed successfully or intentionally skipped
# is_failed:  bucket IN("fail", "cancel")     — failed or cancelled
# is_pending: bucket == "pending"             — still running
compute_verdict() {
    result_json=$(echo "$CHECKS_JSON" | jq -c '
      def is_passed:  .bucket | IN("pass", "skipping");
      def is_failed:  .bucket | IN("fail", "cancel");
      def is_pending: .bucket == "pending";

      if length == 0 then
        {status: "no_checks", passed: 0, failed: 0, pending: 0, skipped: 0,
         failed_checks: [], pending_checks: []}
      else
        {
          passed:  ([.[] | select(is_passed)]  | length),
          failed:  ([.[] | select(is_failed)]  | length),
          pending: ([.[] | select(is_pending)] | length),
          skipped: ([.[] | select(.bucket == "skipping")] | length),
          failed_checks:  [.[] | select(is_failed)  | {name, bucket, state}],
          pending_checks: [.[] | select(is_pending) | {name, state}]
        } |
        . + {
          status: (if .failed > 0 then "failed"
                   elif .pending > 0 then "pending"
                   else "passed" end)
        }
      end
    ')
    status=$(echo "$result_json" | jq -r '.status')
}

# do_fetch_cycle - runs fetch_checks with the retry/backoff policy, counts
# it as one poll attempt, and on persistent failure emits the {status:
# "error"} JSON and exits 1 (fail-closed, same contract as before).
do_fetch_cycle() {
    local attempt=0
    while :; do
        fetch_checks
        (( FETCH_OK == 1 )) && break
        if (( attempt >= ${#RETRY_DELAYS[@]} )); then break; fi
        echo "check-ci: fetch failed, retry $((attempt + 1))/${#RETRY_DELAYS[@]} in ${RETRY_DELAYS[$attempt]}s: $FETCH_ERR" >&2
        sleep "${RETRY_DELAYS[$attempt]}"
        attempt=$((attempt + 1))
    done
    POLL_ATTEMPTS=$((POLL_ATTEMPTS + 1))

    if (( FETCH_OK != 1 )); then
        printf '{"status":"error","message":%s,"waited_seconds":%s,"poll_attempts":%s}\n' \
            "$(printf '%s' "$FETCH_ERR" | jq -Rs '.')" "$WAITED" "$POLL_ATTEMPTS"
        exit 1
    fi
}

# reverify_terminal - called right before returning a non-pending verdict
# that was produced by a cycle which used the in-invocation cache (skipped
# pulls and/or status), to catch a head SHA or status change that happened
# mid-poll. Re-fetches pulls once (retried on API error, fail-closed same
# as do_fetch_cycle). Sets REVERIFY_STATUS to:
#   "confirmed" - same head SHA. If STATUS_SKIP was 1, status is refetched
#     once and $result_json/$status are recomputed against it; otherwise
#     the existing $result_json/$status stand as-is.
#   "resha" - the head SHA changed. CACHED_SHA/STATUS_SKIP/LAST_ST_BODY are
#     reset; the caller must run a fresh fetch cycle (do_fetch_cycle) on
#     the new SHA and use its verdict instead.
reverify_terminal() {
    local attempt=0 sha=""
    while :; do
        local resp http_code body
        if resp=$(api_get "/repos/${REPO}/pulls/${PR_NUM}" 2>&1); then
            http_code=$(echo "$resp" | tail -1)
            body=$(echo "$resp" | sed '$d')
            if [[ "$http_code" == "200" ]]; then
                sha=$(echo "$body" | jq -r '.head.sha // empty' 2>/dev/null || true)
                if [[ -n "$sha" ]]; then
                    break
                fi
                FETCH_ERR="GET pulls/${PR_NUM}: response had no head.sha"
            else
                FETCH_ERR="GET pulls/${PR_NUM} -> HTTP $http_code$(rate_limit_suffix "$http_code"): $(echo "$body" | jq -r '.message // "unknown error"' 2>/dev/null || true)"
            fi
        else
            FETCH_ERR="network error fetching PR #${PR_NUM}: $resp"
        fi
        if (( attempt >= ${#RETRY_DELAYS[@]} )); then
            printf '{"status":"error","message":%s,"waited_seconds":%s,"poll_attempts":%s}\n' \
                "$(printf '%s' "$FETCH_ERR" | jq -Rs '.')" "$WAITED" "$POLL_ATTEMPTS"
            exit 1
        fi
        echo "check-ci: fetch failed, retry $((attempt + 1))/${#RETRY_DELAYS[@]} in ${RETRY_DELAYS[$attempt]}s: $FETCH_ERR" >&2
        sleep "${RETRY_DELAYS[$attempt]}"
        attempt=$((attempt + 1))
    done

    if [[ "$sha" != "$CACHED_SHA" ]]; then
        CACHED_SHA="$sha"
        STATUS_SKIP=0
        LAST_ST_BODY=""
        REVERIFY_STATUS="resha"
        return
    fi

    if (( STATUS_SKIP == 1 )); then
        local st_attempt=0 st_body st_code
        while :; do
            local st_resp
            if st_resp=$(api_get "/repos/${REPO}/commits/${sha}/status?per_page=100" 2>&1); then
                st_code=$(echo "$st_resp" | tail -1)
                st_body=$(echo "$st_resp" | sed '$d')
                if [[ "$st_code" == "200" ]]; then
                    local st_total st_len
                    st_total=$(echo "$st_body" | jq -r '.total_count // empty' 2>/dev/null || true)
                    st_len=$(echo "$st_body" | jq -r '(.statuses // []) | length' 2>/dev/null || true)
                    if [[ "$st_total" =~ ^[0-9]+$ && "$st_len" =~ ^[0-9]+$ && "$st_len" == "$st_total" ]]; then
                        break
                    fi
                    FETCH_ERR="GET status: response missing total_count/statuses, or fetched ${st_len:-0} of ${st_total:-0} statuses"
                else
                    FETCH_ERR="GET status -> HTTP $st_code$(rate_limit_suffix "$st_code"): $(echo "$st_body" | jq -r '.message // "unknown error"' 2>/dev/null || true)"
                fi
            else
                FETCH_ERR="network error fetching commit status: $st_resp"
            fi
            if (( st_attempt >= ${#RETRY_DELAYS[@]} )); then
                printf '{"status":"error","message":%s,"waited_seconds":%s,"poll_attempts":%s}\n' \
                    "$(printf '%s' "$FETCH_ERR" | jq -Rs '.')" "$WAITED" "$POLL_ATTEMPTS"
                exit 1
            fi
            echo "check-ci: fetch failed, retry $((st_attempt + 1))/${#RETRY_DELAYS[@]} in ${RETRY_DELAYS[$st_attempt]}s: $FETCH_ERR" >&2
            sleep "${RETRY_DELAYS[$st_attempt]}"
            st_attempt=$((st_attempt + 1))
        done
        LAST_ST_BODY="$st_body"
        local st_total
        st_total=$(echo "$st_body" | jq -r '.total_count // empty')
        STATUS_SKIP=0
        [[ "$st_total" == "0" ]] && STATUS_SKIP=1
        CHECKS_JSON=$(merge_checks "$LAST_CR_BODY" "$st_body")
        compute_verdict
    fi

    REVERIFY_STATUS="confirmed"
}

# maybe_wait_or_break - if $status is "pending" and wait budget remains,
# sleeps and returns 0 (caller should `continue` the poll loop). Returns 1
# (caller should `break`) if $status is not "pending", or if no wait
# budget remains.
maybe_wait_or_break() {
    [[ "$status" == "pending" ]] || return 1
    (( WAIT_SECONDS == 0 )) && return 1
    local remaining=$((WAIT_SECONDS - WAITED))
    (( remaining <= 0 )) && return 1
    local sleep_for=$(( remaining < POLL_SECONDS ? remaining : POLL_SECONDS ))
    echo "check-ci: CI pending - sleeping ${sleep_for}s (waited ${WAITED}/${WAIT_SECONDS}s, poll ${POLL_ATTEMPTS})" >&2
    sleep "$sleep_for"
    WAITED=$((WAITED + sleep_for))
    return 0
}

WAITED=0
POLL_ATTEMPTS=0
result_json=""
status=""
REVERIFY_STATUS=""

while :; do
    do_fetch_cycle
    compute_verdict

    if [[ "$status" != "pending" && "$USED_CACHE" == "1" ]]; then
        reverify_terminal
        if [[ "$REVERIFY_STATUS" == "resha" ]]; then
            # Head SHA changed since the cache was populated: the cached
            # verdict is stale. Run a fresh fetch cycle on the new SHA and
            # use its verdict instead. USED_CACHE is forced 0 afterward so
            # this fresh cycle's terminal verdict (if any) is not
            # re-verified again — its SHA was just confirmed above.
            do_fetch_cycle
            USED_CACHE=0
            compute_verdict
        fi
    fi

    maybe_wait_or_break && continue
    break
done

echo "$result_json" | jq -c --argjson w "$WAITED" --argjson p "$POLL_ATTEMPTS" '. + {waited_seconds:$w, poll_attempts:$p}'
