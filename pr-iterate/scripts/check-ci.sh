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
# normal dev-flow run volume; each fetch cycle costs 3 API calls).
#
# Transient failures (network error, non-2xx HTTP response from any of the
# 3 API calls a fetch cycle makes) are retried with backoff within each poll
# cycle. Max retries = number of delay entries in CHECK_CI_RETRY_DELAYS
# (default 10s/30s). The retry budget resets every poll cycle and is
# independent from the --wait-seconds wait budget (AC-4): API-error retries
# never consume waited_seconds.

set -euo pipefail

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

read -r -a RETRY_DELAYS <<< "${CHECK_CI_RETRY_DELAYS:-10 30}"

# Unauthenticated requests are rate-limited at 60 req/hour/IP; each fetch
# cycle costs 3 calls, so this can be exhausted well inside pr-iterate's
# iteration budget. api_get captures response headers to API_HEADERS_FILE
# so a 403/429 can be told apart from an ordinary API error via
# X-RateLimit-Remaining (see rate_limit_suffix below).
API_HEADERS_FILE="$(mktemp)"
trap 'rm -f "$API_HEADERS_FILE"' EXIT

# api_get <path-with-query> - GETs https://api.github.com<path>, prints the
# response body followed by a final line with the HTTP status code. Returns
# non-zero only on a curl-level failure (network unreachable, DNS, etc.);
# a non-2xx HTTP response is still printed (with its status code) so the
# caller can classify it.
api_get() {
    curl -sS -D "$API_HEADERS_FILE" -w '\n%{http_code}' \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "${AUTH_ARGS[@]}" \
        "https://api.github.com$1"
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

# fetch_checks - one fetch cycle: resolve the PR's head SHA, then fetch
# check-runs + legacy commit statuses for that SHA and merge them into a
# gh-pr-checks-compatible array (name/state/bucket), matching the shape the
# rest of this script (unchanged from the `gh`-based version) already knows
# how to reduce to a status. Sets FETCH_OK (0/1), CHECKS_JSON, FETCH_ERR.
fetch_checks() {
    FETCH_OK=0
    CHECKS_JSON="[]"
    FETCH_ERR=""

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
    local sha
    # `|| true`: under `set -e` the assignment inherits jq's exit status, so a
    # parse error on a non-JSON 200 body would kill the script silently instead
    # of falling through to the "no head.sha" error path below.
    sha=$(echo "$body" | jq -r '.head.sha // empty' 2>/dev/null || true)
    if [[ -z "$sha" ]]; then
        FETCH_ERR="GET pulls/${PR_NUM}: response had no head.sha"
        return
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

    local st_resp st_code st_body
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

    CHECKS_JSON=$(jq -cn --argjson cr "$cr_body" --argjson st "$st_body" '
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
    ') || { FETCH_ERR="failed to merge check-runs/status responses"; return; }
    FETCH_OK=1
}

WAITED=0
POLL_ATTEMPTS=0
result_json=""
status=""

while :; do
    attempt=0
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

    # bucket field values: pass | fail | pending | skipping
    # is_passed:  bucket IN("pass", "skipping")   — completed successfully or intentionally skipped
    # is_failed:  bucket IN("fail", "cancel")     — failed or cancelled
    # is_pending: bucket == "pending"             — still running
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

    [[ "$status" == "pending" ]] || break

    (( WAIT_SECONDS == 0 )) && break

    remaining=$((WAIT_SECONDS - WAITED))
    (( remaining <= 0 )) && break

    sleep_for=$(( remaining < POLL_SECONDS ? remaining : POLL_SECONDS ))
    echo "check-ci: CI pending - sleeping ${sleep_for}s (waited ${WAITED}/${WAIT_SECONDS}s, poll ${POLL_ATTEMPTS})" >&2
    sleep "$sleep_for"
    WAITED=$((WAITED + sleep_for))
done

echo "$result_json" | jq -c --argjson w "$WAITED" --argjson p "$POLL_ATTEMPTS" '. + {waited_seconds:$w, poll_attempts:$p}'
