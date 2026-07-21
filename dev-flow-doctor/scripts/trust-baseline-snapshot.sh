#!/usr/bin/env bash
# trust-baseline-snapshot.sh - Re-runnable trust-layer baseline snapshot (issue #390 Phase 0)
#
# Aggregates existing dev-flow journal telemetry into 4 proxy metrics that
# approximate the trust-layer problems Phase 1-5 (SurfaceProof / EvalSeal /
# EffectDelta) are meant to address, without adding any new telemetry
# producer / feature flag / receipt schema. Re-run this script (same
# --window/--until) after shadow rollout to compare against the frozen
# snapshot in templates/trust-baseline-390.example.json.
#
#   1. false_completion_proxy - runs where .telemetry.eval_verdict == "pass"
#      (Evaluate declared completion) but a contradicting signal is present:
#      .telemetry.final_ac_reconcile == "unavailable", or
#      .telemetry.testsurf_hits is a non-empty array, or
#      .telemetry.redgreen_deny is a non-empty array.
#      denominator = total_runs (all dev-flow runs in window). Per-check
#      sub-stats (checks.*) use their own denominator = runs where that
#      specific telemetry key is present (non-null) among eval_verdict=="pass"
#      runs, so legacy runs predating a given key never inflate that check's
#      failure rate.
#   2. inconclusive_events - runs where any of the following holds:
#      .telemetry.eval_staleness in [hash_mismatch, iterate_incomplete], or
#      .telemetry.final_reconcile == "unavailable", or
#      .telemetry.vdelta_fail_open > 0, or
#      .telemetry.ui_verify in [failed_open, setup_failed].
#      denominator = total_runs. Per-check sub-stats use presence-only
#      denominators (same rationale as above).
#   3. phase_latency - per-phase (analyze/plan/implement/validate/evaluate/
#      pr/iterate/final) count/p50/p95 over .telemetry.phase_durations.<phase>,
#      plus overall count/p50/p95 over .telemetry.duration_seconds. Only
#      numeric values contribute (missing/non-numeric excluded from that
#      phase's population, mirroring analyze-dev-flow-telemetry.sh's
#      duration_seconds_by_shape pattern).
#   4. effect_failure_rate - proxy for PR/comment/journal side-effect
#      failure: rate of .telemetry.iterate_status in [fix_failed, stuck]
#      among runs where iterate_status is present (denominator = presence
#      population, since iterate_status only exists on runs that invoked
#      pr-iterate).
#
# Population (all 4 proxies): .source == "skill" (missing source defaults to
# "skill" per hook-capture convention) AND .skill == "dev-flow" journal
# entries within the lookback window.
#
# Usage:
#   trust-baseline-snapshot.sh [--window <dur>] [--until <iso8601>] [--config <path>] [--out <path>]
#
# Options:
#   --window <dur>    Lookback window (e.g. 30d, 14d, 2w, 1m). Default 30d.
#   --until <iso8601> Upper bound of the window (UTC ISO8601, e.g.
#                     2026-07-01T00:00:00Z). since is computed as
#                     until - window (half-open interval [since, until)).
#                     Omitted -> since is computed from now, no upper bound.
#   --config <path>   Override skill-config.json (auto-detected otherwise;
#                     only used to resolve dev-flow-doctor.window_default
#                     when --window is omitted).
#   --out <path>      Write to file instead of stdout (parent dir created if missing).
#
# Output: snapshot JSON (stdout if --out omitted). Schema:
#   {
#     "schema": "trust-layer-baseline/v1",
#     "version": "1.0.0",
#     "window": "30d",
#     "since": "ISO8601",
#     "until": "ISO8601" | null,
#     "taken_at": "ISO8601",
#     "total_runs": <int>,
#     "false_completion_proxy": {...},
#     "inconclusive_events": {...},
#     "phase_latency": {...},
#     "effect_failure_rate": {...}
#   }
#
# Exit codes:
#   0 success (including empty journal / zero matching runs)
#   1 invalid arg, unparseable window, or invalid --until

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../_lib/common.sh"

require_cmd jq "jq is required"

# ----------------------------------------------------------------------------
# Args
# ----------------------------------------------------------------------------

WINDOW=""
UNTIL_ISO=""
CONFIG_OVERRIDE=""
OUT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --window) WINDOW="$2"; shift 2 ;;
    --until) UNTIL_ISO="$2"; shift 2 ;;
    --config) CONFIG_OVERRIDE="$2"; shift 2 ;;
    --out) OUT_PATH="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,63p' "$0"; exit 0 ;;
    *) die_json "Unknown argument: $1" 1 ;;
  esac
done

if [[ -n "$UNTIL_ISO" ]] && [[ ! "$UNTIL_ISO" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  die_json "Invalid --until (expected UTC ISO8601 like 2026-07-01T00:00:00Z): $UNTIL_ISO" 1
fi

# ----------------------------------------------------------------------------
# Config resolution (mirrors baseline-snapshot.sh / analyze-dev-flow-telemetry.sh)
# ----------------------------------------------------------------------------

DEFAULT_WINDOW="30d"

load_config_field() {
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
    printf '%s' "$default"; return
  fi
  local val
  val=$(jq -c --argjson default "$default" \
    ".[\"dev-flow-doctor\"]${path} // \$default" "$cfg" 2>/dev/null || echo "$default")
  printf '%s' "$val"
}

if [[ -z "$WINDOW" ]]; then
  WINDOW=$(load_config_field ".window_default" "\"$DEFAULT_WINDOW\"" | jq -r '.')
fi

# ----------------------------------------------------------------------------
# Window -> ISO since (BSD / GNU dual, optional --until anchor)
# ----------------------------------------------------------------------------

parse_since() {
  local since="$1" anchor="${2:-}"
  if [[ -n "$anchor" ]]; then
    case "$since" in
      *d) date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$anchor" -v-"${since%d}"d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
           date -u -d "$anchor ${since%d} days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
      *w) date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$anchor" -v-"${since%w}"w +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
           date -u -d "$anchor ${since%w} weeks ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
      *m) date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$anchor" -v-"${since%m}"m +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
           date -u -d "$anchor ${since%m} months ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null ;;
      *) echo "$since" ;;
    esac
    return
  fi
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

SINCE_ISO=$(parse_since "$WINDOW" "$UNTIL_ISO")
if [[ -z "$SINCE_ISO" ]]; then
  if [[ -n "$UNTIL_ISO" ]]; then
    die_json "Failed to parse --window $WINDOW relative to --until $UNTIL_ISO" 1
  else
    die_json "Failed to parse --window $WINDOW" 1
  fi
fi

TAKEN_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ----------------------------------------------------------------------------
# Journal load (ARG_MAX-safe: NUL-delimited find -> xargs cat -> jq -s slurp,
# with a per-file rescue path if any single file is malformed)
# ----------------------------------------------------------------------------

JOURNAL_DIR="${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}"

load_journal_entries() {
  if [[ ! -d "$JOURNAL_DIR" ]]; then
    printf '[]'; return
  fi
  local files=()
  while IFS= read -r -d '' f; do
    files+=("$f")
  done < <(find "$JOURNAL_DIR" -maxdepth 1 -type f -name '*.json' -print0 2>/dev/null)
  if [[ ${#files[@]} -eq 0 ]]; then
    printf '[]'; return
  fi
  local slurped=""
  if slurped=$(printf '%s\0' "${files[@]}" | xargs -0 cat -- 2>/dev/null | jq -cs '.' 2>/dev/null); then
    printf '%s' "$slurped"; return
  fi
  local rescued=""
  if rescued=$(
    for f in "${files[@]}"; do
      jq -c '.' "$f" 2>/dev/null || true
    done | jq -s '.' 2>/dev/null
  ); then
    if [[ -n "$rescued" ]]; then printf '%s' "$rescued"; return; fi
  fi
  printf '[]'
}

ALL_ENTRIES=$(load_journal_entries)

WINDOW_ENTRIES=$(echo "$ALL_ENTRIES" | jq -c \
  --arg since "$SINCE_ISO" \
  --arg until "$UNTIL_ISO" \
  '[.[] | select(.timestamp >= $since and (if $until == "" then true else .timestamp < $until end))]')

# Population: .skill == "dev-flow" AND (.source // "skill") == "skill"
# (hook-capture failure entries carry no .telemetry and would pollute the
# denominator -- excluded, matching analyze-dev-flow-telemetry.sh).
DEVFLOW_ENTRIES=$(echo "$WINDOW_ENTRIES" | jq -c \
  '[.[] | select(.skill == "dev-flow" and ((.source // "skill") == "skill"))]')

TOTAL_RUNS=$(echo "$DEVFLOW_ENTRIES" | jq 'length')

# ----------------------------------------------------------------------------
# (1) false_completion_proxy
# ----------------------------------------------------------------------------

FALSE_COMPLETION_PROXY=$(echo "$DEVFLOW_ENTRIES" | jq -c --argjson total "$TOTAL_RUNS" '
  ([.[] | select(.telemetry.eval_verdict == "pass")]) as $passed |
  ($passed | length) as $passed_count |
  ($passed | map(select(
    (.telemetry.final_ac_reconcile == "unavailable") or
    (((.telemetry.testsurf_hits // null) | type) == "array" and ((.telemetry.testsurf_hits // []) | length) > 0) or
    (((.telemetry.redgreen_deny // null) | type) == "array" and ((.telemetry.redgreen_deny // []) | length) > 0)
  ))) as $hits |
  ($hits | length) as $hit_count |

  ($passed | map(select(.telemetry.final_ac_reconcile != null))) as $ac_pop |
  ($ac_pop | map(select(.telemetry.final_ac_reconcile == "unavailable"))) as $ac_hits |

  ($passed | map(select((.telemetry.testsurf_hits // null) != null))) as $ts_pop |
  ($ts_pop | map(select((.telemetry.testsurf_hits // []) | length > 0))) as $ts_hits |

  ($passed | map(select((.telemetry.redgreen_deny // null) != null))) as $rd_pop |
  ($rd_pop | map(select((.telemetry.redgreen_deny // []) | length > 0))) as $rd_hits |

  {
    denominator: $total,
    count: $hit_count,
    rate: (if $total > 0 then ($hit_count / $total) else null end),
    passed_count: $passed_count,
    checks: {
      final_ac_reconcile_unavailable: {
        denominator: ($ac_pop | length),
        count: ($ac_hits | length),
        rate: (if ($ac_pop | length) > 0 then (($ac_hits | length) / ($ac_pop | length)) else null end)
      },
      testsurf_hits_nonempty: {
        denominator: ($ts_pop | length),
        count: ($ts_hits | length),
        rate: (if ($ts_pop | length) > 0 then (($ts_hits | length) / ($ts_pop | length)) else null end)
      },
      redgreen_deny_nonempty: {
        denominator: ($rd_pop | length),
        count: ($rd_hits | length),
        rate: (if ($rd_pop | length) > 0 then (($rd_hits | length) / ($rd_pop | length)) else null end)
      }
    }
  }
')

# ----------------------------------------------------------------------------
# (2) inconclusive_events
# ----------------------------------------------------------------------------

INCONCLUSIVE_EVENTS=$(echo "$DEVFLOW_ENTRIES" | jq -c --argjson total "$TOTAL_RUNS" '
  def is_stale: (.telemetry.eval_staleness // null) as $v | ($v == "hash_mismatch" or $v == "iterate_incomplete");
  def is_reconcile_unavailable: (.telemetry.final_reconcile // null) == "unavailable";
  def is_vdelta_fail_open: ((.telemetry.vdelta_fail_open // null) | type) == "number" and (.telemetry.vdelta_fail_open > 0);
  def is_ui_inconclusive: (.telemetry.ui_verify // null) as $v | ($v == "failed_open" or $v == "setup_failed");

  ([.[] | select(is_stale or is_reconcile_unavailable or is_vdelta_fail_open or is_ui_inconclusive)]) as $hits |
  ($hits | length) as $hit_count |

  ([.[] | select((.telemetry.eval_staleness // null) != null)]) as $stale_pop |
  ([.[] | select(is_stale and ((.telemetry.eval_staleness // null) != null))]) as $stale_hits |

  ([.[] | select((.telemetry.final_reconcile // null) != null)]) as $reconcile_pop |
  ([.[] | select(is_reconcile_unavailable and ((.telemetry.final_reconcile // null) != null))]) as $reconcile_hits |

  ([.[] | select(((.telemetry.vdelta_fail_open // null) | type) == "number")]) as $vdelta_pop |
  ([.[] | select(is_vdelta_fail_open)]) as $vdelta_hits |

  ([.[] | select((.telemetry.ui_verify // null) != null)]) as $ui_pop |
  ([.[] | select(is_ui_inconclusive and ((.telemetry.ui_verify // null) != null))]) as $ui_hits |

  {
    denominator: $total,
    count: $hit_count,
    rate: (if $total > 0 then ($hit_count / $total) else null end),
    checks: {
      eval_staleness_inconclusive: {
        denominator: ($stale_pop | length),
        count: ($stale_hits | length),
        rate: (if ($stale_pop | length) > 0 then (($stale_hits | length) / ($stale_pop | length)) else null end)
      },
      final_reconcile_unavailable: {
        denominator: ($reconcile_pop | length),
        count: ($reconcile_hits | length),
        rate: (if ($reconcile_pop | length) > 0 then (($reconcile_hits | length) / ($reconcile_pop | length)) else null end)
      },
      vdelta_fail_open_positive: {
        denominator: ($vdelta_pop | length),
        count: ($vdelta_hits | length),
        rate: (if ($vdelta_pop | length) > 0 then (($vdelta_hits | length) / ($vdelta_pop | length)) else null end)
      },
      ui_verify_inconclusive: {
        denominator: ($ui_pop | length),
        count: ($ui_hits | length),
        rate: (if ($ui_pop | length) > 0 then (($ui_hits | length) / ($ui_pop | length)) else null end)
      }
    }
  }
')

# ----------------------------------------------------------------------------
# (3) phase_latency: per-phase + overall duration_seconds count/p50/p95.
# Linear-interpolation percentile (numpy-default method) over numeric values
# only (missing/non-numeric excluded, mirroring analyze-dev-flow-telemetry.sh
# duration_seconds_by_shape).
# ----------------------------------------------------------------------------

PHASE_LATENCY=$(echo "$DEVFLOW_ENTRIES" | jq -c '
  def percentile($p; $v):
    ($v | length) as $n |
    if $n == 0 then null
    elif $n == 1 then $v[0]
    else
      ($p * ($n - 1)) as $idx |
      ($idx | floor) as $lo |
      ($idx | ceil) as $hi |
      if $lo == $hi then $v[$lo]
      else ($v[$lo] + ($v[$hi] - $v[$lo]) * ($idx - $lo))
      end
    end;
  def stats_from($vals):
    ($vals | map(select(type == "number")) | sort) as $v |
    ($v | length) as $n |
    {
      count: $n,
      p50: (if $n == 0 then null else percentile(0.5; $v) end),
      p95: (if $n == 0 then null else percentile(0.95; $v) end)
    };
  {
    analyze: ([.[] | .telemetry.phase_durations.analyze] | stats_from(.)),
    plan: ([.[] | .telemetry.phase_durations.plan] | stats_from(.)),
    implement: ([.[] | .telemetry.phase_durations.implement] | stats_from(.)),
    validate: ([.[] | .telemetry.phase_durations.validate] | stats_from(.)),
    evaluate: ([.[] | .telemetry.phase_durations.evaluate] | stats_from(.)),
    pr: ([.[] | .telemetry.phase_durations.pr] | stats_from(.)),
    iterate: ([.[] | .telemetry.phase_durations.iterate] | stats_from(.)),
    final: ([.[] | .telemetry.phase_durations.final] | stats_from(.)),
    duration_seconds: ([.[] | .telemetry.duration_seconds] | stats_from(.))
  }
')

# ----------------------------------------------------------------------------
# (4) effect_failure_rate: proxy for PR/comment/journal side-effect failure.
# denominator = runs where .telemetry.iterate_status is present (only runs
# that invoked pr-iterate carry this key).
# ----------------------------------------------------------------------------

EFFECT_FAILURE_RATE=$(echo "$DEVFLOW_ENTRIES" | jq -c '
  ([.[] | select((.telemetry.iterate_status // null) != null)]) as $pop |
  ($pop | map(select(.telemetry.iterate_status == "fix_failed" or .telemetry.iterate_status == "stuck"))) as $hits |
  ($pop | length) as $denom |
  ($hits | length) as $count |
  {
    denominator: $denom,
    count: $count,
    rate: (if $denom > 0 then ($count / $denom) else null end)
  }
')

# ----------------------------------------------------------------------------
# Final assembly
# ----------------------------------------------------------------------------

SNAPSHOT=$(jq -n \
  --arg window "$WINDOW" \
  --arg since "$SINCE_ISO" \
  --arg until "$UNTIL_ISO" \
  --arg taken_at "$TAKEN_AT" \
  --argjson total "$TOTAL_RUNS" \
  --argjson false_completion_proxy "$FALSE_COMPLETION_PROXY" \
  --argjson inconclusive_events "$INCONCLUSIVE_EVENTS" \
  --argjson phase_latency "$PHASE_LATENCY" \
  --argjson effect_failure_rate "$EFFECT_FAILURE_RATE" \
  '{
    schema: "trust-layer-baseline/v1",
    version: "1.0.0",
    window: $window,
    since: $since,
    until: (if $until == "" then null else $until end),
    taken_at: $taken_at,
    total_runs: $total,
    false_completion_proxy: $false_completion_proxy,
    inconclusive_events: $inconclusive_events,
    phase_latency: $phase_latency,
    effect_failure_rate: $effect_failure_rate
  }')

if [[ -n "$OUT_PATH" ]]; then
  mkdir -p "$(dirname "$OUT_PATH")"
  printf '%s\n' "$SNAPSHOT" > "$OUT_PATH"
else
  printf '%s\n' "$SNAPSHOT"
fi
