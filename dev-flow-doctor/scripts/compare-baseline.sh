#!/usr/bin/env bash
# compare-baseline.sh - Compare a baseline snapshot against a current snapshot
#
# Reads two snapshot JSONs (baseline + current, produced by baseline-snapshot.sh)
# and outputs a comparison JSON with per-metric delta / direction and regression
# findings. Used by `tests/no-glue-errors.sh` (AC4) and `run-diagnostics.sh`
# (AC3, integrated into health-scoring) — issue #83.
#
# Usage:
#   compare-baseline.sh --baseline <path> [--current <path>]
#
# Options:
#   --baseline <path>  Path to baseline snapshot JSON. Required.
#   --current <path>   Path to current snapshot JSON. If omitted, reads from stdin.
#
# Output: comparison JSON on stdout. Schema:
#   {
#     "version": "1.0.0",
#     "schema": "dev-flow-doctor-compare/v1",
#     "window": "<baseline window>",
#     "metrics": [
#       {"metric", "baseline", "current", "delta", "delta_pct", "direction"}
#     ],
#     "findings": [
#       {"metric", "severity": "critical"|"error", "delta", "threshold", "reason"}
#     ]
#   }
#
# Exit codes:
#   0 = no regression
#   1 = regression detected (one or more critical findings)
#   2 = corrupt baseline / window mismatch / IO error

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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --baseline) BASELINE_PATH="$2"; shift 2 ;;
    --current) CURRENT_PATH="$2"; shift 2 ;;
    --config) CONFIG_OVERRIDE="$2"; shift 2 ;;
    -h|--help) sed -n '2,38p' "$0"; exit 0 ;;
    *)
      echo "{\"error\":\"Unknown argument: $1\"}" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$BASELINE_PATH" ]]; then
  echo '{"error":"--baseline is required"}' >&2
  exit 2
fi

if [[ ! -f "$BASELINE_PATH" ]]; then
  echo "{\"error\":\"baseline file not found: $BASELINE_PATH\"}" >&2
  exit 2
fi

# ----------------------------------------------------------------------------
# Config: regression thresholds (skill-config.json)
# ----------------------------------------------------------------------------

DEFAULT_MAX_GLUE_REG="0"
DEFAULT_MAX_FAILURE_RATE_REG="0.10"

load_threshold() {
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
  if [[ -z "$cfg" ]]; then printf '%s' "$default"; return; fi
  local val
  val=$(jq -r --arg default "$default" \
    ".[\"dev-flow-doctor\"].baseline.regression_thresholds${path} // \$default" "$cfg" 2>/dev/null || echo "$default")
  printf '%s' "$val"
}

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
    window: $window,
    metrics: $metrics,
    findings: $findings
  }'

exit "$EXIT_CODE"
