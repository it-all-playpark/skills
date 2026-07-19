#!/usr/bin/env bash
set -euo pipefail

# run-diagnostics.sh - Run all diagnostic checks and output structured results
# Usage: run-diagnostics.sh [--scope full|journal|worktrees|config|telemetry|feedback] [--window <dur>]
#                            [--compare <baseline-path>] [--update-baseline <path>]
# Output: JSON with diagnostic results
#
# AC4/AC5 (issue #83): --compare invokes compare-baseline.sh and adds a
# `baseline_compare` section to checks plus regression penalty (max -15).
# --update-baseline delegates to baseline-snapshot.sh and writes the snapshot
# to the given path; warns to stderr if total_entries == 0.
#
# --canary (issue #325 T2): delegates to validate-canary-report.sh and adds
# an informational `checks.canary` section (dev-flow-canary report intake).
# This check is purely advisory (fail-open) and NEVER affects the health
# score — mirrors the ci-checks proxy precedent (AGENTS.md exec-proxy 失敗
# ポリシー表). Validation failure / missing script -> checks.canary =
# {status:"unavailable", reason} + warn issue, continues (no die).

SCRIPT_DIR_RD="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR_RD/../../_lib/common.sh"

# ============================================================================
# Defaults & Args
# ============================================================================

SCOPE="full"
WINDOW="30d"
COMPARE_PATH=""
UPDATE_BASELINE_PATH=""
CANARY_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope) SCOPE="$2"; shift 2 ;;
    --window) WINDOW="$2"; shift 2 ;;
    --compare) COMPARE_PATH="$2"; shift 2 ;;
    --update-baseline) UPDATE_BASELINE_PATH="$2"; shift 2 ;;
    --canary) CANARY_PATH="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: run-diagnostics.sh [--scope full|journal|worktrees|config|telemetry|feedback] [--window <dur>] [--compare <path>] [--update-baseline <path>] [--canary <path>]"
      exit 0
      ;;
    *) die_json "Unknown argument: $1" 1 ;;
  esac
done

# --update-baseline mode: delegate to baseline-snapshot.sh and exit.
# Issue #83 AC2 / A6: run-diagnostics.sh is the sole owner of --update-baseline.
if [[ -n "$UPDATE_BASELINE_PATH" ]]; then
  SNAPSHOT_SH="$SCRIPT_DIR_RD/baseline-snapshot.sh"
  if [[ ! -x "$SNAPSHOT_SH" ]]; then
    die_json "baseline-snapshot.sh not found at $SNAPSHOT_SH" 1
  fi
  mkdir -p "$(dirname "$UPDATE_BASELINE_PATH")"
  if ! "$SNAPSHOT_SH" --window "$WINDOW" --out "$UPDATE_BASELINE_PATH"; then
    die_json "baseline-snapshot.sh failed when writing $UPDATE_BASELINE_PATH" 1
  fi
  # Warning if total_entries == 0 (vacuous baseline)
  TOTAL_ENTRIES_OUT=$(jq -r '.total_entries // 0' "$UPDATE_BASELINE_PATH" 2>/dev/null || echo 0)
  if [[ "$TOTAL_ENTRIES_OUT" -eq 0 ]]; then
    echo "WARNING: baseline written to $UPDATE_BASELINE_PATH has total_entries == 0 (empty journal). Regression check will be vacuous until populated." >&2
  fi
  jq -n --arg path "$UPDATE_BASELINE_PATH" --argjson total "$TOTAL_ENTRIES_OUT" \
    '{status: "baseline_updated", path: $path, total_entries: $total}'
  exit 0
fi

case "$SCOPE" in
  full|journal|worktrees|config|telemetry|feedback) ;;
  *) die_json "Invalid scope: $SCOPE (must be full|journal|worktrees|config|telemetry|feedback)" 1 ;;
esac

require_cmd "jq" "jq is required for diagnostics"

# ============================================================================
# Journal script resolution
# ============================================================================

JOURNAL_SH="${SKILLS_DIR}/skill-retrospective/scripts/journal.sh"
HAS_JOURNAL=false
if [[ -x "$JOURNAL_SH" ]]; then
  HAS_JOURNAL=true
fi

# ============================================================================
# Initialize results
# ============================================================================

ISSUES="[]"
CHECKS="{}"
SCORE=100

add_issue() {
  local severity="$1" message="$2"
  ISSUES=$(echo "$ISSUES" | jq --arg sev "$severity" --arg msg "$message" '. + [{severity: $sev, message: $msg}]')
}

# Helper: clamp subtraction (score cannot go below 0)
subtract_score() {
  local amount="$1" max="$2"
  local actual=$amount
  if [[ $actual -gt $max ]]; then
    actual=$max
  fi
  SCORE=$((SCORE - actual))
  if [[ $SCORE -lt 0 ]]; then
    SCORE=0
  fi
}

# ============================================================================
# Check: Journal diagnostics
# ============================================================================

run_journal_checks() {
  if [[ "$HAS_JOURNAL" != "true" ]]; then
    CHECKS=$(echo "$CHECKS" | jq '.journal = {"status": "skipped", "reason": "journal.sh not found"}')
    add_issue "info" "journal.sh not found at ${JOURNAL_SH} — journal checks skipped"
    return
  fi

  local journal_data=""
  journal_data=$("$JOURNAL_SH" query --skill dev-flow --limit 200 --source skill 2>/dev/null || echo "[]")

  # Validate journal_data is valid JSON array
  if ! echo "$journal_data" | jq -e 'type == "array"' >/dev/null 2>&1; then
    journal_data="[]"
  fi

  local total_entries
  total_entries=$(echo "$journal_data" | jq 'length')

  if [[ "$total_entries" -eq 0 ]]; then
    CHECKS=$(echo "$CHECKS" | jq '.journal = {"status": "no_data", "total_entries": 0}')
    add_issue "info" "No journal entries found for dev-flow"
    return
  fi

  # --- Check 2: Failure & Partial Distribution ---
  local failure_dist
  failure_dist=$(echo "$journal_data" | jq '
    [.[] | select(.outcome == "failure" or .outcome == "partial")] |
    if length == 0 then []
    else
      group_by(.error.phase // "unknown") |
      map({phase: .[0].error.phase // "unknown", count: length}) |
      sort_by(-.count)
    end
  ' 2>/dev/null || echo "[]")

  # --- Check 3: Error Categories (via stats) ---
  local stats_data=""
  stats_data=$("$JOURNAL_SH" stats --source skill 2>/dev/null || echo "{}")
  if ! echo "$stats_data" | jq -e 'type == "object"' >/dev/null 2>&1; then
    stats_data="{}"
  fi

  local error_categories
  error_categories=$(echo "$stats_data" | jq '.by_category // {}' 2>/dev/null || echo "{}")

  # --- Check 5: Average Recovery Turns ---
  local avg_recovery
  avg_recovery=$(echo "$stats_data" | jq '.avg_recovery_turns // null' 2>/dev/null || echo "null")

  # --- Check 6: Success Rate Trend ---
  local recent_stats=""
  recent_stats=$("$JOURNAL_SH" stats --since 7d --source skill 2>/dev/null || echo "{}")
  if ! echo "$recent_stats" | jq -e 'type == "object"' >/dev/null 2>&1; then
    recent_stats="{}"
  fi

  local overall_success_rate recent_success_rate
  overall_success_rate=$(echo "$stats_data" | jq '.success_rate // null' 2>/dev/null || echo "null")
  recent_success_rate=$(echo "$recent_stats" | jq '.success_rate // null' 2>/dev/null || echo "null")

  local trend="unknown"
  if [[ "$overall_success_rate" != "null" && "$recent_success_rate" != "null" ]]; then
    local diff
    diff=$(echo "$recent_success_rate $overall_success_rate" | awk '{printf "%.1f", $1 - $2}')
    if (( $(echo "$diff > 5" | bc -l 2>/dev/null || echo 0) )); then
      trend="improving"
    elif (( $(echo "$diff < -5" | bc -l 2>/dev/null || echo 0) )); then
      trend="declining"
      add_issue "warn" "Success rate declining: recent ${recent_success_rate}% vs overall ${overall_success_rate}%"
    else
      trend="stable"
    fi
  fi

  # --- Check 7: Duration Outliers ---
  local duration_result
  duration_result=$(echo "$journal_data" | jq '
    if length == 0 then {average_turns: 0, outliers: [], outlier_count: 0}
    else
      (map(.duration_turns // 0) | add / length) as $avg |
      {
        average_turns: ($avg | . * 10 | round / 10),
        outliers: [.[] | select((.duration_turns // 0) > ($avg * 3))] |
          map({issue: .context.issue, turns: .duration_turns}),
        outlier_count: ([.[] | select((.duration_turns // 0) > ($avg * 3))] | length)
      }
    end
  ' 2>/dev/null || echo '{"average_turns": 0, "outliers": [], "outlier_count": 0}')

  # --- Calculate outcome counts ---
  local success_count failure_count partial_count
  success_count=$(echo "$journal_data" | jq '[.[] | select(.outcome == "success")] | length')
  failure_count=$(echo "$journal_data" | jq '[.[] | select(.outcome == "failure")] | length')
  partial_count=$(echo "$journal_data" | jq '[.[] | select(.outcome == "partial")] | length')

  # --- Scoring: failure_rate ---
  if [[ "$total_entries" -gt 0 ]]; then
    local failure_rate_pct
    failure_rate_pct=$(echo "$failure_count $partial_count $total_entries" | awk '{printf "%.0f", ($1 + $2) / $3 * 100}')
    local failure_penalty
    failure_penalty=$(echo "$failure_rate_pct" | awk '{v = int($1 * 0.3); if(v > 30) v = 30; print v}')
    subtract_score "$failure_penalty" 30
  fi

  # --- Scoring: avg_recovery_turns ---
  if [[ "$avg_recovery" != "null" ]]; then
    local recovery_penalty
    recovery_penalty=$(echo "$avg_recovery" | awk '{v = int($1 * 5); if(v > 25) v = 25; print v}')
    subtract_score "$recovery_penalty" 25
  fi

  # --- Scoring: duration_outlier_pct ---
  local outlier_count
  outlier_count=$(echo "$duration_result" | jq '.outlier_count // 0')
  if [[ "$total_entries" -gt 0 && "$outlier_count" -gt 0 ]]; then
    local outlier_pct_penalty
    outlier_pct_penalty=$(echo "$outlier_count $total_entries" | awk '{v = int($1 / $2 * 100 * 0.1); if(v > 10) v = 10; print v}')
    subtract_score "$outlier_pct_penalty" 10
  fi

  # --- Scoring: env_errors_pct ---
  local env_errors=0
  env_errors=$(echo "$error_categories" | jq '.env // 0' 2>/dev/null || echo 0)
  if [[ "$total_entries" -gt 0 && "$env_errors" -gt 0 ]]; then
    local env_penalty
    env_penalty=$(echo "$env_errors $total_entries" | awk '{v = int($1 / $2 * 100 * 0.15); if(v > 15) v = 15; print v}')
    subtract_score "$env_penalty" 15
  fi

  # --- Issues from journal ---
  if [[ "$avg_recovery" != "null" ]]; then
    local avg_val
    avg_val=$(echo "$avg_recovery" | awk '{print int($1 * 10) / 10}')
    if (( $(echo "$avg_recovery > 5.0" | bc -l 2>/dev/null || echo 0) )); then
      add_issue "warn" "High average recovery turns: ${avg_val}"
    elif (( $(echo "$avg_recovery > 2.0" | bc -l 2>/dev/null || echo 0) )); then
      add_issue "info" "Average recovery turns: ${avg_val} (fair)"
    fi
  fi

  # Build journal checks object
  CHECKS=$(echo "$CHECKS" | jq \
    --argjson failure_dist "$failure_dist" \
    --argjson error_cat "$error_categories" \
    --argjson avg_rec "$avg_recovery" \
    --arg trend "$trend" \
    --argjson dur "$duration_result" \
    --argjson total "$total_entries" \
    --argjson success "$success_count" \
    --argjson failure "$failure_count" \
    --argjson partial "$partial_count" \
    '.journal = {
      total_entries: $total,
      success: $success,
      failure: $failure,
      partial: $partial,
      failure_distribution: $failure_dist,
      error_categories: $error_cat,
      avg_recovery_turns: $avg_rec,
      success_trend: $trend,
      duration_analysis: $dur
    }')
}

# ============================================================================
# Check: Worktree Health
# ============================================================================

run_worktree_checks() {
  local git_root
  git_root=$(git_root) || true

  if [[ -z "$git_root" ]]; then
    CHECKS=$(echo "$CHECKS" | jq '.worktree_health = {"status": "skipped", "reason": "Not in a git repository"}')
    add_issue "info" "Worktree checks skipped: not in a git repository"
    return
  fi

  # Registered worktrees
  local worktree_list
  worktree_list=$(git worktree list --porcelain 2>/dev/null || echo "")
  local registered_count
  registered_count=$(echo "$worktree_list" | grep -c "^worktree " 2>/dev/null || echo 0)

  # Check for orphaned/stale worktree directories
  local repo_name
  repo_name=$(basename "$git_root")
  local worktree_base="${git_root}/../${repo_name}-worktrees"

  local stale_count=0
  local orphaned_count=0
  local stale_dirs="[]"
  local orphaned_dirs="[]"

  if [[ -d "$worktree_base" ]]; then
    # Check each subdirectory
    for wt_dir in "$worktree_base"/*/; do
      [[ -d "$wt_dir" ]] || continue
      local dir_name
      dir_name=$(basename "$wt_dir")

      # Check if registered as git worktree
      if ! git worktree list 2>/dev/null | grep -q "$wt_dir"; then
        orphaned_count=$((orphaned_count + 1))
        orphaned_dirs=$(echo "$orphaned_dirs" | jq --arg d "$wt_dir" '. + [$d]')
      fi

      # Check staleness (>7 days since last modification)
      local mod_time now age_days
      mod_time=$(stat -f %m "$wt_dir" 2>/dev/null || stat -c %Y "$wt_dir" 2>/dev/null || echo 0)
      now=$(now_sec 2>/dev/null || echo 0)
      # Numeric guard: normalize non-numeric / empty values to 0
      [[ "$mod_time" =~ ^[0-9]+$ ]] || mod_time=0
      [[ "$now" =~ ^[0-9]+$ ]] || now=0
      age_days=$(( (${now:-0} - ${mod_time:-0}) / 86400 ))
      # Timestamp unavailable guard: skip stale classification when timestamps could not be read
      if [[ "$mod_time" -eq 0 || "$now" -eq 0 ]]; then
        age_days=0
      fi
      if [[ $age_days -gt 7 ]]; then
        stale_count=$((stale_count + 1))
        stale_dirs=$(echo "$stale_dirs" | jq --arg d "$wt_dir" --argjson days "$age_days" '. + [{path: $d, age_days: $days}]')
      fi
    done
  fi

  # Scoring: stale worktrees
  if [[ $stale_count -gt 0 ]]; then
    local stale_penalty=$((stale_count * 2))
    subtract_score "$stale_penalty" 10
    add_issue "warn" "${stale_count} stale worktree(s) found (>7 days old)"
  fi

  # Scoring: orphaned directories
  if [[ $orphaned_count -gt 0 ]]; then
    local orphan_penalty=$((orphaned_count * 3))
    subtract_score "$orphan_penalty" 15
    add_issue "warn" "${orphaned_count} orphaned worktree directory(s) not registered in git"
  fi

  CHECKS=$(echo "$CHECKS" | jq \
    --argjson reg "$registered_count" \
    --argjson stale "$stale_count" \
    --argjson orphaned "$orphaned_count" \
    --argjson stale_dirs "$stale_dirs" \
    --argjson orphaned_dirs "$orphaned_dirs" \
    '.worktree_health = {
      registered_worktrees: $reg,
      stale_worktrees: $stale,
      orphaned_directories: $orphaned,
      stale_details: $stale_dirs,
      orphaned_details: $orphaned_dirs
    }')
}

# ============================================================================
# Check: Config Validation
# ============================================================================

run_config_checks() {
  local global_config=""
  local candidates=("${SKILL_CONFIG_PATH:-}" "${HOME}/.config/skills/config.json" "${HOME}/.claude/skill-config.json")
  for c in "${candidates[@]}"; do
    [[ -n "$c" && -f "$c" ]] && { global_config="$c"; break; }
  done
  local project_config=""
  local git_root
  git_root=$(git_root) || true
  if [[ -n "$git_root" ]]; then
    for rel in "skill-config.json" ".claude/skill-config.json"; do
      [[ -f "${git_root}/${rel}" ]] && { project_config="${git_root}/${rel}"; break; }
    done
  fi

  local global_valid=false
  local project_valid=false
  local global_exists=false
  local project_exists=false

  if [[ -f "$global_config" ]]; then
    global_exists=true
    if jq empty "$global_config" 2>/dev/null; then
      global_valid=true
    else
      add_issue "error" "Global skill-config.json is invalid JSON: ${global_config}"
    fi
  else
    add_issue "info" "No global skill-config.json found at ${global_config}"
  fi

  if [[ -n "$project_config" && -f "$project_config" ]]; then
    project_exists=true
    if jq empty "$project_config" 2>/dev/null; then
      project_valid=true
    else
      add_issue "error" "Project skill-config.json is invalid JSON: ${project_config}"
    fi
  fi

  CHECKS=$(echo "$CHECKS" | jq \
    --argjson ge "$global_exists" \
    --argjson gv "$global_valid" \
    --argjson pe "$project_exists" \
    --argjson pv "$project_valid" \
    '.config = {
      global: {exists: $ge, valid: $gv},
      project: {exists: $pe, valid: $pv}
    }')
}

# ============================================================================
# Check: Dev-Flow Telemetry Health (journal-driven)
# ============================================================================

run_telemetry_checks() {
  local analyze_sh="$SCRIPT_DIR_RD/analyze-dev-flow-telemetry.sh"
  if [[ ! -x "$analyze_sh" ]]; then
    CHECKS=$(echo "$CHECKS" | jq '.dev_flow_telemetry = {"status": "skipped", "reason": "analyze-dev-flow-telemetry.sh not found"}')
    add_issue "info" "analyze-dev-flow-telemetry.sh not found — telemetry checks skipped"
    return
  fi

  local telemetry_data
  if ! telemetry_data=$("$analyze_sh" --window "$WINDOW" 2>/dev/null); then
    CHECKS=$(echo "$CHECKS" | jq '.dev_flow_telemetry = {"status": "error", "reason": "analyze-dev-flow-telemetry.sh failed"}')
    add_issue "warn" "analyze-dev-flow-telemetry.sh failed — telemetry checks skipped"
    return
  fi

  # Validate JSON object
  if ! echo "$telemetry_data" | jq -e 'type == "object"' >/dev/null 2>&1; then
    CHECKS=$(echo "$CHECKS" | jq '.dev_flow_telemetry = {"status": "error", "reason": "invalid JSON from analyze-dev-flow-telemetry.sh"}')
    add_issue "warn" "analyze-dev-flow-telemetry.sh produced invalid JSON"
    return
  fi

  # Cold-start guard: zero dev-flow runs in the window -> insufficient data,
  # skip anomaly penalties entirely (mirrors the old family-check cold-start
  # guard so a new/idle environment does not get a false-positive penalty).
  local total_runs
  total_runs=$(echo "$telemetry_data" | jq '.total_dev_flow_runs // 0')
  if [[ "$total_runs" -eq 0 ]]; then
    add_issue "info" "Dev-flow telemetry has no entries in ${WINDOW} — insufficient data, telemetry checks skipped"
    CHECKS=$(echo "$CHECKS" | jq --argjson t "$telemetry_data" '.dev_flow_telemetry = ($t + {status: "insufficient_data"})')
    return
  fi

  # Issues from anomalies (severity: warn only; skipped anomalies are
  # informational and never penalized/warned).
  local anomaly
  while IFS= read -r anomaly; do
    local sev atype msg
    sev=$(echo "$anomaly" | jq -r '.severity')
    [[ "$sev" != "warn" ]] && continue
    atype=$(echo "$anomaly" | jq -r '.type')
    case "$atype" in
      cap_pinned)
        local count
        count=$(echo "$anomaly" | jq -r '.count // 0')
        msg="Cap張り付き検出 (${WINDOW}): ${count}件が eval_iter/plan_iter cap に到達"
        ;;
      iterate_unhealthy)
        local rate_pct
        rate_pct=$(echo "$anomaly" | jq -r '(.rate * 100 | round)')
        msg="iterate不調率が高い (${WINDOW}): ${rate_pct}% が非lgtmで終了"
        ;;
      micro_nonfiring)
        msg="micro shape不発火 (${WINDOW}): run数は十分だが micro が0件"
        ;;
      vdelta_unhealthy)
        local rate_pct
        rate_pct=$(echo "$anomaly" | jq -r '(.rate * 100 | round)')
        msg="vdelta verdict 低情報率が高い (${WINDOW}): ${rate_pct}% が inconclusive+null"
        ;;
      *)
        msg="Anomaly detected (${WINDOW}): ${atype}"
        ;;
    esac
    add_issue "warn" "$msg"
  done < <(echo "$telemetry_data" | jq -c '.anomalies[]')

  # Scoring: anomaly penalties (each capped at -5, total capped at -15).
  # severity == "skipped" (e.g. micro_nonfiring insufficient_data) never
  # contributes to the penalty.
  local anomaly_penalty=0
  local sev
  while IFS= read -r sev; do
    [[ "$sev" != "warn" ]] && continue
    anomaly_penalty=$((anomaly_penalty + 5))
  done < <(echo "$telemetry_data" | jq -r '.anomalies[].severity')
  if [[ $anomaly_penalty -gt 15 ]]; then anomaly_penalty=15; fi
  if [[ $anomaly_penalty -gt 0 ]]; then
    subtract_score "$anomaly_penalty" 15
  fi

  CHECKS=$(echo "$CHECKS" | jq --argjson t "$telemetry_data" '.dev_flow_telemetry = ($t + {status: "ok"})')
}

# ============================================================================
# Check 11: Baseline regression (issue #83 AC4/AC5)
# ============================================================================

run_baseline_compare_check() {
  if [[ -z "$COMPARE_PATH" ]]; then
    return
  fi
  local snapshot_sh="$SCRIPT_DIR_RD/baseline-snapshot.sh"
  local compare_sh="$SCRIPT_DIR_RD/compare-baseline.sh"
  if [[ ! -x "$snapshot_sh" || ! -x "$compare_sh" ]]; then
    CHECKS=$(echo "$CHECKS" | jq '.baseline_compare = {"status":"skipped","reason":"baseline-snapshot.sh or compare-baseline.sh not found"}')
    return
  fi
  if [[ ! -f "$COMPARE_PATH" ]]; then
    CHECKS=$(echo "$CHECKS" | jq --arg p "$COMPARE_PATH" '.baseline_compare = {"status":"skipped","reason":("baseline file not found: " + $p)}')
    return
  fi

  # Extract baseline.window (or default)
  local baseline_window
  baseline_window=$(jq -r '.window // "30d"' "$COMPARE_PATH" 2>/dev/null || echo "30d")

  # Generate current snapshot to a temp file
  local current_tmp
  current_tmp=$(mktemp -t dffd-cmp-current-XXXXXX.json)
  if ! "$snapshot_sh" --window "$baseline_window" --out "$current_tmp" 2>/dev/null; then
    rm -f "$current_tmp"
    CHECKS=$(echo "$CHECKS" | jq '.baseline_compare = {"status":"error","reason":"failed to generate current snapshot"}')
    add_issue "warn" "baseline_compare: failed to generate current snapshot"
    return
  fi

  local compare_out compare_rc
  compare_out=$("$compare_sh" --baseline "$COMPARE_PATH" --current "$current_tmp" 2>/dev/null || true)
  set +e
  "$compare_sh" --baseline "$COMPARE_PATH" --current "$current_tmp" >/dev/null 2>&1
  compare_rc=$?
  set -e
  rm -f "$current_tmp"

  if ! echo "$compare_out" | jq empty 2>/dev/null; then
    CHECKS=$(echo "$CHECKS" | jq '.baseline_compare = {"status":"error","reason":"compare-baseline.sh produced invalid JSON"}')
    add_issue "warn" "baseline_compare: invalid JSON from compare-baseline.sh"
    return
  fi

  # Apply penalty: -5 per critical finding, max -15
  local critical_count
  critical_count=$(echo "$compare_out" | jq '[.findings[] | select(.severity == "critical")] | length')
  local error_count
  error_count=$(echo "$compare_out" | jq '[.findings[] | select(.severity == "error")] | length')

  if [[ "$critical_count" -gt 0 ]]; then
    local penalty=$((critical_count * 5))
    if [[ $penalty -gt 15 ]]; then penalty=15; fi
    subtract_score "$penalty" 15
    add_issue "warn" "Baseline regression: ${critical_count} critical finding(s) (penalty -${penalty})"
  fi
  if [[ "$error_count" -gt 0 ]]; then
    add_issue "info" "Baseline compare error: ${error_count} (window mismatch / corrupt baseline / IO error)"
  fi

  CHECKS=$(echo "$CHECKS" | jq \
    --argjson cmp "$compare_out" \
    --argjson rc "$compare_rc" \
    '.baseline_compare = ($cmp + {exit_code: $rc, status: "ok"})')
}

# ============================================================================
# Check 12: Canary report intake (issue #325 T2)
# ============================================================================
# Advisory only — never contributes to SCORE. Delegates schema validation to
# validate-canary-report.sh (decisive/deterministic). Failure modes:
#   - CANARY_PATH empty            -> no-op, checks.canary is absent
#   - validate script missing      -> checks.canary.status = "unavailable"
#   - validate exits non-zero      -> checks.canary.status = "unavailable"
#   - validate stdout not a JSON object -> checks.canary.status = "unavailable"
# All "unavailable" cases add a warn issue but keep exit 0 (fail-open,
# mirrors the ci-checks exec-proxy failure policy in AGENTS.md).
run_canary_check() {
  if [[ -z "$CANARY_PATH" ]]; then
    return
  fi

  local validate_sh="$SCRIPT_DIR_RD/validate-canary-report.sh"
  if [[ ! -x "$validate_sh" ]]; then
    CHECKS=$(echo "$CHECKS" | jq '.canary = {"status":"unavailable","reason":"validate-canary-report.sh not found"}')
    add_issue "warn" "canary: validate-canary-report.sh not found — canary check skipped"
    return
  fi

  local validate_out validate_rc
  set +e
  validate_out=$("$validate_sh" "$CANARY_PATH" 2>/dev/null)
  validate_rc=$?
  set -e

  if [[ $validate_rc -ne 0 ]]; then
    local reason
    reason=$(echo "$validate_out" | jq -r '.error // "validate-canary-report.sh failed"' 2>/dev/null || echo "validate-canary-report.sh failed")
    CHECKS=$(echo "$CHECKS" | jq --arg reason "$reason" '.canary = {status:"unavailable", reason:$reason}')
    add_issue "warn" "canary: report validation failed — ${reason}"
    return
  fi

  if ! echo "$validate_out" | jq -e 'type == "object"' >/dev/null 2>&1; then
    CHECKS=$(echo "$CHECKS" | jq '.canary = {"status":"unavailable","reason":"invalid JSON from validate-canary-report.sh"}')
    add_issue "warn" "canary: invalid JSON from validate-canary-report.sh"
    return
  fi

  local ccv counts failed_ids unsupported_ids bridge_sunset
  ccv=$(echo "$validate_out" | jq -r '.claude_code_version')
  counts=$(echo "$validate_out" | jq -c '.counts')
  failed_ids=$(echo "$validate_out" | jq -c '.failed_ids')
  unsupported_ids=$(echo "$validate_out" | jq -c '.unsupported_ids')
  bridge_sunset=$(echo "$validate_out" | jq -c '.bridge_sunset')

  CHECKS=$(echo "$CHECKS" | jq \
    --arg ccv "$ccv" \
    --argjson counts "$counts" \
    --argjson failed_ids "$failed_ids" \
    --argjson unsupported_ids "$unsupported_ids" \
    --argjson bridge_sunset "$bridge_sunset" \
    '.canary = {
      status: "ok",
      claude_code_version: $ccv,
      counts: $counts,
      failed_ids: $failed_ids,
      unsupported_ids: $unsupported_ids,
      bridge_sunset: $bridge_sunset
    }')

  # Informational only: never touches SCORE. fail>0 OR unsupported includes
  # direct_fs/direct_shell/direct_import -> bridge removal is NOT possible.
  local fail_count bridge_blockers
  fail_count=$(echo "$counts" | jq '.fail')
  bridge_blockers=$(echo "$unsupported_ids" | jq '[.[] | select(. == "direct_fs" or . == "direct_shell" or . == "direct_import")] | length')

  if [[ "$fail_count" -gt 0 || "$bridge_blockers" -gt 0 ]]; then
    add_issue "info" "canary: bridge (exec-proxy/inline generator) removal NOT possible — direct fs/shell/import unsupported"
  fi
}

# ============================================================================
# Run checks based on scope
# ============================================================================

case "$SCOPE" in
  full)
    run_journal_checks
    run_worktree_checks
    run_config_checks
    run_telemetry_checks
    run_baseline_compare_check
    ;;
  journal)
    run_journal_checks
    ;;
  worktrees)
    run_worktree_checks
    ;;
  config)
    run_config_checks
    ;;
  telemetry)
    run_telemetry_checks
    run_baseline_compare_check
    ;;
  feedback)
    # Removed in v2 (no-backcompat) - integration-feedback.json store
    # was deleted along with parallel mode infrastructure.
    die_json "Scope 'feedback' was removed in v2 (parallel-mode infrastructure deleted)." 1
    ;;
esac

run_canary_check

# ============================================================================
# Determine rating
# ============================================================================

RATING="Critical"
if [[ $SCORE -ge 80 ]]; then
  RATING="Healthy"
elif [[ $SCORE -ge 60 ]]; then
  RATING="Fair"
elif [[ $SCORE -ge 40 ]]; then
  RATING="Needs Attention"
fi

# ============================================================================
# Output
# ============================================================================

jq -n \
  --argjson score "$SCORE" \
  --arg rating "$RATING" \
  --arg scope "$SCOPE" \
  --argjson checks "$CHECKS" \
  --argjson issues "$ISSUES" \
  '{
    score: $score,
    rating: $rating,
    scope: $scope,
    score_scope: $scope,
    checks: $checks,
    issues: $issues
  }'
