#!/usr/bin/env bash
# guard-check.sh - Safety guard checks for night patrol
# Usage: guard-check.sh --mode pre-triage|pre-execute [--files LIST] [--labels LIST]
#                       [--issue NUMBER] [--cumulative-lines N] [--estimated-lines N]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Argument Parsing
# ============================================================================

MODE=""
FILES=""
LABELS=""
ISSUE=""
CUMULATIVE_LINES=""
ESTIMATED_LINES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --files)
      FILES="${2:-}"
      shift 2
      ;;
    --labels)
      LABELS="${2:-}"
      shift 2
      ;;
    --issue)
      ISSUE="${2:-}"
      shift 2
      ;;
    --cumulative-lines)
      CUMULATIVE_LINES="${2:-}"
      shift 2
      ;;
    --estimated-lines)
      ESTIMATED_LINES="${2:-}"
      shift 2
      ;;
    *)
      die_json "Unknown argument: $1" 1
      ;;
  esac
done

# ============================================================================
# Validation
# ============================================================================

if [[ -z "$MODE" ]]; then
  die_json "--mode is required (pre-triage|pre-execute)" 1
fi

if [[ "$MODE" != "pre-triage" && "$MODE" != "pre-execute" ]]; then
  die_json "--mode must be pre-triage or pre-execute, got: $MODE" 1
fi

require_cmd "jq" "jq is required for JSON processing. Install: brew install jq"

# ============================================================================
# Load Config
# ============================================================================

CFG="$(load_skill_config "night-patrol")"

MAX_LINES_PER_ISSUE="$(echo "$CFG" | jq -r '.max_lines_per_issue // 500')"
MAX_CUMULATIVE_LINES="$(echo "$CFG" | jq -r '.max_cumulative_lines // 2000')"
DENYLIST_PATHS="$(echo "$CFG" | jq -r '.denylist_paths // [] | .[]' 2>/dev/null || true)"
DENYLIST_LABELS="$(echo "$CFG" | jq -r '.denylist_labels // [] | .[]' 2>/dev/null || true)"

# ============================================================================
# Helper: glob match
# ============================================================================

# Returns 0 if path matches the glob pattern
glob_match() {
  local path="$1"
  local pattern="$2"
  # Use bash pattern matching
  [[ "$path" == $pattern ]]
}

# ============================================================================
# Guard Checks
# ============================================================================

PASS=true
REASONS=()

if [[ "$MODE" == "pre-triage" ]]; then
  # Check 1: Denylist paths
  if [[ -n "$FILES" && -n "$DENYLIST_PATHS" ]]; then
    IFS=',' read -ra FILE_ARRAY <<< "$FILES"
    while IFS= read -r pattern; do
      [[ -z "$pattern" ]] && continue
      for file in "${FILE_ARRAY[@]}"; do
        file="${file// /}"  # trim spaces
        [[ -z "$file" ]] && continue
        if glob_match "$file" "$pattern"; then
          PASS=false
          REASONS+=("denylist_path: $file matches $pattern")
        fi
      done
    done <<< "$DENYLIST_PATHS"
  fi

  # Check 2: Denylist labels
  if [[ -n "$LABELS" && -n "$DENYLIST_LABELS" ]]; then
    IFS=',' read -ra LABEL_ARRAY <<< "$LABELS"
    while IFS= read -r deny_label; do
      [[ -z "$deny_label" ]] && continue
      for label in "${LABEL_ARRAY[@]}"; do
        label="${label## }"  # trim leading space
        label="${label%% }"  # trim trailing space
        [[ -z "$label" ]] && continue
        if [[ "$label" == "$deny_label" ]]; then
          PASS=false
          REASONS+=("denylist_label: $label")
        fi
      done
    done <<< "$DENYLIST_LABELS"
  fi

  # Check 3: Estimated lines limit
  if [[ -n "$ESTIMATED_LINES" ]]; then
    if (( ESTIMATED_LINES > MAX_LINES_PER_ISSUE )); then
      PASS=false
      REASONS+=("exceeded_line_limit: $ESTIMATED_LINES > $MAX_LINES_PER_ISSUE")
    fi
  fi

elif [[ "$MODE" == "pre-execute" ]]; then
  # Check 1: Cumulative lines limit
  if [[ -n "$CUMULATIVE_LINES" ]]; then
    if (( CUMULATIVE_LINES > MAX_CUMULATIVE_LINES )); then
      PASS=false
      REASONS+=("exceeded_cumulative_limit: $CUMULATIVE_LINES > $MAX_CUMULATIVE_LINES")
    fi
  fi
fi

# ============================================================================
# Output JSON
# ============================================================================

# Build reasons JSON array
REASONS_JSON="["
first=true
for reason in "${REASONS[@]}"; do
  [[ "$first" == true ]] || REASONS_JSON+=","
  first=false
  REASONS_JSON+="$(json_str "$reason")"
done
REASONS_JSON+="]"

if [[ "$PASS" == true ]]; then
  PASS_VAL="true"
else
  PASS_VAL="false"
fi

echo "{\"pass\":$PASS_VAL,\"mode\":$(json_str "$MODE"),\"reasons\":$REASONS_JSON}"
