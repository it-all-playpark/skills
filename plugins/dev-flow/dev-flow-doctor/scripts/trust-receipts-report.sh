#!/usr/bin/env bash
# trust-receipts-report.sh - Real trust receipt (SurfaceProof/EvalSeal/EffectDelta)
# consumption report (epic #390 Phase 5, issue #413, AC-13).
#
# Aggregates dev-flow journal telemetry trust keys into run_id-level metrics:
#   1. layer_status       - per-layer verdict x reason_code distribution
#                           (+ per-stage counts for evalseal/effectdelta,
#                           + invalidated_count).
#   2. missing_receipt    - per-layer rate of trust-active runs with zero
#                           receipts for that layer + overall_receipt_success_rate
#                           (all 3 layers present). evalseal also carries
#                           reason_distribution: {<reason>: count} built from
#                           .telemetry.trust_evalseal_missing_reason on each
#                           missing run (unrecorded when absent; issue #454 AC-7).
#                           effectdelta also carries pr_stage_reason_distribution:
#                           {<reason>: count} built from
#                           .telemetry.trust_effectdelta_pr_missing_reason on each
#                           run with no stage=="pr" effectdelta receipt (unrecorded
#                           when absent; issue #476 AC-4).
#   3. inconclusive       - rate of adopted receipts / runs with verdict=="inconclusive".
#   4. effect_mismatch    - rate of runs whose EffectDelta receipt is
#                           verdict=="fail" or domain_reason_code in
#                           {DUPLICATE_EFFECT, WRONG_TARGET}.
#   5. false_completion   - rate of runs where eval_verdict=="pass" but a
#                           non-invalidated trust receipt says verdict=="fail".
#   6. latency            - trust_active vs trust_inactive duration_seconds /
#                           phase_durations count/p50/p95 + trust_added_p95_seconds.
#   7. cost_proxy         - trust receipts per run count/p50/p95 (proxy; no
#                           direct cost telemetry exists).
#
# Population: .skill == "dev-flow" AND (.source // "skill") == "skill" journal
# entries within the lookback window (same convention as trust-baseline-snapshot.sh).
# trust_active_runs = runs carrying at least one of
# .telemetry.{trust_surfaceproof_shadow, trust_receipts, trust_run_id}.
# Legacy runs (none of those keys) never count against missing_receipt (AC-13
# 0-run safety / presence-only denominator).
#
# Per (layer, stage) receipt de-duplication within a run: when >1 receipt shares
# the same layer+stage, the last non-invalidated entry (array order) is adopted
# (effective verdict rule: invalidated==true receipts are excluded from
# verdict/reason_code distributions and counted separately in
# invalidated_count; among the remaining entries for a given layer+stage,
# array-order last wins).
#
# Usage:
#   trust-receipts-report.sh [--window <dur>] [--until <iso8601>] [--config <path>]
#                             [--out <path>] [--slo] [--matrix <dir>]
#
# Options:
#   --window <dur>    Lookback window (e.g. 30d, 14d, 2w, 1m). Default 30d.
#   --until <iso8601> Upper bound of the window (UTC ISO8601). since is computed
#                     as until - window (half-open interval [since, until)).
#                     Omitted -> since is computed from now, no upper bound.
#   --config <path>   Override skill-config.json (auto-detected otherwise).
#   --out <path>      Write to file instead of stdout (parent dir created if missing).
#   --slo             Include a `slo` object: Go/No-Go verdict against the
#                     initial SLO hypothesis (receipt success rate >= 0.99,
#                     inconclusive rate <= 0.01, added p95 <= 180s, min_runs=20).
#                     Unmeasurable metrics (eligible_runs<20, added p95 null)
#                     are never rounded up to "go".
#   --matrix <dir>    Ignore the journal window entirely and instead read
#                     one-entry-per-file journal-shaped fixtures from <dir>,
#                     classify each by .context.fixture_axis (long-issue|coding|
#                     pr-side-effect|e2e) x .context.layer_modes.{surfaceproof,
#                     evalseal,effectdelta} (each off|shadow), and emit a
#                     trust-receipts-matrix/v1 comparison (32 cells: 4 axes x
#                     2^3 layer-mode combos). Out-of-enum axis/mode values are
#                     a hard error (no legacy fallback).
#
# Exit codes:
#   0 success (including empty journal / zero matching runs)
#   1 invalid arg, unparseable window, invalid --until, or out-of-enum --matrix input

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

require_cmd jq "jq is required"

# ----------------------------------------------------------------------------
# Args
# ----------------------------------------------------------------------------

WINDOW=""
UNTIL_ISO=""
CONFIG_OVERRIDE=""
OUT_PATH=""
WITH_SLO=false
MATRIX_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --window) WINDOW="$2"; shift 2 ;;
    --until) UNTIL_ISO="$2"; shift 2 ;;
    --config) CONFIG_OVERRIDE="$2"; shift 2 ;;
    --out) OUT_PATH="$2"; shift 2 ;;
    --slo) WITH_SLO=true; shift 1 ;;
    --matrix) MATRIX_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,60p' "$0"; exit 0 ;;
    *) die_json "Unknown argument: $1" 1 ;;
  esac
done

if [[ -n "$UNTIL_ISO" ]] && [[ ! "$UNTIL_ISO" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  die_json "Invalid --until (expected UTC ISO8601 like 2026-07-01T00:00:00Z): $UNTIL_ISO" 1
fi

TAKEN_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ----------------------------------------------------------------------------
# Shared jq library (percentile / stats_from, matching trust-baseline-snapshot.sh)
# ----------------------------------------------------------------------------

JQ_STATS_LIB='
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
'

# ----------------------------------------------------------------------------
# --matrix mode (short-circuits the normal journal-window report)
# ----------------------------------------------------------------------------

MATRIX_AXES='["long-issue","coding","pr-side-effect","e2e"]'
MATRIX_LAYER_MODES='["off","shadow"]'

load_dir_entries() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    printf '[]'; return
  fi
  local files=()
  while IFS= read -r -d '' f; do
    files+=("$f")
  done < <(find "$dir" -maxdepth 1 -type f -name '*.json' -print0 2>/dev/null)
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

if [[ -n "$MATRIX_DIR" ]]; then
  MATRIX_ENTRIES=$(load_dir_entries "$MATRIX_DIR")

  # Validate every entry's fixture_axis / layer_modes against the closed enum
  # before computing anything (fail-closed: no legacy fallback / partial output).
  VALIDATION_ERROR=$(echo "$MATRIX_ENTRIES" | jq -r \
    --argjson axes "$MATRIX_AXES" --argjson modes "$MATRIX_LAYER_MODES" '
    def bad_axis: (.context.fixture_axis // null) as $a | ($a == null) or ($axes | index($a) | not);
    def bad_mode($m): ($m == null) or ($modes | index($m) | not);
    [ .[] |
      select(
        bad_axis or
        bad_mode(.context.layer_modes.surfaceproof) or
        bad_mode(.context.layer_modes.evalseal) or
        bad_mode(.context.layer_modes.effectdelta)
      ) |
      "entry \(.id // "?"): fixture_axis=\(.context.fixture_axis // null) layer_modes=\(.context.layer_modes // null)"
    ] | if length == 0 then "" else .[0] end
  ')

  if [[ -n "$VALIDATION_ERROR" ]]; then
    die_json "Invalid --matrix fixture (out-of-enum fixture_axis/layer_modes): $VALIDATION_ERROR" 1
  fi

  MATRIX_OUTPUT=$(echo "$MATRIX_ENTRIES" | jq -c \
    --argjson axes "$MATRIX_AXES" --argjson modes "$MATRIX_LAYER_MODES" \
    --arg taken_at "$TAKEN_AT" "
    $JQ_STATS_LIB
    def adopted_stage(\$entries; \$layer):
      [ \$entries[] | select(.layer == \$layer) ]
      | group_by(.stage)
      | map( ( [ .[] | select(.invalidated != true) ] | last ) )
      | map(select(. != null));

    def run_signal(\$e):
      (\$e.telemetry.trust_receipts // []) as \$receipts |
      (\$e.telemetry.trust_surfaceproof_shadow // null) as \$sp |
      ( ( if \$sp != null then [ (\$sp + {layer:\"surfaceproof\", stage: null, invalidated: false}) ] else [] end )
        + adopted_stage(\$receipts; \"evalseal\")
        + adopted_stage(\$receipts; \"effectdelta\")
      ) as \$adopted |
      {
        is_inconclusive: ( [\$adopted[] | select(.verdict == \"inconclusive\")] | length > 0 ),
        is_effect_mismatch: ( [\$adopted[] | select(.layer == \"effectdelta\" and (.verdict == \"fail\" or (.domain_reason_code // null) == \"DUPLICATE_EFFECT\" or (.domain_reason_code // null) == \"WRONG_TARGET\"))] | length > 0 ),
        is_false_completion: ( (\$e.telemetry.eval_verdict == \"pass\") and ( [\$adopted[] | select(.verdict == \"fail\")] | length > 0 ) )
      };

    . as \$entries |
    [ \$axes[] as \$axis |
      \$modes[] as \$sp_mode |
      \$modes[] as \$es_mode |
      \$modes[] as \$ed_mode |
      {
        axis: \$axis,
        layer_modes: { surfaceproof: \$sp_mode, evalseal: \$es_mode, effectdelta: \$ed_mode }
      }
    ] | map(
      . as \$cell |
      ( [ \$entries[] | select(
            .context.fixture_axis == \$cell.axis and
            .context.layer_modes.surfaceproof == \$cell.layer_modes.surfaceproof and
            .context.layer_modes.evalseal == \$cell.layer_modes.evalseal and
            .context.layer_modes.effectdelta == \$cell.layer_modes.effectdelta
          ) ] ) as \$members |
      ( [ \$members[] | run_signal(.) ] ) as \$signals |
      \$cell + {
        run_count: (\$members | length),
        false_completion_count: ( [\$signals[] | select(.is_false_completion)] | length ),
        inconclusive_count: ( [\$signals[] | select(.is_inconclusive)] | length ),
        effect_mismatch_count: ( [\$signals[] | select(.is_effect_mismatch)] | length ),
        duration_p50: ( [\$members[] | .telemetry.duration_seconds] | stats_from(.) | .p50 )
      }
    ) as \$cells |
    {
      schema: \"trust-receipts-matrix/v1\",
      version: \"1.0.0\",
      taken_at: \$taken_at,
      cells: \$cells
    }
  ")

  if [[ -n "$OUT_PATH" ]]; then
    mkdir -p "$(dirname "$OUT_PATH")"
    printf '%s\n' "$MATRIX_OUTPUT" > "$OUT_PATH"
  else
    printf '%s\n' "$MATRIX_OUTPUT"
  fi
  exit 0
fi

# ----------------------------------------------------------------------------
# Config resolution (mirrors trust-baseline-snapshot.sh)
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

# ----------------------------------------------------------------------------
# Journal load (ARG_MAX-safe, mirrors trust-baseline-snapshot.sh)
# ----------------------------------------------------------------------------

JOURNAL_DIR="${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}"

ALL_ENTRIES=$(load_dir_entries "$JOURNAL_DIR")

WINDOW_ENTRIES=$(echo "$ALL_ENTRIES" | jq -c \
  --arg since "$SINCE_ISO" \
  --arg until "$UNTIL_ISO" \
  '[.[] | select(.timestamp >= $since and (if $until == "" then true else .timestamp < $until end))]')

DEVFLOW_ENTRIES=$(echo "$WINDOW_ENTRIES" | jq -c \
  '[.[] | select(.skill == "dev-flow" and ((.source // "skill") == "skill"))]')

TOTAL_RUNS=$(echo "$DEVFLOW_ENTRIES" | jq 'length')

# ----------------------------------------------------------------------------
# Shared enrichment: run_id / eval_verdict / duration / phase_durations /
# per-layer adopted receipts (invalidated-excluded, same layer+stage
# deduped to the last non-invalidated entry) / is_active flag.
# ----------------------------------------------------------------------------

JQ_ENRICH='
  def adopted_stage($entries; $layer):
    [ $entries[] | select(.layer == $layer) ]
    | group_by(.stage)
    | map( ( [ .[] | select(.invalidated != true) ] | last ) )
    | map(select(. != null));

  def raw_layer($entries; $layer):
    [ $entries[] | select(.layer == $layer) ];

  map(
    (.telemetry.trust_receipts // []) as $receipts |
    (.telemetry.trust_surfaceproof_shadow // null) as $sp |
    ($sp != null) as $has_sp |
    (($receipts | length) > 0) as $has_receipts |
    ((.telemetry.trust_run_id // null) != null) as $has_run_id |
    {
      run_id: (.telemetry.trust_run_id // .id),
      eval_verdict: (.telemetry.eval_verdict // null),
      duration_seconds: (.telemetry.duration_seconds // null),
      phase_durations: (.telemetry.phase_durations // {}),
      evalseal_missing_reason: (.telemetry.trust_evalseal_missing_reason // null),
      effectdelta_pr_missing_reason: (.telemetry.trust_effectdelta_pr_missing_reason // null),
      is_active: ($has_sp or $has_receipts or $has_run_id),
      surfaceproof_raw: (if $sp != null then [ ($sp + {layer: "surfaceproof", stage: null, invalidated: false}) ] else [] end),
      evalseal_raw: (raw_layer($receipts; "evalseal")),
      effectdelta_raw: (raw_layer($receipts; "effectdelta")),
      evalseal_adopted: (adopted_stage($receipts; "evalseal")),
      effectdelta_adopted: (adopted_stage($receipts; "effectdelta")),
      receipt_count: ((if $sp != null then 1 else 0 end) + ($receipts | length))
    }
  )
'

ENRICHED=$(echo "$DEVFLOW_ENTRIES" | jq -c "$JQ_ENRICH")

TRUST_ACTIVE_RUNS=$(echo "$ENRICHED" | jq '[.[] | select(.is_active)] | length')

# ----------------------------------------------------------------------------
# (1) layer_status
# ----------------------------------------------------------------------------

LAYER_STATUS=$(echo "$ENRICHED" | jq -c '
  def vr_dist($raw_key; $adopted_key):
    ( [ .[] | .[$adopted_key][]? ] ) as $adopted |
    ( [ .[] | .[$raw_key][]? | select(.invalidated == true) ] ) as $invalidated |
    {
      verdict_reason: ( $adopted | group_by([.verdict, .reason_code]) | map({verdict: .[0].verdict, reason_code: .[0].reason_code, count: length}) ),
      invalidated_count: ($invalidated | length)
    };

  def vr_dist_with_stage($raw_key; $adopted_key):
    vr_dist($raw_key; $adopted_key) as $base |
    ( [ .[] | .[$adopted_key][]? ] ) as $adopted |
    $base + { stages: ( $adopted | group_by(.stage) | map({stage: .[0].stage, count: length}) ) };

  {
    surfaceproof: vr_dist("surfaceproof_raw"; "surfaceproof_raw"),
    evalseal: vr_dist_with_stage("evalseal_raw"; "evalseal_adopted"),
    effectdelta: vr_dist_with_stage("effectdelta_raw"; "effectdelta_adopted")
  }
')

# ----------------------------------------------------------------------------
# (2) missing_receipt (denominator = trust_active_runs)
# ----------------------------------------------------------------------------

MISSING_RECEIPT=$(echo "$ENRICHED" | jq -c --argjson active "$TRUST_ACTIVE_RUNS" '
  [.[] | select(.is_active)] as $runs |

  def layer_missing(has_expr):
    ( [ $runs[] | select(has_expr | not) | .run_id ] | sort ) as $miss |
    {
      count: ($miss | length),
      rate: (if $active > 0 then (($miss | length) / $active) else null end),
      runs: $miss
    };

  def evalseal_reason_distribution:
    ( [ $runs[] | select((.evalseal_adopted | length) == 0) | (.evalseal_missing_reason // "unrecorded") ] ) as $reasons |
    ( $reasons | group_by(.) | map({key: .[0], value: length}) | from_entries );

  def effectdelta_pr_reason_distribution:
    ( [ $runs[] | select(([.effectdelta_adopted[]? | select(.stage == "pr")] | length) == 0) | (.effectdelta_pr_missing_reason // "unrecorded") ] ) as $reasons |
    ( $reasons | group_by(.) | map({key: .[0], value: length}) | from_entries );

  ( layer_missing(.surfaceproof_raw | length > 0) ) as $sp |
  ( layer_missing(.evalseal_adopted | length > 0) + { reason_distribution: evalseal_reason_distribution } ) as $es |
  ( layer_missing(.effectdelta_adopted | length > 0) + { pr_stage_reason_distribution: effectdelta_pr_reason_distribution } ) as $ed |

  ( [ $runs[] | select(
      (.surfaceproof_raw | length > 0) and
      (.evalseal_adopted | length > 0) and
      (.effectdelta_adopted | length > 0)
    ) ] | length ) as $all_present |

  {
    denominator: $active,
    surfaceproof: $sp,
    evalseal: $es,
    effectdelta: $ed,
    overall_receipt_success_rate: (if $active > 0 then ($all_present / $active) else null end)
  }
')

# ----------------------------------------------------------------------------
# (3) inconclusive
# ----------------------------------------------------------------------------

INCONCLUSIVE=$(echo "$ENRICHED" | jq -c --argjson active "$TRUST_ACTIVE_RUNS" '
  [.[] | select(.is_active)] as $runs |

  ( [ $runs[] | (.surfaceproof_raw + .evalseal_adopted + .effectdelta_adopted)[] ] ) as $adopted |
  ( $adopted | length ) as $receipt_denom |
  ( [ $adopted[] | select(.verdict == "inconclusive") ] ) as $inc_receipts |
  ( $inc_receipts | length ) as $receipt_count |

  ( [ $runs[] | select(
      [ (.surfaceproof_raw + .evalseal_adopted + .effectdelta_adopted)[] | select(.verdict == "inconclusive") ] | length > 0
    ) ] ) as $hit_runs |

  {
    receipt_denominator: $receipt_denom,
    receipt_count: $receipt_count,
    receipt_rate: (if $receipt_denom > 0 then ($receipt_count / $receipt_denom) else null end),
    run_denominator: $active,
    run_count: ($hit_runs | length),
    run_rate: (if $active > 0 then (($hit_runs | length) / $active) else null end),
    reason_code_distribution: ( $inc_receipts | group_by(.reason_code) | map({reason_code: .[0].reason_code, count: length}) ),
    runs: ( [ $hit_runs[] | .run_id ] | sort )
  }
')

# ----------------------------------------------------------------------------
# (4) effect_mismatch (effectdelta layer only)
# ----------------------------------------------------------------------------

EFFECT_MISMATCH=$(echo "$ENRICHED" | jq -c '
  [.[] | select(.effectdelta_adopted | length > 0)] as $runs |
  ( $runs | length ) as $denom |

  ( [ $runs[] | select( [ .effectdelta_adopted[] | select((.verdict == "fail") or ((.domain_reason_code // null) == "DUPLICATE_EFFECT") or ((.domain_reason_code // null) == "WRONG_TARGET")) ] | length > 0 ) ] ) as $hits |

  ( [ $runs[] | .effectdelta_adopted[] | select((.domain_reason_code // null) != null) ] ) as $domain_receipts |

  {
    denominator: $denom,
    count: ($hits | length),
    rate: (if $denom > 0 then (($hits | length) / $denom) else null end),
    domain_reason_code_distribution: ( $domain_receipts | group_by(.domain_reason_code) | map({domain_reason_code: .[0].domain_reason_code, count: length}) ),
    runs: ( [ $hits[] | .run_id ] | sort )
  }
')

# ----------------------------------------------------------------------------
# (5) false_completion (denominator = trust_active_runs, all layers combined)
# ----------------------------------------------------------------------------

FALSE_COMPLETION=$(echo "$ENRICHED" | jq -c --argjson active "$TRUST_ACTIVE_RUNS" '
  [.[] | select(.is_active)] as $runs |

  ( [ $runs[] | select(
      (.eval_verdict == "pass") and
      ( [ (.surfaceproof_raw + .evalseal_adopted + .effectdelta_adopted)[] | select(.verdict == "fail") ] | length > 0 )
    ) ] ) as $hits |

  {
    denominator: $active,
    count: ($hits | length),
    rate: (if $active > 0 then (($hits | length) / $active) else null end),
    runs: ( [ $hits[] | .run_id ] | sort )
  }
')

# ----------------------------------------------------------------------------
# (6) latency (trust_active vs trust_inactive)
# ----------------------------------------------------------------------------

PHASE_NAMES='["analyze","plan","implement","validate","evaluate","pr","iterate","final"]'

LATENCY=$(echo "$ENRICHED" | jq -c --argjson phases "$PHASE_NAMES" "
  $JQ_STATS_LIB
  def population_stats(\$pop):
    {
      duration_seconds: ( [ \$pop[] | .duration_seconds ] | stats_from(.) ),
      phase_durations: ( \$phases | map(. as \$phase | { (\$phase): ( [ \$pop[] | .phase_durations[\$phase] ] | stats_from(.)) }) | add // {} )
    };

  [.[] | select(.is_active)] as \$active_pop |
  [.[] | select(.is_active | not)] as \$inactive_pop |

  ( population_stats(\$active_pop) ) as \$active_stats |
  ( population_stats(\$inactive_pop) ) as \$inactive_stats |

  {
    trust_active: \$active_stats,
    trust_inactive: \$inactive_stats,
    trust_added_p95_seconds: (
      if (\$active_stats.duration_seconds.p95 != null) and (\$inactive_stats.duration_seconds.p95 != null)
      then (\$active_stats.duration_seconds.p95 - \$inactive_stats.duration_seconds.p95)
      else null
      end
    )
  }
")

# ----------------------------------------------------------------------------
# (7) cost_proxy (trust receipts per run, trust-active population only)
# ----------------------------------------------------------------------------

COST_PROXY=$(echo "$ENRICHED" | jq -c "
  $JQ_STATS_LIB
  [.[] | select(.is_active) | .receipt_count] as \$vals |
  stats_from(\$vals) + {
    note: \"No direct trust-layer cost telemetry exists; this proxies cost via trust receipt count per run (epic #390 Phase 5).\"
  }
")

# ----------------------------------------------------------------------------
# (8) --slo (optional): Go/No-Go against the initial SLO hypothesis
# ----------------------------------------------------------------------------

SLO_JSON=""
if [[ "$WITH_SLO" == true ]]; then
  SLO_JSON=$(jq -n \
    --argjson eligible "$TRUST_ACTIVE_RUNS" \
    --argjson receipt_success_rate "$(echo "$MISSING_RECEIPT" | jq -c '.overall_receipt_success_rate')" \
    --argjson inconclusive_rate "$(echo "$INCONCLUSIVE" | jq -c '.run_rate')" \
    --argjson added_p95_seconds "$(echo "$LATENCY" | jq -c '.trust_added_p95_seconds')" \
    '
    ($eligible >= 20) as $has_min_runs |
    (20) as $min_runs |
    (0.99) as $receipt_success_min |
    (0.01) as $inconclusive_max |
    (180) as $added_p95_max_seconds |

    [
      (if $has_min_runs then empty else "INSUFFICIENT_RUNS" end),
      (if ($receipt_success_rate != null) and ($receipt_success_rate < $receipt_success_min) then "RECEIPT_SUCCESS_BELOW_SLO" else empty end),
      (if ($inconclusive_rate != null) and ($inconclusive_rate > $inconclusive_max) then "INCONCLUSIVE_ABOVE_SLO" else empty end),
      (if $added_p95_seconds == null then "LATENCY_UNMEASURABLE"
       elif $added_p95_seconds > $added_p95_max_seconds then "LATENCY_P95_ABOVE_SLO"
       else empty end)
    ] as $reasons |

    {
      eligible_runs: $eligible,
      min_runs: $min_runs,
      receipt_success_rate: $receipt_success_rate,
      inconclusive_rate: $inconclusive_rate,
      added_p95_seconds: $added_p95_seconds,
      thresholds: {
        receipt_success_min: $receipt_success_min,
        inconclusive_max: $inconclusive_max,
        added_p95_max_seconds: $added_p95_max_seconds
      },
      go_no_go: (if ($reasons | length) == 0 then "go" else "no-go" end),
      reasons: $reasons
    }
  ')
fi

# ----------------------------------------------------------------------------
# Final assembly
# ----------------------------------------------------------------------------

REPORT=$(jq -n \
  --arg window "$WINDOW" \
  --arg since "$SINCE_ISO" \
  --arg until "$UNTIL_ISO" \
  --arg taken_at "$TAKEN_AT" \
  --argjson total "$TOTAL_RUNS" \
  --argjson trust_active "$TRUST_ACTIVE_RUNS" \
  --argjson layer_status "$LAYER_STATUS" \
  --argjson missing_receipt "$MISSING_RECEIPT" \
  --argjson inconclusive "$INCONCLUSIVE" \
  --argjson effect_mismatch "$EFFECT_MISMATCH" \
  --argjson false_completion "$FALSE_COMPLETION" \
  --argjson latency "$LATENCY" \
  --argjson cost_proxy "$COST_PROXY" \
  --argjson with_slo "$([[ "$WITH_SLO" == true ]] && echo true || echo false)" \
  --argjson slo "${SLO_JSON:-null}" \
  '{
    schema: "trust-receipts-report/v1",
    version: "1.0.0",
    window: $window,
    since: $since,
    until: (if $until == "" then null else $until end),
    taken_at: $taken_at,
    total_runs: $total,
    trust_active_runs: $trust_active,
    layer_status: $layer_status,
    missing_receipt: $missing_receipt,
    inconclusive: $inconclusive,
    effect_mismatch: $effect_mismatch,
    false_completion: $false_completion,
    latency: $latency,
    cost_proxy: $cost_proxy
  } + (if $with_slo then { slo: $slo } else {} end)')

if [[ -n "$OUT_PATH" ]]; then
  mkdir -p "$(dirname "$OUT_PATH")"
  printf '%s\n' "$REPORT" > "$OUT_PATH"
else
  printf '%s\n' "$REPORT"
fi
