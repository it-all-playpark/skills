#!/usr/bin/env bash
set -euo pipefail

# validate-canary-report.sh - Validate a dev-flow-canary report JSON (schema v1.0.0)
#
# Usage: validate-canary-report.sh <report.json>
#
# canary report schema (canonical, shared with dev-flow-canary workflow):
#   {
#     "canary_version": "1.0.0",
#     "claude_code_version": "<string|'unknown'>",
#     "timestamp_utc": "<ISO8601|'unknown'>",
#     "capabilities": [ {"id": "<id>", "status": "pass|fail|unsupported", "detail": "<string>"} ],
#     "bridge_sunset": {"exec_proxy_removable": bool, "inline_generator_removable": bool,
#                        "verdict": "keep-bridges|reevaluate-bridges", "note": "<string>"},
#     "report_path": "<string|null>"
#   }
#
# capabilities の id は正確に次の 9 個 (過不足・未知 id は schema violation):
#   agent_schema, model_routing, effort_routing, parallel_fanout, nested_workflow,
#   pause_resume, direct_fs, direct_shell, direct_import
#
# Exit 0: valid. Summary JSON on stdout:
#   {"ok":true,"canary_version":...,"claude_code_version":...,
#    "counts":{"pass":N,"fail":N,"unsupported":N},
#    "failed_ids":[...],"unsupported_ids":[...],"bridge_sunset":{...}}
# Exit 2: invalid. {"ok":false,"error":"<reason>"} on stdout.
#
# canary_version is a const ("1.0.0") — no legacy fallback / version branching
# is accepted (repo convention: 後方互換 scaffolding を作らない).

SCRIPT_DIR_VCR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR_VCR/../../_lib/common.sh"

EXPECTED_CAPABILITY_IDS='["agent_schema","model_routing","effort_routing","parallel_fanout","nested_workflow","pause_resume","direct_fs","direct_shell","direct_import"]'

# Emit {"ok":false,"error":...} to stdout and exit 2 (invalid report — distinct
# from die_json's stderr + arbitrary exit code, per this script's contract).
fail() {
  local msg="$1"
  jq -n --arg err "$msg" '{ok: false, error: $err}'
  exit 2
}

if [[ $# -lt 1 ]]; then
  jq -n '{ok: false, error: "usage: validate-canary-report.sh <report.json>"}'
  exit 2
fi

REPORT_PATH="$1"

require_cmd "jq" "jq is required for validate-canary-report.sh"

if [[ ! -f "$REPORT_PATH" ]]; then
  fail "report file not found: ${REPORT_PATH}"
fi

if ! jq empty "$REPORT_PATH" >/dev/null 2>&1; then
  fail "report file is not valid JSON: ${REPORT_PATH}"
fi

REPORT="$(cat "$REPORT_PATH")"

if ! echo "$REPORT" | jq -e 'type == "object"' >/dev/null 2>&1; then
  fail "report must be a JSON object"
fi

# Required top-level keys
for key in canary_version claude_code_version capabilities bridge_sunset; do
  if ! echo "$REPORT" | jq -e --arg k "$key" 'has($k)' >/dev/null 2>&1; then
    fail "missing required key: ${key}"
  fi
done

# canary_version const check (no backward-compat fallback)
CANARY_VERSION="$(echo "$REPORT" | jq -r '.canary_version')"
if [[ "$CANARY_VERSION" != "1.0.0" ]]; then
  fail "unsupported canary_version: ${CANARY_VERSION} (must be exactly \"1.0.0\")"
fi

# capabilities must be an array
if ! echo "$REPORT" | jq -e '.capabilities | type == "array"' >/dev/null 2>&1; then
  fail "capabilities must be an array"
fi

# capability id set must match exactly the 9 expected ids (no more, no fewer, no unknown)
ACTUAL_IDS_SORTED="$(echo "$REPORT" | jq -c '[.capabilities[].id] | sort')"
EXPECTED_IDS_SORTED="$(echo "$EXPECTED_CAPABILITY_IDS" | jq -c 'sort')"
if [[ "$ACTUAL_IDS_SORTED" != "$EXPECTED_IDS_SORTED" ]]; then
  fail "capabilities id set mismatch (expected exactly these 9: agent_schema, model_routing, effort_routing, parallel_fanout, nested_workflow, pause_resume, direct_fs, direct_shell, direct_import)"
fi

# capability.status enum check
BAD_STATUS_COUNT="$(echo "$REPORT" | jq '[.capabilities[] | select(.status != "pass" and .status != "fail" and .status != "unsupported")] | length')"
if [[ "$BAD_STATUS_COUNT" -gt 0 ]]; then
  fail "one or more capabilities have invalid status (must be pass|fail|unsupported)"
fi

# bridge_sunset.verdict enum check
VERDICT="$(echo "$REPORT" | jq -r '.bridge_sunset.verdict // empty')"
if [[ "$VERDICT" != "keep-bridges" && "$VERDICT" != "reevaluate-bridges" ]]; then
  fail "invalid bridge_sunset.verdict: ${VERDICT:-<missing>} (must be keep-bridges|reevaluate-bridges)"
fi

# ---- Build summary ----
CLAUDE_CODE_VERSION="$(echo "$REPORT" | jq -r '.claude_code_version')"
PASS_COUNT="$(echo "$REPORT" | jq '[.capabilities[] | select(.status == "pass")] | length')"
FAIL_COUNT="$(echo "$REPORT" | jq '[.capabilities[] | select(.status == "fail")] | length')"
UNSUPPORTED_COUNT="$(echo "$REPORT" | jq '[.capabilities[] | select(.status == "unsupported")] | length')"
FAILED_IDS="$(echo "$REPORT" | jq -c '[.capabilities[] | select(.status == "fail") | .id]')"
UNSUPPORTED_IDS="$(echo "$REPORT" | jq -c '[.capabilities[] | select(.status == "unsupported") | .id]')"
BRIDGE_SUNSET="$(echo "$REPORT" | jq -c '.bridge_sunset')"

jq -n \
  --arg canary_version "$CANARY_VERSION" \
  --arg ccv "$CLAUDE_CODE_VERSION" \
  --argjson pass "$PASS_COUNT" \
  --argjson fail "$FAIL_COUNT" \
  --argjson unsupported "$UNSUPPORTED_COUNT" \
  --argjson failed_ids "$FAILED_IDS" \
  --argjson unsupported_ids "$UNSUPPORTED_IDS" \
  --argjson bridge_sunset "$BRIDGE_SUNSET" \
  '{
    ok: true,
    canary_version: $canary_version,
    claude_code_version: $ccv,
    counts: {pass: $pass, fail: $fail, unsupported: $unsupported},
    failed_ids: $failed_ids,
    unsupported_ids: $unsupported_ids,
    bridge_sunset: $bridge_sunset
  }'

exit 0
