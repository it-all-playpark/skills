#!/usr/bin/env bash
# baseline-snapshot.sh - Aggregate dev-flow family metrics into a snapshot JSON
#
# Reads ~/.claude/journal/*.json (or $CLAUDE_JOURNAL_DIR), filters by family
# skills (configurable via skill-config.json), aggregates per_skill / per_phase /
# error_categories / glue_errors metrics, and outputs a baseline snapshot.
#
# The output schema is consumed by compare-baseline.sh (issue #83 AC2-AC4) and
# can be persisted to .claude/dev-flow-doctor-baseline-pre-79.json (locally) or
# dev-flow-doctor/templates/baseline-pre-79.example.json (committable fallback).
#
# Usage:
#   baseline-snapshot.sh [--window <dur>] [--config <path>] [--include-non-family]
#                        [--out <path>]
#
# Options:
#   --window <dur>          Lookback window (e.g. 30d, 14d, 7d). Default 30d.
#   --config <path>         Override skill-config.json (auto-detected otherwise).
#   --include-non-family    Include skills outside the dev-flow family in per_skill.
#   --out <path>            Write to file instead of stdout (parent dir created if missing).
#
# Output: snapshot JSON (stdout if --out omitted). Schema:
#   {
#     "version": "1.0.0",
#     "schema": "dev-flow-doctor-baseline/v1",
#     "window": "30d",
#     "since": "ISO8601",
#     "taken_at": "ISO8601",
#     "total_entries": <int>,
#     "family_skills": [...],
#     "per_skill": [{skill, total, success, failure, partial, failure_rate, avg_duration_turns}],
#     "per_phase": {<phase>: {total, failure}},
#     "error_categories": {<cat>: <count>},
#     "glue_errors": {count, samples, patterns}
#   }
#
# Exit codes:
#   0 success / 1 invalid arg or unparseable window

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
INCLUDE_NON_FAMILY=false
OUT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --window) WINDOW="$2"; shift 2 ;;
    --config) CONFIG_OVERRIDE="$2"; shift 2 ;;
    --include-non-family) INCLUDE_NON_FAMILY=true; shift ;;
    --out) OUT_PATH="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0"; exit 0 ;;
    *) die_json "Unknown argument: $1" 1 ;;
  esac
done

# ----------------------------------------------------------------------------
# Config resolution (mirrors analyze-dev-flow-family.sh)
# ----------------------------------------------------------------------------

DEFAULT_FAMILY_SKILLS='["dev-kickoff","dev-implement","dev-validate","dev-integrate","dev-evaluate","pr-iterate","pr-fix","night-patrol"]'
DEFAULT_WINDOW="30d"
DEFAULT_GLUE_PATTERNS='["worktree.*not found","--worktree.*not","\\.env.*not.*copied","worktree-agent-[a-f0-9]+","phase_failed.*worktree"]'

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

FAMILY_SKILLS_JSON=$(load_config_field ".family_skills" "$DEFAULT_FAMILY_SKILLS")
if [[ -z "$WINDOW" ]]; then
  WINDOW=$(load_config_field ".window_default" "\"$DEFAULT_WINDOW\"" | jq -r '.')
fi
GLUE_PATTERNS_JSON=$(load_config_field ".baseline.glue_patterns" "$DEFAULT_GLUE_PATTERNS")

# ----------------------------------------------------------------------------
# Window → ISO since
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

TAKEN_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ----------------------------------------------------------------------------
# Journal load
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
  if slurped=$(jq -s '.' "${files[@]}" 2>/dev/null); then
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

WINDOW_ENTRIES=$(echo "$ALL_ENTRIES" | jq \
  --arg since "$SINCE_ISO" \
  '[.[] | select(.timestamp >= $since)]')

if [[ "$INCLUDE_NON_FAMILY" == "true" ]]; then
  TARGET_ENTRIES="$WINDOW_ENTRIES"
else
  TARGET_ENTRIES=$(echo "$WINDOW_ENTRIES" | jq \
    --argjson fam "$FAMILY_SKILLS_JSON" \
    '[.[] | select(.skill as $s | $fam | index($s))]')
fi

TOTAL_ENTRIES=$(echo "$TARGET_ENTRIES" | jq 'length')

# ----------------------------------------------------------------------------
# Per-skill aggregation
# ----------------------------------------------------------------------------

if [[ "$INCLUDE_NON_FAMILY" == "true" ]]; then
  SKILL_LIST=$(echo "$TARGET_ENTRIES" | jq '[.[].skill] | unique')
else
  SKILL_LIST="$FAMILY_SKILLS_JSON"
fi

PER_SKILL=$(jq -n \
  --argjson entries "$TARGET_ENTRIES" \
  --argjson skills "$SKILL_LIST" \
  '
  [ $skills[] as $s |
    ($entries | map(select(.skill == $s))) as $es |
    ($es | length) as $total |
    ($es | map(select(.outcome == "success")) | length) as $succ |
    ($es | map(select(.outcome == "failure")) | length) as $fail |
    ($es | map(select(.outcome == "partial")) | length) as $part |
    ($es | map(select(.duration_turns != null) | .duration_turns)) as $durations |
    ($durations | length) as $dur_count |
    ($durations | add // 0) as $sum_turns |
    {
      skill: $s,
      total: $total,
      success: $succ,
      failure: $fail,
      partial: $part,
      failure_rate: (if $total > 0 then (($fail + $part) / $total) else 0 end),
      avg_duration_turns: (if $dur_count > 0 then ($sum_turns / $dur_count) else 0 end),
      duration_samples: $dur_count
    }
  ]
  ')

# ----------------------------------------------------------------------------
# Per-phase aggregation (failures grouped by error.phase)
# ----------------------------------------------------------------------------

PER_PHASE=$(echo "$TARGET_ENTRIES" | jq '
  reduce .[] as $e ({};
    ($e.error.phase // null) as $ph |
    if $ph == null then .
    else
      .[$ph].total = ((.[$ph].total // 0) + 1)
      | .[$ph].failure = ((.[$ph].failure // 0) + (if $e.outcome == "failure" then 1 else 0 end))
    end
  )
  ')

# ----------------------------------------------------------------------------
# Error categories aggregation
# ----------------------------------------------------------------------------

ERROR_CATEGORIES=$(echo "$TARGET_ENTRIES" | jq '
  reduce .[] as $e ({};
    ($e.error.category // null) as $cat |
    if $cat == null then . else .[$cat] = ((.[$cat] // 0) + 1) end
  )
  ')

# ----------------------------------------------------------------------------
# Glue-error scan (jq + grep over journal files)
# ----------------------------------------------------------------------------

GLUE_COUNT=0
GLUE_SAMPLES_JSON='[]'

if [[ -d "$JOURNAL_DIR" ]]; then
  # Use the same patterns from skill-config (or defaults). Loop through files
  # within the time window. Each pattern match in a file contributes to count.
  #
  # Window filter strategy: prefer file timestamp embedded in journal JSON
  # (.timestamp field) over mtime, because (a) `find -newermt "<iso8601>Z"`
  # is not portable (BSD vs GNU find), and (b) journal entries are immutable
  # by design — the .timestamp field is authoritative.
  TMP_SAMPLES=()
  while IFS= read -r pat; do
    [[ -z "$pat" ]] && continue
    while IFS= read -r -d '' log; do
      # Filter by journal entry timestamp (if available)
      LOG_TS=$(jq -r '.timestamp // empty' "$log" 2>/dev/null || echo "")
      if [[ -n "$LOG_TS" ]] && [[ "$LOG_TS" < "$SINCE_ISO" ]]; then
        continue
      fi
      LOG_COUNT=$(grep -ciE "$pat" "$log" 2>/dev/null | head -n1 || echo 0)
      LOG_COUNT=${LOG_COUNT:-0}
      # Sanitize: grep may emit "0\n" when no matches
      LOG_COUNT=$(printf '%s' "$LOG_COUNT" | tr -d '[:space:]')
      [[ -z "$LOG_COUNT" ]] && LOG_COUNT=0
      if [[ "$LOG_COUNT" -gt 0 ]] 2>/dev/null; then
        GLUE_COUNT=$((GLUE_COUNT + LOG_COUNT))
        if [[ ${#TMP_SAMPLES[@]} -lt 5 ]]; then
          TMP_SAMPLES+=("$(basename "$log"): $pat × $LOG_COUNT")
        fi
      fi
    done < <(find "$JOURNAL_DIR" -maxdepth 1 -type f -name '*.json' -print0 2>/dev/null || true)
  done < <(echo "$GLUE_PATTERNS_JSON" | jq -r '.[]')

  if [[ ${#TMP_SAMPLES[@]} -gt 0 ]]; then
    GLUE_SAMPLES_JSON=$(printf '%s\n' "${TMP_SAMPLES[@]}" | jq -R . | jq -s '.')
  fi
fi

GLUE_ERRORS=$(jq -n \
  --argjson count "$GLUE_COUNT" \
  --argjson samples "$GLUE_SAMPLES_JSON" \
  --argjson patterns "$GLUE_PATTERNS_JSON" \
  '{count: $count, samples: $samples, patterns: $patterns}')

# ----------------------------------------------------------------------------
# Final assembly
# ----------------------------------------------------------------------------

SNAPSHOT=$(jq -n \
  --arg window "$WINDOW" \
  --arg since "$SINCE_ISO" \
  --arg taken_at "$TAKEN_AT" \
  --argjson total "$TOTAL_ENTRIES" \
  --argjson fam "$FAMILY_SKILLS_JSON" \
  --argjson per_skill "$PER_SKILL" \
  --argjson per_phase "$PER_PHASE" \
  --argjson error_cat "$ERROR_CATEGORIES" \
  --argjson glue "$GLUE_ERRORS" \
  '{
    version: "1.0.0",
    schema: "dev-flow-doctor-baseline/v1",
    window: $window,
    since: $since,
    taken_at: $taken_at,
    total_entries: $total,
    family_skills: $fam,
    per_skill: $per_skill,
    per_phase: $per_phase,
    error_categories: $error_cat,
    glue_errors: $glue
  }')

if [[ -n "$OUT_PATH" ]]; then
  mkdir -p "$(dirname "$OUT_PATH")"
  printf '%s\n' "$SNAPSHOT" > "$OUT_PATH"
else
  printf '%s\n' "$SNAPSHOT"
fi
