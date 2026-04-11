#!/usr/bin/env bash
set -euo pipefail

# run-diagnostics.sh - Run all diagnostic checks and output structured results
# Usage: run-diagnostics.sh [--scope full|journal|worktrees|config|family] [--window <dur>]
# Output: JSON with diagnostic results

SCRIPT_DIR_RD="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR_RD/../../_lib/common.sh"

# ============================================================================
# Defaults & Args
# ============================================================================

SCOPE="full"
WINDOW="30d"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope) SCOPE="$2"; shift 2 ;;
    --window) WINDOW="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: run-diagnostics.sh [--scope full|journal|worktrees|config|family] [--window <dur>]"
      exit 0
      ;;
    *) die_json "Unknown argument: $1" 1 ;;
  esac
done

case "$SCOPE" in
  full|journal|worktrees|config|family) ;;
  *) die_json "Invalid scope: $SCOPE (must be full|journal|worktrees|config|family)" 1 ;;
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
  journal_data=$("$JOURNAL_SH" query --skill dev-flow --limit 200 2>/dev/null || echo "[]")

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

  # --- Check 1: Mode Distribution ---
  local mode_dist
  mode_dist=$(echo "$journal_data" | jq '
    group_by(.context.mode // "unknown") |
    map({mode: .[0].context.mode // "unknown", count: length}) |
    sort_by(-.count)
  ' 2>/dev/null || echo "[]")

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
  stats_data=$("$JOURNAL_SH" stats 2>/dev/null || echo "{}")
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
  recent_stats=$("$JOURNAL_SH" stats --since 7d 2>/dev/null || echo "{}")
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
          map({issue: .context.issue, turns: .duration_turns, mode: (.context.mode // "unknown")}),
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
    --argjson mode_dist "$mode_dist" \
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
      mode_distribution: $mode_dist,
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
      local mod_time
      mod_time=$(stat -f %m "$wt_dir" 2>/dev/null || stat -c %Y "$wt_dir" 2>/dev/null || echo 0)
      local now
      now=$(now_sec)
      local age_days=$(( (now - mod_time) / 86400 ))
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
# Check: Dev-Flow Family Connector Health (journal-driven)
# ============================================================================

run_family_checks() {
  local analyze_sh="$SCRIPT_DIR_RD/analyze-dev-flow-family.sh"
  if [[ ! -x "$analyze_sh" ]]; then
    CHECKS=$(echo "$CHECKS" | jq '.dev_flow_family = {"status": "skipped", "reason": "analyze-dev-flow-family.sh not found"}')
    add_issue "info" "analyze-dev-flow-family.sh not found — family checks skipped"
    return
  fi

  local family_data
  if ! family_data=$("$analyze_sh" --window "$WINDOW" 2>/dev/null); then
    CHECKS=$(echo "$CHECKS" | jq '.dev_flow_family = {"status": "error", "reason": "analyze-dev-flow-family.sh failed"}')
    add_issue "warn" "analyze-dev-flow-family.sh failed — family checks skipped"
    return
  fi

  # Validate JSON object
  if ! echo "$family_data" | jq -e 'type == "object"' >/dev/null 2>&1; then
    CHECKS=$(echo "$CHECKS" | jq '.dev_flow_family = {"status": "error", "reason": "invalid JSON from analyze-dev-flow-family.sh"}')
    add_issue "warn" "analyze-dev-flow-family.sh produced invalid JSON"
    return
  fi

  # Cold-start guard: if the dev-flow family has zero total entries in the
  # window, skip the dead/disconnected/stuck penalties entirely to avoid a
  # false-positive -10 baseline on new or long-idle environments.
  local total_family_entries
  total_family_entries=$(echo "$family_data" | jq '[.per_skill[].total] | add // 0')
  if [[ "$total_family_entries" -eq 0 ]]; then
    add_issue "info" "Dev-flow family has no entries in ${WINDOW} — insufficient data, family checks skipped"
    CHECKS=$(echo "$CHECKS" | jq --argjson f "$family_data" '.dev_flow_family = ($f + {status: "insufficient_data"})')
    return
  fi

  local dead_count stuck_count disc_count bn_count
  dead_count=$(echo "$family_data" | jq '.findings.dead_phases | length')
  stuck_count=$(echo "$family_data" | jq '.findings.stuck_skills | length')
  disc_count=$(echo "$family_data" | jq '.findings.disconnected_skills | length')
  bn_count=$(echo "$family_data" | jq '.findings.bottlenecks | length')

  # Issues
  if [[ "$dead_count" -gt 0 ]]; then
    local dead_list
    dead_list=$(echo "$family_data" | jq -r '[.findings.dead_phases[].skill] | join(", ")')
    add_issue "warn" "Dead phase(s) detected (${WINDOW}): ${dead_list}"
  fi
  if [[ "$stuck_count" -gt 0 ]]; then
    local stuck_list
    stuck_list=$(echo "$family_data" | jq -r '[.findings.stuck_skills[] | "\(.skill)(\(.failure_rate | . * 100 | round)%)"] | join(", ")')
    add_issue "warn" "Stuck skill(s) detected (${WINDOW}): ${stuck_list}"
  fi
  if [[ "$disc_count" -gt 0 ]]; then
    local disc_list
    disc_list=$(echo "$family_data" | jq -r '[.findings.disconnected_skills[].skill] | join(", ")')
    add_issue "warn" "Disconnected skill(s) detected (${WINDOW}): ${disc_list}"
  fi
  if [[ "$bn_count" -gt 0 ]]; then
    local bn_top
    bn_top=$(echo "$family_data" | jq -r '.findings.bottlenecks[0] | "\(.skill) (avg \(.avg_duration_turns | . * 10 | round / 10) turns)"')
    add_issue "info" "Top bottleneck (${WINDOW}): ${bn_top}"
  fi

  # Scoring: family health penalties (each capped at -5, total capped at -20)
  local family_penalty=0
  if [[ "$dead_count" -gt 0 ]]; then family_penalty=$((family_penalty + 5)); fi
  if [[ "$stuck_count" -gt 0 ]]; then family_penalty=$((family_penalty + 5)); fi
  if [[ "$disc_count" -gt 0 ]]; then family_penalty=$((family_penalty + 5)); fi
  # bottleneck alone is informational — only penalize if avg top > 3x overall avg (best-effort, skip here)
  if [[ $family_penalty -gt 20 ]]; then family_penalty=20; fi
  if [[ $family_penalty -gt 0 ]]; then
    subtract_score "$family_penalty" 20
  fi

  CHECKS=$(echo "$CHECKS" | jq --argjson family "$family_data" '.dev_flow_family = $family')
}

# ============================================================================
# Check 9: Termination Loop Health (kickoff.json driven) — issue #53
# ============================================================================

run_termination_loops_check() {
  local analyze_sh="$SCRIPT_DIR_RD/analyze-termination-loops.sh"
  if [[ ! -x "$analyze_sh" ]]; then
    CHECKS=$(echo "$CHECKS" | jq '.termination_loops = {"status": "skipped", "reason": "analyze-termination-loops.sh not found"}')
    return
  fi

  local term_data
  if ! term_data=$("$analyze_sh" 2>/dev/null); then
    CHECKS=$(echo "$CHECKS" | jq '.termination_loops = {"status": "error", "reason": "analyze-termination-loops.sh failed"}')
    return
  fi

  if ! echo "$term_data" | jq 'type == "object"' 2>/dev/null | grep -q true; then
    CHECKS=$(echo "$CHECKS" | jq '.termination_loops = {"status": "error", "reason": "invalid JSON from analyze-termination-loops.sh"}')
    return
  fi

  local findings_count
  findings_count=$(echo "$term_data" | jq '.findings | length')

  if [[ "$findings_count" -gt 0 ]]; then
    # Emit a single summary warn; detailed findings remain inside CHECKS.termination_loops
    local repeated max_iter stuck_cnt fork_cnt
    repeated=$(echo "$term_data" | jq '[.findings[] | select(.pattern == "repeated_feedback_target")] | length')
    max_iter=$(echo "$term_data" | jq '[.findings[] | select(.pattern == "max_iterations")] | length')
    stuck_cnt=$(echo "$term_data" | jq '[.findings[] | select(.pattern == "stuck")] | length')
    fork_cnt=$(echo "$term_data" | jq '[.findings[] | select(.pattern == "fork_failure")] | length')
    add_issue "warn" "Termination loop findings: repeated_feedback_target=${repeated}, max_iterations=${max_iter}, stuck=${stuck_cnt}, fork_failure=${fork_cnt}"
  fi

  CHECKS=$(echo "$CHECKS" | jq --argjson t "$term_data" '.termination_loops = $t')
}

# ============================================================================
# Run checks based on scope
# ============================================================================

case "$SCOPE" in
  full)
    run_journal_checks
    run_worktree_checks
    run_config_checks
    run_family_checks
    run_termination_loops_check
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
  family)
    run_family_checks
    run_termination_loops_check
    ;;
esac

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
