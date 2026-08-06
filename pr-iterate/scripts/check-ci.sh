#!/usr/bin/env bash
# check-ci.sh - Query PR CI status with pending vs failure disambiguation.
# Usage: check-ci.sh <pr-number-or-url> [--repo <owner/repo>]
#                     [--wait-seconds N] [--poll-seconds M]
#
# Exits 0 when CI status is determined (passed/failed/pending/no_checks).
# Exits 1 when `gh` fails with a real error (auth, network, unknown
# repo/PR) or when --wait-seconds/--poll-seconds validation fails.
# CI state is reported via stdout JSON so the caller can treat pending != failure.
#
# issue #488: CI state is fetched via `gh pr checks --json name,state,bucket`
# instead of the previous approach (hand-assembling GitHub REST responses
# from the pulls / check-runs / status endpoints, authenticated only via a
# GH_TOKEN/GITHUB_TOKEN env var). An unauthenticated GET against a private
# repo returns HTTP 404 (GitHub hides the existence of resources the caller
# can't see), which made every run against a private repo misreport
# status=error regardless of actual CI state. Delegating the fetch to `gh`
# lets it authenticate from its own credential store instead, so private
# repo CI state is read correctly with no extra configuration.
#
# Verdict derivation is a pure function of the `bucket` field in
# `gh pr checks --json ...`'s output (pass/fail/pending/skipping/cancel);
# `cancel` is folded into "failed" (fail-closed) and `skipping` is folded
# into "passed" (+ a separate skipped count). Any bucket value outside this
# known 5-value vocabulary is also folded into "failed" (fail-closed): if
# `gh` ever emits a new bucket, an unrecognized value must never fall
# through the passed/failed/pending partition uncounted and let the
# `else -> "passed"` default paper over it (that would be wrong-green). The
# verdict is never derived
# from gh's own exit code: `gh pr checks` exits 8 while checks are pending
# and exits 1 when any check has failed, so treating a non-zero exit code
# as a fetch failure would misclassify pending/failed runs as "error" (the
# bug class fixed by c7ada02). A fetch cycle is only treated as failed when
# stdout does not parse as a JSON array and stderr does not indicate there
# were no checks to report.
#
# --wait-seconds N (default 0): total seconds to keep polling while CI is
#   pending, in bounded increments of --poll-seconds. 0 = no polling
#   (single fetch, current/legacy behavior). Must be an integer 0-1800.
# --poll-seconds M (default 30): sleep interval between polls while pending.
#   Must be an integer >= 5. Validated even when --wait-seconds is 0.
# Each poll cycle issues exactly one `gh pr checks` call. `--watch` (gh's
# own unbounded blocking wait) is intentionally not used: it would hand the
# wait ceiling to gh and break the waited_seconds/poll_attempts bounded-wait
# contract this script reports back to its caller.
#
# Output JSON:
#   { "status": "passed" | "failed" | "pending" | "no_checks" | "error",
#     "passed": N, "failed": N, "pending": N, "skipped": N,
#     "failed_checks": [...], "pending_checks": [...],
#     "waited_seconds": N, "poll_attempts": N,
#     "epoch": N | null }
#
# "epoch" is `date +%s` taken immediately before the JSON is emitted (present
# on every status, including "error"). If `date +%s` fails, epoch is emitted
# as JSON null instead of failing the script (fail-open; exit code and every
# other key are unaffected).
#
# Transient failures (a `gh pr checks` invocation whose stdout is not a
# valid JSON array and whose stderr does not indicate "no checks reported")
# are retried with backoff within each poll cycle. Max retries = number of
# delay entries in CHECK_CI_RETRY_DELAYS (default 10s/30s). The retry budget
# resets every poll cycle and is independent from the --wait-seconds wait
# budget (AC-4): fetch-error retries never consume waited_seconds.
#
# Set CHECK_CI_DEBUG=1 to emit one stderr line per `gh pr checks` invocation
# (its exit code) for diagnosing fetch behavior; default is silent and
# stdout is never affected.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq
require_cmd gh

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

read -r -a RETRY_DELAYS <<< "${CHECK_CI_RETRY_DELAYS:-10 30}"

# epoch_field - prints the current `date +%s` as a bare JSON number, or the
# JSON literal `null` if `date +%s` fails. Called once per JSON emission site
# (never cached), so its output can be spliced directly into printf/jq output
# without further quoting: both a digit string and the literal `null` are
# valid unquoted JSON.
epoch_field() {
    local e
    e=$(date +%s 2>/dev/null) || true
    if [[ "$e" =~ ^[0-9]+$ ]]; then
        printf '%s' "$e"
    else
        printf 'null'
    fi
}

# fetch_checks - one fetch cycle: a single `gh pr checks --json
# name,state,bucket` call. Sets FETCH_OK (0/1), CHECKS_JSON, FETCH_ERR.
fetch_checks() {
    FETCH_OK=0
    CHECKS_JSON="[]"
    FETCH_ERR=""
    local rc=0 out err_file err
    err_file="$(mktemp)"
    out=$(gh pr checks "$PR_NUM" --repo "$REPO" --json name,state,bucket 2>"$err_file") || rc=$?
    err="$(cat "$err_file" 2>/dev/null || true)"
    rm -f "$err_file"
    if [[ "${CHECK_CI_DEBUG:-0}" == "1" ]]; then
        echo "check-ci-debug: gh pr checks -> exit ${rc}" >&2
    fi
    # verdict is derived from the bucket JSON only; gh's own exit code is
    # never used to decide fetch success (see the header comment: exit 8 =
    # pending, exit 1 = a check failed, neither is a fetch error).
    if echo "$out" | jq -e 'type == "array"' >/dev/null 2>&1; then
        CHECKS_JSON="$out"
        FETCH_OK=1
        return
    fi
    if echo "$err" | grep -qi 'no checks reported'; then
        CHECKS_JSON="[]"
        FETCH_OK=1
        return
    fi
    FETCH_ERR="gh pr checks (exit ${rc}): $(echo "$err" | head -3 | tr '\n' ' ')"
}

# compute_verdict - reduces $CHECKS_JSON to $result_json / $status.
# bucket field values: pass | fail | pending | skipping | cancel
# is_passed:  bucket IN("pass", "skipping")   — completed successfully or intentionally skipped
# is_pending: bucket == "pending"             — still running
# is_failed:  bucket IN("fail", "cancel") OR bucket outside the known
#             5-value vocabulary — failed, cancelled, or unrecognized
#             (fail-closed: an unknown bucket must count as failed, not
#             silently drop out of every count and let the "no failed, no
#             pending -> passed" default misreport it as green).
compute_verdict() {
    result_json=$(echo "$CHECKS_JSON" | jq -c '
      def is_passed:  .bucket | IN("pass", "skipping");
      def is_pending: .bucket == "pending";
      def is_known:   .bucket | IN("pass", "fail", "pending", "skipping", "cancel");
      def is_failed:  (.bucket | IN("fail", "cancel")) or (is_known | not);

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
        printf '{"status":"error","message":%s,"waited_seconds":%s,"poll_attempts":%s,"epoch":%s}\n' \
            "$(printf '%s' "$FETCH_ERR" | jq -Rs '.')" "$WAITED" "$POLL_ATTEMPTS" "$(epoch_field)"
        exit 1
    fi
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

while :; do
    do_fetch_cycle
    compute_verdict
    maybe_wait_or_break && continue
    break
done

echo "$result_json" | jq -c --argjson w "$WAITED" --argjson p "$POLL_ATTEMPTS" --argjson e "$(epoch_field)" '. + {waited_seconds:$w, poll_attempts:$p, epoch:$e}'
