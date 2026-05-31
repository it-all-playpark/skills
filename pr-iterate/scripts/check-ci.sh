#!/usr/bin/env bash
# check-ci.sh - Query PR CI status with pending vs failure disambiguation.
# Usage: check-ci.sh <pr-number-or-url> [--repo <owner/repo>]
#
# Exits 0 when CI status is determined (passed/failed/pending/no_checks).
# Exits 1 when gh API fails with a real error (auth, network, unknown field).
# CI state is reported via stdout JSON so the caller can treat pending != failure.
#
# Output JSON:
#   { "status": "passed" | "failed" | "pending" | "no_checks" | "error",
#     "passed": N, "failed": N, "pending": N, "skipped": N,
#     "failed_checks": [...], "pending_checks": [...] }
#
# gh bucket field values (gh help pr checks):
#   pass | fail | pending | skipping | cancel
# gh exit codes:
#   0  = all checks complete (passed or failed)
#   8  = checks still pending
#   1  = real API error (auth, network, unknown JSON field, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq
require_cmd gh

PR_REF=""
REPO_FLAG=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo) REPO_FLAG=(--repo "$2"); shift 2 ;;
        -*) die_json "Unknown option: $1" 1 ;;
        *) PR_REF="$1"; shift ;;
    esac
done

[[ -n "$PR_REF" ]] || die_json "PR reference required" 1

# Capture gh output and exit code explicitly.
# gh exits 0 for complete checks, 8 for pending, 1 for real errors.
# We allow exit 0 and 8; anything else is surfaced as {"status":"error"}.
gh_stderr_file=$(mktemp)
checks_json=""
gh_exit=0
checks_json=$(gh pr checks "$PR_REF" "${REPO_FLAG[@]}" --json name,state,bucket 2>"$gh_stderr_file") || gh_exit=$?
gh_stderr=$(cat "$gh_stderr_file")
rm -f "$gh_stderr_file"

# exit 1 = real API error (auth failure, network error, unknown field, etc.)
if [[ $gh_exit -ne 0 && $gh_exit -ne 8 ]]; then
    printf '{"status":"error","message":%s}\n' "$(printf '%s' "$gh_stderr" | jq -Rs '.')"
    exit 1
fi

# bucket field values: pass | fail | pending | skipping | cancel
# is_passed:  bucket IN("pass", "skipping")   — completed successfully or intentionally skipped
# is_failed:  bucket IN("fail", "cancel")     — failed or cancelled
# is_pending: bucket == "pending"             — still running
echo "$checks_json" | jq -c '
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
'
