#!/usr/bin/env bash
# check-ci.sh - Query PR CI status with pending vs failure disambiguation.
# Usage: check-ci.sh <pr-number-or-url> [--repo <owner/repo>]
#                     [--wait-seconds N] [--poll-seconds M]
#
# Exits 0 when CI status is determined (passed/failed/pending/no_checks).
# Exits 1 when gh API fails with a real error (auth, network, unknown field)
# or when --wait-seconds/--poll-seconds validation fails.
# CI state is reported via stdout JSON so the caller can treat pending != failure.
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
# gh bucket field values (gh help pr checks):
#   pass | fail | pending | skipping | cancel
# gh exit codes:
#   0  = all checks complete (passed or failed)
#   8  = checks still pending
#   1  = real API error (auth, network, unknown JSON field, etc.)
# Transient gh API errors (exit code other than 0/8) are retried with backoff
# within each poll cycle. Max retries = number of delay entries in
# CHECK_CI_RETRY_DELAYS (default 10s/30s). The retry budget resets every poll
# cycle and is independent from the --wait-seconds wait budget (AC-4):
# API-error retries never consume waited_seconds.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq
require_cmd gh

PR_REF=""
REPO_FLAG=()
WAIT_SECONDS=0
POLL_SECONDS=30
while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo) REPO_FLAG=(--repo "$2"); shift 2 ;;
        --wait-seconds) WAIT_SECONDS="$2"; shift 2 ;;
        --poll-seconds) POLL_SECONDS="$2"; shift 2 ;;
        -*) die_json "Unknown option: $1" 1 ;;
        *) PR_REF="$1"; shift ;;
    esac
done

[[ -n "$PR_REF" ]] || die_json "PR reference required" 1

# Validation (deterministic, before any gh call — AC-6).
POLL_MIN=5
WAIT_MAX=1800
[[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || die_json "Invalid --wait-seconds: $WAIT_SECONDS. Must be an integer 0-1800" 1
[[ "$POLL_SECONDS" =~ ^[0-9]+$ ]] || die_json "Invalid --poll-seconds: $POLL_SECONDS. Must be an integer >= 5" 1
(( WAIT_SECONDS <= WAIT_MAX )) || die_json "Invalid --wait-seconds: $WAIT_SECONDS. Must be an integer 0-1800" 1
(( POLL_SECONDS >= POLL_MIN )) || die_json "Invalid --poll-seconds: $POLL_SECONDS. Must be an integer >= 5" 1

# Capture gh output and exit code explicitly.
# gh exits 0 for complete checks, 8 for pending, 1 for real errors.
# We allow exit 0 and 8; anything else is retried then surfaced as {"status":"error"}.
# Transient gh API errors (exit code other than 0/8) are retried with backoff.
# Max retries = number of delay entries. Tests override via CHECK_CI_RETRY_DELAYS.
read -r -a RETRY_DELAYS <<< "${CHECK_CI_RETRY_DELAYS:-10 30}"

WAITED=0
POLL_ATTEMPTS=0
checks_json=""
gh_exit=0
result_json=""
status=""
no_checks_detected=0

while :; do
    gh_stderr_file=$(mktemp)
    attempt=0
    while :; do
        gh_exit=0
        checks_json=$(gh pr checks "$PR_REF" "${REPO_FLAG[@]}" --json name,state,bucket 2>"$gh_stderr_file") || gh_exit=$?
        # exit 0 = checks complete, 8 = pending: both determinate -> NEVER retry
        if [[ $gh_exit -eq 0 || $gh_exit -eq 8 ]]; then
            break
        fi
        # gh exits 1 (NOT 0) with "no checks reported on the '<branch>' branch" when the
        # PR has zero checks (CI not configured / not yet triggered). Real gh never emits
        # an empty JSON array with exit 0 for this case, so the length==0 jq branch below
        # is unreachable in practice — this is where the "no checks" state actually lands.
        # It is determinate, NOT a transient API error: stop, do not retry, report no_checks.
        if [[ $gh_exit -eq 1 ]] && grep -qi 'no checks reported' "$gh_stderr_file"; then
            no_checks_detected=1
            break
        fi
        if (( attempt >= ${#RETRY_DELAYS[@]} )); then
            break
        fi
        echo "check-ci: gh pr checks failed (exit $gh_exit), retry $((attempt + 1))/${#RETRY_DELAYS[@]} in ${RETRY_DELAYS[$attempt]}s: $(cat "$gh_stderr_file")" >&2
        sleep "${RETRY_DELAYS[$attempt]}"
        attempt=$((attempt + 1))
    done
    gh_stderr=$(cat "$gh_stderr_file")
    rm -f "$gh_stderr_file"
    POLL_ATTEMPTS=$((POLL_ATTEMPTS + 1))

    # PR has zero checks (gh exit 1 + "no checks reported"): determinate no_checks,
    # nothing to poll for — stop and report with exit 0.
    if [[ $no_checks_detected -eq 1 ]]; then
        result_json='{"status":"no_checks","passed":0,"failed":0,"pending":0,"skipped":0,"failed_checks":[],"pending_checks":[]}'
        break
    fi

    # exit 1 = real API error (auth failure, network error, unknown field, etc.)
    if [[ $gh_exit -ne 0 && $gh_exit -ne 8 ]]; then
        printf '{"status":"error","message":%s,"waited_seconds":%s,"poll_attempts":%s}\n' \
            "$(printf '%s' "$gh_stderr" | jq -Rs '.')" "$WAITED" "$POLL_ATTEMPTS"
        exit 1
    fi

    # bucket field values: pass | fail | pending | skipping | cancel
    # is_passed:  bucket IN("pass", "skipping")   — completed successfully or intentionally skipped
    # is_failed:  bucket IN("fail", "cancel")     — failed or cancelled
    # is_pending: bucket == "pending"             — still running
    result_json=$(echo "$checks_json" | jq -c '
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
