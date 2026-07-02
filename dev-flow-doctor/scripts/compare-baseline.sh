#!/usr/bin/env bash
# compare-baseline.sh - Compare a baseline snapshot against a current snapshot
#
# Two modes:
#   Fixed (default):  Reads two persisted snapshot JSONs (baseline + current,
#                      produced by baseline-snapshot.sh) and outputs a comparison
#                      JSON with per-metric delta / direction and regression
#                      findings. Used by `tests/no-glue-errors.sh` (AC4) and
#                      `run-diagnostics.sh` (AC3, integrated into health-scoring)
#                      — issue #83.
#   Rolling:           Auto-generates two snapshots from the journal — a
#                      previous window [now-2N, now-N) and a recent window
#                      [now-N, now) — and applies a ratio-based regression check
#                      (recent / max(previous, 1) > ratio_threshold) — issue #88.
#
# Usage:
#   compare-baseline.sh --baseline <path> [--current <path>] [--config <path>]
#   compare-baseline.sh --rolling --window <Nd|Nw|Nm> [--config <path>]
#
# Options:
#   --baseline <path>  Path to baseline snapshot JSON. Required in fixed mode.
#   --current <path>   Path to current snapshot JSON. If omitted, reads from
#                      stdin. Fixed mode only.
#   --rolling          Rolling mode. Cannot be combined with --baseline/--current.
#   --window <dur>     Rolling window (e.g. 7d, 2w, 1m). Required with --rolling.
#   --config <path>    Override skill-config.json (auto-detected otherwise).
#                      In rolling mode this is propagated to the internal
#                      baseline-snapshot.sh calls.
#
# Output: comparison JSON on stdout.
#
# Fixed mode schema:
#   {
#     "version": "1.0.0",
#     "schema": "dev-flow-doctor-compare/v1",
#     "mode": "fixed",
#     "window": "<baseline window>",
#     "metrics": [
#       {"metric", "baseline", "current", "delta", "delta_pct", "direction"}
#     ],
#     "findings": [
#       {"metric", "severity": "critical"|"error", "delta", "threshold", "reason"}
#     ]
#   }
#
# Rolling mode schema:
#   {
#     "version": "1.0.0",
#     "schema": "dev-flow-doctor-compare/v1",
#     "mode": "rolling",
#     "window": "<Nd>",
#     "windows": {
#       "previous": {"since", "until", "total_entries"},
#       "recent":   {"since", "until", "total_entries"}
#     },
#     "insufficient_data": <bool>,
#     "metrics": [
#       {"metric", "baseline", "current", "delta", "delta_pct", "ratio", "direction"}
#     ],
#     "findings": [
#       {"metric", "severity": "critical", "ratio", "threshold", "previous", "recent", "reason"}
#     ]
#   }
#
# Exit codes:
#   0 = no regression (or insufficient_data in rolling mode)
#   1 = regression detected (one or more critical findings)
#   2 = corrupt baseline / window mismatch / IO error / invalid --rolling args

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq "jq is required"

# ----------------------------------------------------------------------------
# Args
# ----------------------------------------------------------------------------

BASELINE_PATH=""
CURRENT_PATH=""
CONFIG_OVERRIDE=""
ROLLING=false
WINDOW_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --baseline) BASELINE_PATH="$2"; shift 2 ;;
    --current) CURRENT_PATH="$2"; shift 2 ;;
    --config) CONFIG_OVERRIDE="$2"; shift 2 ;;
    --rolling) ROLLING=true; shift ;;
    --window) WINDOW_ARG="$2"; shift 2 ;;
    -h|--help) sed -n '2,68p' "$0"; exit 0 ;;
    *)
      echo "{\"error\":\"Unknown argument: $1\"}" >&2
      exit 2
      ;;
  esac
done

if [[ "$ROLLING" == "true" ]]; then
  if [[ -n "$BASELINE_PATH" || -n "$CURRENT_PATH" ]]; then
    echo '{"error":"--rolling cannot be combined with --baseline/--current"}' >&2
    exit 2
  fi
  if [[ -z "$WINDOW_ARG" ]]; then
    echo '{"error":"--rolling requires --window <Nd|Nw|Nm>"}' >&2
    exit 2
  fi
  if [[ ! "$WINDOW_ARG" =~ ^[0-9]+[dwm]$ ]]; then
    echo "{\"error\":\"invalid --window format (expected Nd|Nw|Nm): $WINDOW_ARG\"}" >&2
    exit 2
  fi
else
  if [[ -z "$BASELINE_PATH" ]]; then
    echo '{"error":"--baseline is required"}' >&2
    exit 2
  fi

  if [[ ! -f "$BASELINE_PATH" ]]; then
    echo "{\"error\":\"baseline file not found: $BASELINE_PATH\"}" >&2
    exit 2
  fi
fi

# ----------------------------------------------------------------------------
# Config resolution (shared by fixed regression thresholds and rolling config)
# ----------------------------------------------------------------------------

resolve_skill_config_path() {
  if [[ -n "$CONFIG_OVERRIDE" && -f "$CONFIG_OVERRIDE" ]]; then
    printf '%s' "$CONFIG_OVERRIDE"; return
  fi
  local git_root
  git_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
  for candidate in \
    "${SKILL_CONFIG_PATH:-}" \
    "${git_root:+$git_root/skill-config.json}" \
    "${git_root:+$git_root/.claude/skill-config.json}" \
    "${HOME}/.config/skills/config.json" \
    "${HOME}/.claude/skill-config.json"; do
    [[ -n "$candidate" && -f "$candidate" ]] && { printf '%s' "$candidate"; return; }
  done
  printf ''
}

load_threshold() {
  local path="$1" default="$2"
  local cfg
  cfg=$(resolve_skill_config_path)
  if [[ -z "$cfg" ]]; then printf '%s' "$default"; return; fi
  local val
  val=$(jq -r --arg default "$default" \
    ".[\"dev-flow-doctor\"].baseline.regression_thresholds${path} // \$default" "$cfg" 2>/dev/null || echo "$default")
  printf '%s' "$val"
}

load_rolling_config() {
  local path="$1" default="$2"
  local cfg
  cfg=$(resolve_skill_config_path)
  if [[ -z "$cfg" ]]; then printf '%s' "$default"; return; fi
  local val
  val=$(jq -r --arg default "$default" \
    ".[\"dev-flow-doctor\"].baseline.rolling${path} // \$default" "$cfg" 2>/dev/null || echo "$default")
  printf '%s' "$val"
}

# ----------------------------------------------------------------------------
# Rolling mode
# ----------------------------------------------------------------------------

if [[ "$ROLLING" == "true" ]]; then
  NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # compute_until_prev <anchor_iso> <window> - anchor - window (BSD/GNU dual)
  compute_until_prev() {
    local anchor="$1" window="$2"
    local n="${window%[dwm]}" suffix="${window: -1}"
    case "$suffix" in
      d) date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$anchor" -v-"${n}"d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
           date -u -d "$anchor ${n} days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
      w) date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$anchor" -v-"${n}"w +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
           date -u -d "$anchor ${n} weeks ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
      m) date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$anchor" -v-"${n}"m +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
           date -u -d "$anchor ${n} months ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
    esac
  }

  UNTIL_PREV=$(compute_until_prev "$NOW" "$WINDOW_ARG")
  if [[ -z "$UNTIL_PREV" ]]; then
    echo "{\"error\":\"failed to compute rolling previous window boundary for --window $WINDOW_ARG\"}" >&2
    exit 2
  fi

  TMP=$(mktemp -d -t dffd-rolling-XXXXXX)
  # shellcheck disable=SC2064
  trap "rm -rf \"$TMP\"" EXIT

  RECENT_ARGS=(--window "$WINDOW_ARG" --until "$NOW" --out "$TMP/recent.json")
  PREV_ARGS=(--window "$WINDOW_ARG" --until "$UNTIL_PREV" --out "$TMP/previous.json")
  if [[ -n "$CONFIG_OVERRIDE" ]]; then
    RECENT_ARGS+=(--config "$CONFIG_OVERRIDE")
    PREV_ARGS+=(--config "$CONFIG_OVERRIDE")
  fi

  if ! "$SCRIPT_DIR/baseline-snapshot.sh" "${RECENT_ARGS[@]}" >/dev/null 2>&1; then
    echo '{"error":"failed to generate rolling snapshot","window":"recent"}' >&2
    exit 2
  fi
  if ! "$SCRIPT_DIR/baseline-snapshot.sh" "${PREV_ARGS[@]}" >/dev/null 2>&1; then
    echo '{"error":"failed to generate rolling snapshot","window":"previous"}' >&2
    exit 2
  fi

  if ! RECENT_JSON=$(jq -c '.' "$TMP/recent.json" 2>/dev/null); then
    echo '{"error":"failed to generate rolling snapshot","reason":"invalid recent snapshot JSON"}' >&2
    exit 2
  fi
  if ! PREVIOUS_JSON=$(jq -c '.' "$TMP/previous.json" 2>/dev/null); then
    echo '{"error":"failed to generate rolling snapshot","reason":"invalid previous snapshot JSON"}' >&2
    exit 2
  fi

  RATIO_THRESHOLD=$(load_rolling_config ".ratio_threshold" "1.5")
  MIN_ENTRIES=$(load_rolling_config ".min_entries_per_window" "5")

  RECENT_TOTAL=$(echo "$RECENT_JSON" | jq '.total_entries // 0')
  PREVIOUS_TOTAL=$(echo "$PREVIOUS_JSON" | jq '.total_entries // 0')
  RECENT_ERROR=$(echo "$RECENT_JSON" | jq '(.per_skill // []) | map((.failure + .partial)) | add // 0')
  PREVIOUS_ERROR=$(echo "$PREVIOUS_JSON" | jq '(.per_skill // []) | map((.failure + .partial)) | add // 0')
  RECENT_GLUE=$(echo "$RECENT_JSON" | jq '.glue_errors.count // 0')
  PREVIOUS_GLUE=$(echo "$PREVIOUS_JSON" | jq '.glue_errors.count // 0')

  INSUFFICIENT=false
  if [[ "$(jq -n --argjson p "$PREVIOUS_TOTAL" --argjson r "$RECENT_TOTAL" --argjson m "$MIN_ENTRIES" \
      'if ($p < $m) or ($r < $m) then "true" else "false" end' -r)" == "true" ]]; then
    INSUFFICIENT=true
  fi

  make_metric() {
    local name="$1" prev="$2" recent="$3"
    jq -n --arg name "$name" --argjson p "$prev" --argjson r "$recent" '
      ($r / (if $p < 1 then 1 else $p end)) as $ratio |
      (if $p == 0 then null else (($r - $p) / $p * 100) end) as $pct |
      {
        metric: $name,
        baseline: $p,
        current: $r,
        delta: ($r - $p),
        delta_pct: $pct,
        ratio: $ratio,
        direction: (if $ratio > 1 then "regressed" elif $ratio < 1 then "improved" else "unchanged" end)
      }'
  }

  METRIC_ERROR=$(make_metric "error_count" "$PREVIOUS_ERROR" "$RECENT_ERROR")
  METRIC_GLUE=$(make_metric "glue_errors.count" "$PREVIOUS_GLUE" "$RECENT_GLUE")

  ROLLING_METRICS=$(jq -n --argjson a "$METRIC_ERROR" --argjson b "$METRIC_GLUE" '[$a, $b]')

  ROLLING_FINDINGS="[]"
  if [[ "$INSUFFICIENT" != "true" ]]; then
    for metric_json in "$METRIC_ERROR" "$METRIC_GLUE"; do
      RATIO_VAL=$(echo "$metric_json" | jq '.ratio')
      EXCEEDS=$(jq -n --argjson ratio "$RATIO_VAL" --argjson th "$RATIO_THRESHOLD" 'if $ratio > $th then "true" else "false" end' -r)
      if [[ "$EXCEEDS" == "true" ]]; then
        METRIC_NAME=$(echo "$metric_json" | jq -r '.metric')
        PREV_VAL=$(echo "$metric_json" | jq '.baseline')
        RECENT_VAL=$(echo "$metric_json" | jq '.current')
        ROLLING_FINDINGS=$(echo "$ROLLING_FINDINGS" | jq \
          --arg metric "$METRIC_NAME" \
          --argjson ratio "$RATIO_VAL" \
          --argjson th "$RATIO_THRESHOLD" \
          --argjson prev "$PREV_VAL" \
          --argjson recent "$RECENT_VAL" \
          '. + [{
            metric: $metric,
            severity: "critical",
            ratio: $ratio,
            threshold: $th,
            previous: $prev,
            recent: $recent,
            reason: ($metric + " ratio exceeds rolling ratio_threshold")
          }]')
      fi
    done
  else
    echo "warning: insufficient rolling data (previous_total=$PREVIOUS_TOTAL, recent_total=$RECENT_TOTAL, min_entries_per_window=$MIN_ENTRIES)" >&2
  fi

  ROLLING_EXIT=0
  if [[ "$(echo "$ROLLING_FINDINGS" | jq 'length')" -gt 0 ]]; then
    ROLLING_EXIT=1
  fi

  WINDOWS_JSON=$(jq -n \
    --arg p_since "$(echo "$PREVIOUS_JSON" | jq -r '.since // ""')" \
    --arg p_until "$(echo "$PREVIOUS_JSON" | jq -r '.until // ""')" \
    --argjson p_total "$PREVIOUS_TOTAL" \
    --arg r_since "$(echo "$RECENT_JSON" | jq -r '.since // ""')" \
    --arg r_until "$(echo "$RECENT_JSON" | jq -r '.until // ""')" \
    --argjson r_total "$RECENT_TOTAL" \
    '{
      previous: {since: $p_since, until: (if $p_until == "" then null else $p_until end), total_entries: $p_total},
      recent: {since: $r_since, until: (if $r_until == "" then null else $r_until end), total_entries: $r_total}
    }')

  jq -n \
    --arg window "$WINDOW_ARG" \
    --argjson windows "$WINDOWS_JSON" \
    --argjson insufficient "$([[ "$INSUFFICIENT" == "true" ]] && echo true || echo false)" \
    --argjson metrics "$ROLLING_METRICS" \
    --argjson findings "$ROLLING_FINDINGS" \
    '{
      version: "1.0.0",
      schema: "dev-flow-doctor-compare/v1",
      mode: "rolling",
      window: $window,
      windows: $windows,
      insufficient_data: $insufficient,
      metrics: $metrics,
      findings: $findings
    }'

  exit "$ROLLING_EXIT"
fi

# ----------------------------------------------------------------------------
# Fixed mode: regression thresholds (skill-config.json)
# ----------------------------------------------------------------------------

DEFAULT_MAX_GLUE_REG="0"
DEFAULT_MAX_FAILURE_RATE_REG="0.10"

MAX_GLUE_REG=$(load_threshold ".max_glue_error_regression" "$DEFAULT_MAX_GLUE_REG")
MAX_FAILURE_RATE_REG=$(load_threshold ".max_failure_rate_regression" "$DEFAULT_MAX_FAILURE_RATE_REG")

# ----------------------------------------------------------------------------
# Read & validate baseline JSON
# ----------------------------------------------------------------------------

if ! BASELINE_JSON=$(jq -c '.' "$BASELINE_PATH" 2>/dev/null); then
  echo "{\"error\":\"baseline file is not valid JSON\",\"path\":\"$BASELINE_PATH\"}" >&2
  exit 2
fi

# ----------------------------------------------------------------------------
# Read & validate current JSON (stdin or --current)
# ----------------------------------------------------------------------------

if [[ -n "$CURRENT_PATH" ]]; then
  if [[ ! -f "$CURRENT_PATH" ]]; then
    echo "{\"error\":\"current file not found: $CURRENT_PATH\"}" >&2
    exit 2
  fi
  if ! CURRENT_JSON=$(jq -c '.' "$CURRENT_PATH" 2>/dev/null); then
    echo "{\"error\":\"current file is not valid JSON\",\"path\":\"$CURRENT_PATH\"}" >&2
    exit 2
  fi
else
  STDIN_BUF=$(cat)
  if ! CURRENT_JSON=$(echo "$STDIN_BUF" | jq -c '.' 2>/dev/null); then
    echo '{"error":"current snapshot (stdin) is not valid JSON"}' >&2
    exit 2
  fi
fi

# ----------------------------------------------------------------------------
# Window mismatch detection
# ----------------------------------------------------------------------------

BASELINE_WINDOW=$(echo "$BASELINE_JSON" | jq -r '.window // ""')
CURRENT_WINDOW=$(echo "$CURRENT_JSON" | jq -r '.window // ""')

WINDOW_FINDING="[]"
if [[ -n "$BASELINE_WINDOW" && -n "$CURRENT_WINDOW" && "$BASELINE_WINDOW" != "$CURRENT_WINDOW" ]]; then
  WINDOW_FINDING=$(jq -n \
    --arg b "$BASELINE_WINDOW" \
    --arg c "$CURRENT_WINDOW" \
    '[{
      metric: "window",
      severity: "error",
      delta: null,
      threshold: null,
      reason: ("baseline.window (" + $b + ") != current.window (" + $c + ")")
    }]')
fi

# ----------------------------------------------------------------------------
# Metric extraction
# ----------------------------------------------------------------------------

extract_metric() {
  local json="$1" path="$2"
  echo "$json" | jq -r "$path // 0"
}

BASE_GLUE=$(extract_metric "$BASELINE_JSON" ".glue_errors.count")
CURR_GLUE=$(extract_metric "$CURRENT_JSON" ".glue_errors.count")
BASE_TOTAL=$(extract_metric "$BASELINE_JSON" ".total_entries")
CURR_TOTAL=$(extract_metric "$CURRENT_JSON" ".total_entries")

# Avg failure rate across per_skill (weighted by total)
BASE_FAIL_RATE=$(echo "$BASELINE_JSON" | jq '
  (.per_skill // []) as $ps |
  ($ps | map(.total) | add // 0) as $t |
  if $t == 0 then 0 else (($ps | map((.failure + .partial) // 0) | add // 0) / $t) end')
CURR_FAIL_RATE=$(echo "$CURRENT_JSON" | jq '
  (.per_skill // []) as $ps |
  ($ps | map(.total) | add // 0) as $t |
  if $t == 0 then 0 else (($ps | map((.failure + .partial) // 0) | add // 0) / $t) end')

compute_delta() {
  local base="$1" curr="$2"
  jq -n --argjson b "$base" --argjson c "$curr" '$c - $b'
}

compute_delta_pct() {
  local base="$1" curr="$2"
  jq -n --argjson b "$base" --argjson c "$curr" '
    if $b == 0 then null else (($c - $b) / $b * 100) end'
}

direction_of() {
  # For "lower is better" metrics: improved=delta<0, regressed=delta>0
  local delta="$1"
  if jq -n --argjson d "$delta" 'if $d > 0 then 1 else 0 end' | grep -q '^1$'; then
    echo "regressed"
  elif jq -n --argjson d "$delta" 'if $d < 0 then 1 else 0 end' | grep -q '^1$'; then
    echo "improved"
  else
    echo "unchanged"
  fi
}

GLUE_DELTA=$(compute_delta "$BASE_GLUE" "$CURR_GLUE")
GLUE_PCT=$(compute_delta_pct "$BASE_GLUE" "$CURR_GLUE")
GLUE_DIR=$(direction_of "$GLUE_DELTA")

TOTAL_DELTA=$(compute_delta "$BASE_TOTAL" "$CURR_TOTAL")
TOTAL_PCT=$(compute_delta_pct "$BASE_TOTAL" "$CURR_TOTAL")
# total_entries: higher is generally neutral (more data); call it unchanged unless 0
TOTAL_DIR=$(direction_of "$TOTAL_DELTA")
# Override: for total_entries, "regressed" doesn't apply (more data is fine)
if [[ "$TOTAL_DIR" == "regressed" ]]; then TOTAL_DIR="unchanged"; fi
if [[ "$TOTAL_DIR" == "improved" && "$TOTAL_DELTA" != "0" ]]; then TOTAL_DIR="unchanged"; fi

FAIL_DELTA=$(compute_delta "$BASE_FAIL_RATE" "$CURR_FAIL_RATE")
FAIL_PCT=$(compute_delta_pct "$BASE_FAIL_RATE" "$CURR_FAIL_RATE")
FAIL_DIR=$(direction_of "$FAIL_DELTA")

METRICS=$(jq -n \
  --argjson bg "$BASE_GLUE" --argjson cg "$CURR_GLUE" --argjson dg "$GLUE_DELTA" --argjson pg "$GLUE_PCT" --arg drg "$GLUE_DIR" \
  --argjson bt "$BASE_TOTAL" --argjson ct "$CURR_TOTAL" --argjson dt "$TOTAL_DELTA" --argjson pt "$TOTAL_PCT" --arg drt "$TOTAL_DIR" \
  --argjson bf "$BASE_FAIL_RATE" --argjson cf "$CURR_FAIL_RATE" --argjson df "$FAIL_DELTA" --argjson pf "$FAIL_PCT" --arg drf "$FAIL_DIR" \
  '[
    {metric: "glue_errors.count", baseline: $bg, current: $cg, delta: $dg, delta_pct: $pg, direction: $drg},
    {metric: "total_entries", baseline: $bt, current: $ct, delta: $dt, delta_pct: $pt, direction: $drt},
    {metric: "failure_rate", baseline: $bf, current: $cf, delta: $df, delta_pct: $pf, direction: $drf}
  ]')

# ----------------------------------------------------------------------------
# Findings (critical regressions only)
# ----------------------------------------------------------------------------

REGRESSION_FINDINGS="[]"

# glue_errors regression beyond max_glue_error_regression
GLUE_REG_FLAG=$(jq -n --argjson d "$GLUE_DELTA" --argjson th "$MAX_GLUE_REG" 'if $d > $th then 1 else 0 end')
if [[ "$GLUE_REG_FLAG" == "1" ]]; then
  REGRESSION_FINDINGS=$(echo "$REGRESSION_FINDINGS" | jq \
    --argjson d "$GLUE_DELTA" --argjson th "$MAX_GLUE_REG" \
    '. + [{
      metric: "glue_errors.count",
      severity: "critical",
      delta: $d,
      threshold: $th,
      reason: "glue_errors.count regression exceeds max_glue_error_regression"
    }]')
fi

# failure_rate regression beyond max_failure_rate_regression
FAIL_REG_FLAG=$(jq -n --argjson d "$FAIL_DELTA" --argjson th "$MAX_FAILURE_RATE_REG" 'if $d > $th then 1 else 0 end')
if [[ "$FAIL_REG_FLAG" == "1" ]]; then
  REGRESSION_FINDINGS=$(echo "$REGRESSION_FINDINGS" | jq \
    --argjson d "$FAIL_DELTA" --argjson th "$MAX_FAILURE_RATE_REG" \
    '. + [{
      metric: "failure_rate",
      severity: "critical",
      delta: $d,
      threshold: $th,
      reason: "failure_rate regression exceeds max_failure_rate_regression"
    }]')
fi

# Combine all findings (window mismatch + regressions)
ALL_FINDINGS=$(jq -n \
  --argjson w "$WINDOW_FINDING" \
  --argjson r "$REGRESSION_FINDINGS" \
  '$w + $r')

# ----------------------------------------------------------------------------
# Exit code resolution
# ----------------------------------------------------------------------------

EXIT_CODE=0
# error severity (window mismatch / IO) → exit 2
HAS_ERROR=$(echo "$ALL_FINDINGS" | jq '[.[] | select(.severity == "error")] | length')
HAS_CRITICAL=$(echo "$ALL_FINDINGS" | jq '[.[] | select(.severity == "critical")] | length')

if [[ "$HAS_ERROR" -gt 0 ]]; then
  EXIT_CODE=2
elif [[ "$HAS_CRITICAL" -gt 0 ]]; then
  EXIT_CODE=1
fi

# ----------------------------------------------------------------------------
# Output
# ----------------------------------------------------------------------------

jq -n \
  --arg window "$BASELINE_WINDOW" \
  --argjson metrics "$METRICS" \
  --argjson findings "$ALL_FINDINGS" \
  '{
    version: "1.0.0",
    schema: "dev-flow-doctor-compare/v1",
    mode: "fixed",
    window: $window,
    metrics: $metrics,
    findings: $findings
  }'

exit "$EXIT_CODE"
