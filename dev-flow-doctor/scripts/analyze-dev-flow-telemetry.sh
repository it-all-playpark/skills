#!/usr/bin/env bash
# analyze-dev-flow-telemetry.sh - Analyze dev-flow / pr-iterate journal telemetry
#
# Reads ~/.claude/journal/*.json (or $CLAUDE_JOURNAL_DIR) via the ARG_MAX-safe
# journal loader below, filters to the lookback window, and produces:
#   - distributions : shape / merge_tier / eval_iter / plan_iter / gate_policy
#                      (denominator = .skill == "dev-flow" entries)
#                     iterate_status
#                      (denominator = all entries with .telemetry.iterate_status
#                       set, i.e. dev-flow AND pr-iterate)
#   - anomalies     : cap_pinned / iterate_unhealthy / micro_nonfiring
#
# Usage:
#   analyze-dev-flow-telemetry.sh [--window <dur>] [--config <path>]
#
# Options:
#   --window <dur>  Lookback window (7d, 14d, 30d, 2w, 1m, ...). Default: 30d.
#   --config <path> Override skill-config.json path (auto-detected otherwise).
#
# Output: JSON on stdout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq "jq is required"

# ----------------------------------------------------------------------------
# Args
# ----------------------------------------------------------------------------

WINDOW=""
CONFIG_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --window) WINDOW="$2"; shift 2 ;;
    --config) CONFIG_OVERRIDE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) die_json "Unknown argument: $1" 1 ;;
  esac
done

# ----------------------------------------------------------------------------
# Config resolution
# ----------------------------------------------------------------------------

DEFAULT_WINDOW="30d"
DEFAULT_EVAL_ITER_CAP="10"
DEFAULT_PLAN_ITER_CAP="8"
DEFAULT_ITERATE_UNHEALTHY_RATE="0.30"
DEFAULT_ITERATE_MIN_RUNS="3"
DEFAULT_MICRO_MIN_RUNS="10"

load_config_field() {
  # $1 = jq path inside .["dev-flow-doctor"]
  # $2 = default (JSON literal)
  local path="$1" default="$2"
  local cfg=""
  if [[ -n "$CONFIG_OVERRIDE" && -f "$CONFIG_OVERRIDE" ]]; then
    cfg="$CONFIG_OVERRIDE"
  else
    local git_root
    git_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
    for candidate in \
      "${SKILL_CONFIG_PATH:-}" \
      "${git_root:+$git_root/skill-config.json}" \
      "${git_root:+$git_root/.claude/skill-config.json}" \
      "${HOME}/.config/skills/config.json" \
      "${HOME}/.claude/skill-config.json"; do
      [[ -n "$candidate" && -f "$candidate" ]] && { cfg="$candidate"; break; }
    done
  fi
  if [[ -z "$cfg" ]]; then
    printf '%s' "$default"
    return
  fi
  local val
  val=$(jq -c --argjson default "$default" \
    ".[\"dev-flow-doctor\"]${path} // \$default" "$cfg" 2>/dev/null || echo "$default")
  printf '%s' "$val"
}

if [[ -z "$WINDOW" ]]; then
  WINDOW=$(load_config_field ".window_default" "\"$DEFAULT_WINDOW\"" | jq -r '.')
fi
EVAL_ITER_CAP=$(load_config_field ".thresholds.eval_iter_cap" "$DEFAULT_EVAL_ITER_CAP" | jq -r '.')
PLAN_ITER_CAP=$(load_config_field ".thresholds.plan_iter_cap" "$DEFAULT_PLAN_ITER_CAP" | jq -r '.')
ITERATE_UNHEALTHY_RATE=$(load_config_field ".thresholds.iterate_unhealthy_rate" "$DEFAULT_ITERATE_UNHEALTHY_RATE" | jq -r '.')
ITERATE_MIN_RUNS=$(load_config_field ".thresholds.iterate_min_runs" "$DEFAULT_ITERATE_MIN_RUNS" | jq -r '.')
MICRO_MIN_RUNS=$(load_config_field ".thresholds.micro_min_runs" "$DEFAULT_MICRO_MIN_RUNS" | jq -r '.')

# ----------------------------------------------------------------------------
# Window -> ISO since
# ----------------------------------------------------------------------------

parse_since() {
  local since="$1"
  case "$since" in
    *d) date -u -v-"${since%d}"d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
         date -u -d "${since%d} days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
    *w) date -u -v-"${since%w}"w +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
         date -u -d "${since%w} weeks ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
    *m) date -u -v-"${since%m}"m +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
         date -u -d "${since%m} months ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
    *) echo "$since" ;;
  esac
}

SINCE_ISO=$(parse_since "$WINDOW")
if [[ -z "$SINCE_ISO" ]]; then
  die_json "Failed to parse --window $WINDOW" 1
fi

# ----------------------------------------------------------------------------
# Journal load
# ----------------------------------------------------------------------------

JOURNAL_DIR="${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}"

load_journal_entries() {
  # Print a single JSON array on stdout. Each element is one entry object.
  if [[ ! -d "$JOURNAL_DIR" ]]; then
    printf '[]'
    return
  fi
  local files=()
  while IFS= read -r -d '' f; do
    files+=("$f")
  done < <(find "$JOURNAL_DIR" -maxdepth 1 -type f -name '*.json' -print0 2>/dev/null)
  if [[ ${#files[@]} -eq 0 ]]; then
    printf '[]'
    return
  fi
  # Slurp all entries via NUL-pipe + xargs cat + jq -s stdin.
  # Avoids ARG_MAX ("Argument list too long") when journal has 3,500+ files:
  #   printf is a bash builtin (ARG_MAX not applied), xargs -0 auto-splits
  #   cat calls to stay within OS limits, jq -s slurps the concatenated stream
  #   of JSON objects into a single array -- identical output to the old approach.
  # If any file is malformed, jq -s fails for the whole batch and we fall
  # through to the per-file rescue path below.
  local slurped=""
  if slurped=$(printf '%s\0' "${files[@]}" | xargs -0 cat -- 2>/dev/null | jq -cs '.' 2>/dev/null); then
    printf '%s' "$slurped"
    return
  fi
  local rescued=""
  if rescued=$(
    for f in "${files[@]}"; do
      jq -c '.' "$f" 2>/dev/null || true
    done | jq -s '.' 2>/dev/null
  ); then
    if [[ -n "$rescued" ]]; then
      printf '%s' "$rescued"
      return
    fi
  fi
  printf '[]'
}

ALL_ENTRIES=$(load_journal_entries)

# Filter by since
WINDOW_ENTRIES=$(echo "$ALL_ENTRIES" | jq -c \
  --arg since "$SINCE_ISO" \
  '[.[] | select(.timestamp >= $since)]')

# dev-flow-only entries: denominator for shape / merge_tier / eval_iter /
# plan_iter / gate_policy distributions. pr-iterate standalone entries
# (skill=="pr-iterate", telemetry.merge_tier=="PR_ITERATE") are excluded here
# by construction -- they never have skill=="dev-flow".
# source: skill のみ（hook 由来の failure capture エントリは telemetry を持たず
# 分母を汚染するため除外。source 欠落は skill 扱い）。
DEVFLOW_ENTRIES=$(echo "$WINDOW_ENTRIES" | jq -c \
  '[.[] | select(.skill == "dev-flow" and ((.source // "skill") == "skill"))]')

TOTAL_DEV_FLOW_RUNS=$(echo "$DEVFLOW_ENTRIES" | jq 'length')

# iterate_status entries: denominator is all entries (dev-flow + pr-iterate)
# that recorded a telemetry.iterate_status value.
# source: skill のみ（hook 由来の failure capture エントリは telemetry を持たず
# 分母を汚染するため除外。source 欠落は skill 扱い）。
ITERATE_ENTRIES=$(echo "$WINDOW_ENTRIES" | jq -c \
  '[.[] | select(.telemetry.iterate_status != null and ((.source // "skill") == "skill"))]')

# ----------------------------------------------------------------------------
# Distributions
# ----------------------------------------------------------------------------

SHAPE_DIST=$(echo "$DEVFLOW_ENTRIES" | jq -c '
  {
    micro: ([.[] | select(.telemetry.shape == "micro")] | length),
    standard: ([.[] | select(.telemetry.shape == "standard")] | length),
    complex: ([.[] | select(.telemetry.shape == "complex")] | length),
    unknown: ([.[] | select((.telemetry.shape // "unknown") as $v | ($v != "micro" and $v != "standard" and $v != "complex"))] | length)
  }
')

MERGE_TIER_DIST=$(echo "$DEVFLOW_ENTRIES" | jq -c '
  {
    AUTO: ([.[] | select(.telemetry.merge_tier == "AUTO")] | length),
    REVIEW: ([.[] | select(.telemetry.merge_tier == "REVIEW")] | length),
    HOLD: ([.[] | select(.telemetry.merge_tier == "HOLD")] | length),
    unknown: ([.[] | select((.telemetry.merge_tier // "unknown") as $v | ($v != "AUTO" and $v != "REVIEW" and $v != "HOLD"))] | length)
  }
')

GATE_POLICY_DIST=$(echo "$DEVFLOW_ENTRIES" | jq -c '
  {
    "deterministic-only": ([.[] | select(.telemetry.gate_policy == "deterministic-only")] | length),
    "llm-major-advisory": ([.[] | select(.telemetry.gate_policy == "llm-major-advisory")] | length),
    "llm-major-blocking": ([.[] | select(.telemetry.gate_policy == "llm-major-blocking")] | length),
    "llm-autonomous": ([.[] | select(.telemetry.gate_policy == "llm-autonomous")] | length),
    unknown: ([.[] | select((.telemetry.gate_policy // "unknown") as $v | ($v != "deterministic-only" and $v != "llm-major-advisory" and $v != "llm-major-blocking" and $v != "llm-autonomous"))] | length)
  }
')

EVAL_ITER_DIST=$(echo "$DEVFLOW_ENTRIES" | jq -c --argjson cap "$EVAL_ITER_CAP" '
  ([.[] | .telemetry.eval_iter | select(. != null)]) as $vals |
  {
    max: ($vals | if length > 0 then max else null end),
    cap: $cap,
    at_cap_count: ([.[] | select(.telemetry.eval_iter != null and .telemetry.eval_iter >= $cap)] | length)
  }
')

PLAN_ITER_DIST=$(echo "$DEVFLOW_ENTRIES" | jq -c --argjson cap "$PLAN_ITER_CAP" '
  ([.[] | .telemetry.plan_iter | select(. != null)]) as $vals |
  {
    max: ($vals | if length > 0 then max else null end),
    cap: $cap,
    at_cap_count: ([.[] | select(.telemetry.plan_iter != null and .telemetry.plan_iter >= $cap)] | length)
  }
')

ITERATE_STATUS_DIST=$(echo "$ITERATE_ENTRIES" | jq -c '
  {
    lgtm: ([.[] | select(.telemetry.iterate_status == "lgtm")] | length),
    stuck: ([.[] | select(.telemetry.iterate_status == "stuck")] | length),
    fix_failed: ([.[] | select(.telemetry.iterate_status == "fix_failed")] | length),
    max_reached: ([.[] | select(.telemetry.iterate_status == "max_reached")] | length),
    unknown: ([.[] | select((.telemetry.iterate_status // "unknown") as $v | ($v != "lgtm" and $v != "stuck" and $v != "fix_failed" and $v != "max_reached"))] | length),
    total: (length)
  }
')

DISTRIBUTIONS=$(jq -n \
  --argjson shape "$SHAPE_DIST" \
  --argjson merge_tier "$MERGE_TIER_DIST" \
  --argjson eval_iter "$EVAL_ITER_DIST" \
  --argjson plan_iter "$PLAN_ITER_DIST" \
  --argjson gate_policy "$GATE_POLICY_DIST" \
  --argjson iterate_status "$ITERATE_STATUS_DIST" \
  '{
    shape: $shape,
    merge_tier: $merge_tier,
    eval_iter: $eval_iter,
    plan_iter: $plan_iter,
    gate_policy: $gate_policy,
    iterate_status: $iterate_status
  }')

# ----------------------------------------------------------------------------
# Anomalies
# ----------------------------------------------------------------------------

# (1) cap_pinned: dev-flow entries pinned at eval_iter_cap or plan_iter_cap.
CAP_PINNED=$(echo "$DEVFLOW_ENTRIES" | jq -c \
  --argjson eval_cap "$EVAL_ITER_CAP" \
  --argjson plan_cap "$PLAN_ITER_CAP" \
  '
  [.[] | select(
    (.telemetry.eval_iter != null and .telemetry.eval_iter >= $eval_cap) or
    (.telemetry.plan_iter != null and .telemetry.plan_iter >= $plan_cap)
  )] as $hits |
  if ($hits | length) > 0 then
    [{
      type: "cap_pinned",
      severity: "warn",
      count: ($hits | length),
      detail: {
        eval_iter_cap: $eval_cap,
        plan_iter_cap: $plan_cap,
        entries: ($hits | map({id: .id, issue: (.issue // null), eval_iter: .telemetry.eval_iter, plan_iter: .telemetry.plan_iter}))
      }
    }]
  else [] end
  ')

# (2) iterate_unhealthy: non-lgtm (stuck/fix_failed/max_reached) rate over
#     iterate_status total, gated by iterate_min_runs.
ITERATE_UNHEALTHY=$(echo "$ITERATE_STATUS_DIST" | jq -c \
  --argjson rate_threshold "$ITERATE_UNHEALTHY_RATE" \
  --argjson min_runs "$ITERATE_MIN_RUNS" \
  '
  (.total) as $total |
  (.stuck + .fix_failed + .max_reached) as $nonlgtm |
  if $total >= $min_runs and $total > 0 and (($nonlgtm / $total) > $rate_threshold) then
    [{
      type: "iterate_unhealthy",
      severity: "warn",
      rate: ($nonlgtm / $total),
      detail: {
        total: $total,
        non_lgtm: $nonlgtm,
        stuck: .stuck,
        fix_failed: .fix_failed,
        max_reached: .max_reached,
        threshold: $rate_threshold,
        min_runs: $min_runs
      }
    }]
  else [] end
  ')

# (3) micro_nonfiring: run>=micro_min_runs and shape.micro==0 -> warn.
#     run<micro_min_runs -> explicit skipped (insufficient_data).
if [[ "$TOTAL_DEV_FLOW_RUNS" -lt "$MICRO_MIN_RUNS" ]]; then
  MICRO_NONFIRING=$(jq -n --argjson min_runs "$MICRO_MIN_RUNS" --argjson total "$TOTAL_DEV_FLOW_RUNS" \
    '[{
      type: "micro_nonfiring",
      severity: "skipped",
      reason: "insufficient_data",
      detail: { total_dev_flow_runs: $total, micro_min_runs: $min_runs }
    }]')
else
  MICRO_COUNT=$(echo "$SHAPE_DIST" | jq '.micro')
  if [[ "$MICRO_COUNT" -eq 0 ]]; then
    MICRO_NONFIRING=$(jq -n --argjson min_runs "$MICRO_MIN_RUNS" --argjson total "$TOTAL_DEV_FLOW_RUNS" \
      '[{
        type: "micro_nonfiring",
        severity: "warn",
        detail: { total_dev_flow_runs: $total, micro_min_runs: $min_runs, micro_count: 0 }
      }]')
  else
    MICRO_NONFIRING='[]'
  fi
fi

ANOMALIES=$(jq -n \
  --argjson cap_pinned "$CAP_PINNED" \
  --argjson iterate_unhealthy "$ITERATE_UNHEALTHY" \
  --argjson micro_nonfiring "$MICRO_NONFIRING" \
  '$cap_pinned + $iterate_unhealthy + $micro_nonfiring')

# ----------------------------------------------------------------------------
# Output
# ----------------------------------------------------------------------------

jq -n \
  --arg window "$WINDOW" \
  --arg since "$SINCE_ISO" \
  --argjson total "$TOTAL_DEV_FLOW_RUNS" \
  --argjson distributions "$DISTRIBUTIONS" \
  --argjson anomalies "$ANOMALIES" \
  '{
    window: $window,
    since: $since,
    total_dev_flow_runs: $total,
    distributions: $distributions,
    anomalies: $anomalies
  }'
