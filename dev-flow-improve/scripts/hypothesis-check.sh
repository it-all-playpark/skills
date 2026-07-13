#!/usr/bin/env bash
# hypothesis-check.sh - dev-improve 仮説突合の決定論 oracle
#
# journal (~/.claude/journal/*.json、$CLAUDE_JOURNAL_DIR 優先) の dev-flow entries を
# --since 以降で集計し、--metric の実測値を --target と突合して verdict を返す。
# 効果判定はこの script が単一実装（軸A: LLM に self-judge させない）。
# metric enum は _lib/improve-hypothesis.mjs の IMPROVE_METRIC_DIRECTIONS と 1:1 を保つこと。
#
# 集計軸の注意: 本 oracle の母集団は skill=="dev-flow" entries のみ（pr-iterate 単独 run は含まず、
# 分母に ci_pending を含む）。dev-flow-doctor の nested-run 正規化とは意図的に異なる —
# 仮説の current（起票時）と verdict（突合時）を**同一の測定器**で測ることを優先する。
# cap 閾値（eval>=10 / plan>=8）は dev-flow の既定 cap のハードコード（doctor は config 由来）。
#
# Usage:
#   hypothesis-check.sh --metric <name> --since <ISO8601 UTC> --target <num> --min-runs <int>
#
# Metrics (closed enum — out-of-enum は error):
#   iterate_unhealthy_rate  telemetry.iterate_status が unhealthy
#                           (stuck/fix_failed/max_reached/ci_error/review_contract_error)
#                           の割合。分母 = iterate_status 非 null の dev-flow entries。lte
#   micro_share             telemetry.shape == "micro" の割合。分母 = shape 非 null。gte
#   cap_pinned_count        eval_iter >= 10 または plan_iter >= 8 の entry 数。lte
#
# Output (stdout JSON):
#   {"ok":true,"metric":...,"value":<num>,"runs":<int>,
#    "verdict":"confirmed"|"not_confirmed"|"insufficient_data"}
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq

JOURNAL_DIR="${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}"

METRIC="" SINCE="" TARGET="" MIN_RUNS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --metric) METRIC="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --min-runs) MIN_RUNS="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die_json "Unknown argument: $1" 1 ;;
  esac
done

if [[ -z "$METRIC" || -z "$SINCE" || -z "$TARGET" || -z "$MIN_RUNS" ]]; then
  die_json "Usage: hypothesis-check.sh --metric <name> --since <ISO> --target <num> --min-runs <int>" 1
fi
[[ "$MIN_RUNS" =~ ^[1-9][0-9]*$ ]] || die_json "Invalid --min-runs: $MIN_RUNS" 1
[[ "$TARGET" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] || die_json "Invalid --target: $TARGET" 1
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || die_json "Invalid --since: $SINCE (ISO8601 UTC expected)" 1

DIRECTION=""
case "$METRIC" in
  iterate_unhealthy_rate|cap_pinned_count) DIRECTION="lte" ;;
  micro_share) DIRECTION="gte" ;;
  *) die_json "Out-of-enum metric: $METRIC" 1 ;;
esac

# journal load（ARG_MAX-safe: find + xargs cat → jq -s）
ENTRIES='[]'
if [[ -d "$JOURNAL_DIR" ]]; then
  ENTRIES=$(find "$JOURNAL_DIR" -maxdepth 1 -name '*.json' -print0 2>/dev/null \
    | xargs -0 cat 2>/dev/null \
    | jq -s '[.[] | select(type == "object")]' 2>/dev/null || echo '[]')
fi

WINDOW=$(echo "$ENTRIES" | jq --arg since "$SINCE" \
  '[.[] | select(.skill == "dev-flow" and ((.timestamp // "") >= $since))]')

case "$METRIC" in
  iterate_unhealthy_rate)
    RESULT=$(echo "$WINDOW" | jq '
      [.[] | .telemetry.iterate_status // empty] as $st
      | ($st | length) as $runs
      | ([$st[] | select(. == "stuck" or . == "fix_failed" or . == "max_reached"
          or . == "ci_error" or . == "review_contract_error")] | length) as $bad
      | {runs: $runs, value: (if $runs == 0 then 0 else (($bad / $runs) * 1000 | round / 1000) end)}')
    ;;
  micro_share)
    RESULT=$(echo "$WINDOW" | jq '
      [.[] | .telemetry.shape // empty] as $sh
      | ($sh | length) as $runs
      | ([$sh[] | select(. == "micro")] | length) as $micro
      | {runs: $runs, value: (if $runs == 0 then 0 else (($micro / $runs) * 1000 | round / 1000) end)}')
    ;;
  cap_pinned_count)
    RESULT=$(echo "$WINDOW" | jq '
      length as $runs
      | ([.[] | select(((.telemetry.eval_iter // -1) >= 10) or ((.telemetry.plan_iter // -1) >= 8))]
          | length) as $pinned
      | {runs: $runs, value: $pinned}')
    ;;
esac

RUNS=$(echo "$RESULT" | jq '.runs')
VALUE=$(echo "$RESULT" | jq '.value')

VERDICT="insufficient_data"
if (( RUNS >= MIN_RUNS )); then
  if [[ "$DIRECTION" == "lte" ]]; then
    CMP=$(jq -n --argjson v "$VALUE" --argjson t "$TARGET" '$v <= $t')
  else
    CMP=$(jq -n --argjson v "$VALUE" --argjson t "$TARGET" '$v >= $t')
  fi
  if [[ "$CMP" == "true" ]]; then VERDICT="confirmed"; else VERDICT="not_confirmed"; fi
fi

jq -n --arg metric "$METRIC" --argjson value "$VALUE" --argjson runs "$RUNS" --arg verdict "$VERDICT" \
  '{ok: true, metric: $metric, value: $value, runs: $runs, verdict: $verdict}'
