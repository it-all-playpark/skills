#!/usr/bin/env bash
# check-ci.sh - Query PR CI status with pending vs failure disambiguation.
# Usage: check-ci.sh <pr-number-or-url> [--repo <owner/repo>]
#
# Always exits 0 unless the gh API itself errors. CI state is reported via
# stdout JSON so the caller can treat pending != failure.
#
# Output JSON:
#   { "status": "passed" | "failed" | "pending" | "no_checks",
#     "passed": N, "failed": N, "pending": N, "skipped": N,
#     "failed_checks": [...], "pending_checks": [...] }

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

# gh pr checks --json never sets a non-zero exit for pending (only for API
# errors), so we can capture without `|| true`. If the API fails entirely,
# the script propagates the error.
checks_json=$(gh pr checks "$PR_REF" "${REPO_FLAG[@]}" --json name,state,conclusion 2>/dev/null || echo "[]")

# State / conclusion mapping (GitHub Checks API):
#   conclusion: "SUCCESS" | "FAILURE" | "CANCELLED" | "SKIPPED" | "NEUTRAL" | "TIMED_OUT" | "ACTION_REQUIRED" | null
#   state:      "PENDING" | "COMPLETED" | "IN_PROGRESS" | ...
# Treat null conclusion + non-COMPLETED state as pending.
echo "$checks_json" | jq -c '
  def is_pending: (.conclusion // "") == "" and ((.state // "") != "COMPLETED");
  def is_passed:  (.conclusion // "") | ascii_upcase | IN("SUCCESS", "NEUTRAL", "SKIPPED");
  def is_failed:  (.conclusion // "") | ascii_upcase | IN("FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED");

  if length == 0 then
    {status: "no_checks", passed: 0, failed: 0, pending: 0, skipped: 0,
     failed_checks: [], pending_checks: []}
  else
    {
      passed:  ([.[] | select(is_passed)]  | length),
      failed:  ([.[] | select(is_failed)]  | length),
      pending: ([.[] | select(is_pending)] | length),
      skipped: ([.[] | select(.conclusion == "SKIPPED")] | length),
      failed_checks:  [.[] | select(is_failed)  | {name, conclusion}],
      pending_checks: [.[] | select(is_pending) | {name, state}]
    } |
    . + {
      status: (if .failed > 0 then "failed"
               elif .pending > 0 then "pending"
               else "passed" end)
    }
  end
'
