#!/usr/bin/env bash
# ab-metrics.sh - Aggregate pr-iterate AB (single vs multi review mode)
# comparison run results into a markdown report.
#
# Usage: ab-metrics.sh [dir]
#   dir defaults to $HOME/.claude/journal/ab-runs.
#   (NOT ~/.claude/journal/pending - that is an ephemeral dir the dotfiles
#   Stop hook claims-then-deletes every Stop, so it cannot be used as an
#   AB-metrics input.)
#
# Reads every dir/result-*.json file, each written by pr-iterate.js
# (ab_record:true) in the pinned schema:
#   {pr, mode:'single'|'multi', head_sha, status, iterations, fixes_applied,
#    review_agent_calls_total, last_decision, last_summary,
#    history:[{iteration, decision, summary, blocking:[{severity,...}],
#              minor:[...], review_mode, review_agent_calls, ...}],
#    token_usage?:{input, output}}
#
# Output (stdout, markdown):
#   (a) a run-detail table (one row per file, sorted by pr then mode) with
#       severity breakdown aggregated from history[].blocking + history[].minor
#   (b) a per-mode summary section (run count, avg iterations, avg blocking
#       count, avg review_agent_calls_total)
#
# Exit codes:
#   0 - success (including "no results found" and per-file skip cases)
#   1 - jq not installed
#
# Failure handling:
#   - dir missing or contains no result-*.json files: "no ab-run results
#     found" on stderr, exit 0.
#   - a file that fails to parse as JSON, or parses but is missing a
#     required pinned-schema key: warn on stderr, skip the file, continue
#     (exit 0 overall).

set -euo pipefail

DIR="${1:-$HOME/.claude/journal/ab-runs}"

if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not installed" >&2
    exit 1
fi

shopt -s nullglob
files=("$DIR"/result-*.json)
shopt -u nullglob

if [[ ${#files[@]} -eq 0 ]]; then
    echo "no ab-run results found" >&2
    exit 0
fi

# jq filter: validate the pinned-schema required keys and, if valid,
# project a flat record ready for markdown rendering. Returns `null` when
# required keys are missing/mistyped so the caller can warn+skip.
RECORD_FILTER='
def sev_count(s):
  ([(.history // [])[] | ((.blocking // [])[], (.minor // [])[])]
   | map(select(.severity == s)) | length);
if (
  (.pr? != null and (.pr | type) == "number") and
  (.mode? == "single" or .mode? == "multi") and
  (.status? != null and (.status | type) == "string") and
  (.iterations? != null and (.iterations | type) == "number") and
  (.fixes_applied? != null and (.fixes_applied | type) == "number") and
  (.review_agent_calls_total? != null and (.review_agent_calls_total | type) == "number") and
  (.history? != null and (.history | type) == "array")
) then
{
  pr: .pr,
  mode: .mode,
  sha7: ((.head_sha // "") as $s | if ($s | length) >= 7 then $s[0:7] else $s end),
  status: .status,
  iterations: .iterations,
  last_decision: (.last_decision // ""),
  blocking_total: ([(.history // [])[] | (.blocking // []) | length] | add // 0),
  critical: sev_count("critical"),
  major: sev_count("major"),
  minor: sev_count("minor"),
  review_agent_calls_total: .review_agent_calls_total,
  fixes_applied: .fixes_applied,
  token_usage: (if (.token_usage? != null) then
      (((.token_usage.input // 0) | tostring) + "/" + ((.token_usage.output // 0) | tostring))
    else "" end)
}
else null end
'

ndjson=""
for f in "${files[@]}"; do
    record=""
    if ! record=$(jq -c "$RECORD_FILTER" "$f" 2>/dev/null); then
        echo "Warning: failed to parse JSON, skipping: $f" >&2
        continue
    fi
    if [[ "$record" == "null" ]]; then
        echo "Warning: missing/invalid required key(s), skipping: $f" >&2
        continue
    fi
    ndjson+="$record"$'\n'
done

if [[ -z "$ndjson" ]]; then
    echo "no ab-run results found" >&2
    exit 0
fi

records_json=$(printf '%s' "$ndjson" | jq -s 'sort_by(.pr, .mode)')

echo "# AB Metrics Report"
echo
echo "## Run 明細"
echo
echo "| PR | mode | head_sha(先頭7字) | status | iterations | last_decision | blocking計 | critical | major | minor | review_agent_calls_total | fixes_applied | token_usage |"
echo "|---|---|---|---|---|---|---|---|---|---|---|---|---|"
printf '%s' "$records_json" | jq -r '
  .[] |
  "| \(.pr) | \(.mode) | \(.sha7) | \(.status) | \(.iterations) | \(.last_decision) | \(.blocking_total) | \(.critical) | \(.major) | \(.minor) | \(.review_agent_calls_total) | \(.fixes_applied) | \(.token_usage) |"
'

echo
echo "## Mode 別集計"
echo
echo "| mode | run数 | 平均iterations | 平均blocking件数 | 平均review_agent_calls_total |"
echo "|---|---|---|---|---|"
printf '%s' "$records_json" | jq -r '
  group_by(.mode) | .[] |
  {
    mode: .[0].mode,
    count: length,
    avg_iterations: ((map(.iterations) | add) / length),
    avg_blocking: ((map(.blocking_total) | add) / length),
    avg_review_calls: ((map(.review_agent_calls_total) | add) / length)
  } |
  "| \(.mode) | \(.count) | \(.avg_iterations * 100 | round / 100) | \(.avg_blocking * 100 | round / 100) | \(.avg_review_calls * 100 | round / 100) |"
'
