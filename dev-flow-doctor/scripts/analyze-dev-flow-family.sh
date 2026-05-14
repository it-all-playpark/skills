#!/usr/bin/env bash
# analyze-dev-flow-family.sh - Analyze dev-flow family skills from skill-retrospective journal
#
# Reads ~/.claude/journal/*.json (or $CLAUDE_JOURNAL_DIR) via skill-retrospective's
# journal.sh, filters to the dev-flow family skills, and detects:
#   - dead phase       : zero success entries within the window
#   - stuck skill      : (failure + partial) / total > threshold  (min total required)
#   - bottleneck       : top-N skills by avg duration_turns
#   - disconnected skill: zero own entries AND never referenced by a parent Skill
#                         invocation within the window
#
# Usage:
#   analyze-dev-flow-family.sh [--window <dur>] [--config <path>]
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
      sed -n '2,22p' "$0"
      exit 0
      ;;
    *) die_json "Unknown argument: $1" 1 ;;
  esac
done

# ----------------------------------------------------------------------------
# Config resolution
# ----------------------------------------------------------------------------

DEFAULT_FAMILY_SKILLS='["dev-kickoff","dev-implement","dev-validate","dev-integrate","dev-evaluate","pr-iterate","pr-fix","night-patrol"]'
DEFAULT_WINDOW="30d"
DEFAULT_STUCK_RATE="0.30"
DEFAULT_STUCK_MIN_TOTAL="3"
DEFAULT_BOTTLENECK_TOP_N="3"

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

FAMILY_SKILLS_JSON=$(load_config_field ".family_skills" "$DEFAULT_FAMILY_SKILLS")
if [[ -z "$WINDOW" ]]; then
  WINDOW=$(load_config_field ".window_default" "\"$DEFAULT_WINDOW\"" | jq -r '.')
fi
STUCK_RATE=$(load_config_field ".thresholds.stuck_failure_rate" "$DEFAULT_STUCK_RATE" | jq -r '.')
STUCK_MIN_TOTAL=$(load_config_field ".thresholds.stuck_min_total" "$DEFAULT_STUCK_MIN_TOTAL" | jq -r '.')
BOTTLENECK_TOP_N=$(load_config_field ".thresholds.bottleneck_top_n" "$DEFAULT_BOTTLENECK_TOP_N" | jq -r '.')

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
  # Slurp all entries at once. If any single file is malformed, jq -s fails
  # for the whole batch, which previously produced an empty [] and caused a
  # false-positive "all family skills dead" result. Fall back to per-file
  # parsing so one bad file never blanks the whole journal.
  local slurped=""
  if slurped=$(jq -s '.' "${files[@]}" 2>/dev/null); then
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
WINDOW_ENTRIES=$(echo "$ALL_ENTRIES" | jq \
  --arg since "$SINCE_ISO" \
  '[.[] | select(.timestamp >= $since)]')

FAMILY_ENTRIES=$(echo "$WINDOW_ENTRIES" | jq \
  --argjson fam "$FAMILY_SKILLS_JSON" \
  '[.[] | select(.skill as $s | $fam | index($s))]')

# ----------------------------------------------------------------------------
# Per-skill aggregation
# ----------------------------------------------------------------------------

PER_SKILL=$(jq -n \
  --argjson entries "$FAMILY_ENTRIES" \
  --argjson fam "$FAMILY_SKILLS_JSON" \
  '
  [ $fam[] as $s |
    ($entries | map(select(.skill == $s))) as $es |
    ($es | length) as $total |
    ($es | map(select(.outcome == "success")) | length) as $succ |
    ($es | map(select(.outcome == "failure")) | length) as $fail |
    ($es | map(select(.outcome == "partial")) | length) as $part |
    # duration_turns は明示 log されたエントリ (主に成功時) にのみ存在する。
    # hook-capture failures には duration_turns が無いため、これを総数で割ると
    # bottleneck 判定が壊れる (実際 5 turns でも avg 1.28 と出る)。
    # サンプル数で割る方式に変更し、duration_samples を出力に追加する。
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
      duration_samples: $dur_count,
      last_success: ($es | map(select(.outcome == "success")) | sort_by(.timestamp) | last | .timestamp // null),
      last_failure: ($es | map(select(.outcome != "success")) | sort_by(.timestamp) | last | .timestamp // null)
    }
  ]
  ')

# ----------------------------------------------------------------------------
# Detections
# ----------------------------------------------------------------------------

# Dead phases: success == 0
DEAD_PHASES=$(echo "$PER_SKILL" | jq \
  --arg window "$WINDOW" \
  '[.[] | select(.success == 0) |
    {skill: .skill, total: .total, reason: ("0 success within " + $window)}]')

# Stuck skills: failure_rate > threshold AND total >= min_total
STUCK_SKILLS=$(echo "$PER_SKILL" | jq \
  --argjson rate "$STUCK_RATE" \
  --argjson min_total "$STUCK_MIN_TOTAL" \
  '[.[] | select(.total >= $min_total and .failure_rate > $rate) |
    {skill: .skill, total: .total, failure_rate: .failure_rate}]')

# Bottlenecks: top-N by avg_duration_turns (only skills with total > 0)
BOTTLENECKS=$(echo "$PER_SKILL" | jq \
  --argjson n "$BOTTLENECK_TOP_N" \
  '[.[] | select(.total > 0)] |
    sort_by(-.avg_duration_turns) |
    .[0:$n] |
    to_entries |
    map({skill: .value.skill, avg_duration_turns: .value.avg_duration_turns, rank: (.key + 1)})')

# Disconnected skills: skill has zero own entries AND name never appears as
# a word-bounded reference in any hook-capture entry's context.input_summary
# within the window. We match against "Skill: <name>" / "Task: <name>" and
# also allow a generic non-word-character boundary so that e.g. "dev-integrate"
# is not accidentally satisfied by "dev-integrate-extra".
DISCONNECTED=$(jq -n \
  --argjson per_skill "$PER_SKILL" \
  --argjson entries "$WINDOW_ENTRIES" \
  --arg window "$WINDOW" \
  '
  def escape_regex(s): s | gsub("([.+*?^$()\\[\\]{}|\\\\])"; "\\\\\(.)");
  [ $per_skill[] as $p |
    ($p.total == 0) as $no_own |
    (escape_regex($p.skill)) as $esc |
    ("(^|[^A-Za-z0-9_-])" + $esc + "([^A-Za-z0-9_-]|$)") as $re |
    ( $entries
      | map(select(.source == "hook-capture"))
      | map(.context.input_summary // "")
      | map(select(. != ""))
      | map(select(test($re)))
      | length
    ) as $parent_refs |
    if $no_own and ($parent_refs == 0) then
      {skill: $p.skill, reason: ("no own entries and no parent Skill-tool invocation within " + $window)}
    else empty end
  ]
  ')

# ----------------------------------------------------------------------------
# Output
# ----------------------------------------------------------------------------

jq -n \
  --arg window "$WINDOW" \
  --arg since "$SINCE_ISO" \
  --argjson fam "$FAMILY_SKILLS_JSON" \
  --argjson per "$PER_SKILL" \
  --argjson dead "$DEAD_PHASES" \
  --argjson stuck "$STUCK_SKILLS" \
  --argjson bn "$BOTTLENECKS" \
  --argjson disc "$DISCONNECTED" \
  '{
    window: $window,
    since: $since,
    family_skills: $fam,
    per_skill: $per,
    findings: {
      dead_phases: $dead,
      stuck_skills: $stuck,
      bottlenecks: $bn,
      disconnected_skills: $disc
    }
  }'
