#!/usr/bin/env bash
# pipeline-health.sh - Scan pipeline.yml files and detect stagnation
# Usage: bash scripts/pipeline-health.sh [--repo-path PATH] [--stale-contact-days N] [--stale-status-days N]
#
# Output: JSON with overdue, stale_contact, stale_status arrays
#
# Dependencies: bash, date (GNU or BSD), jq (optional but recommended)

set -euo pipefail

# ============================================================================
# Defaults
# ============================================================================

REPO_PATH=""
STALE_CONTACT_DAYS=14
STALE_STATUS_DAYS=30
TODAY=$(date +%Y-%m-%d)

# Statuses excluded from stale_contact detection
EXCLUDED_CONTACT_STATUSES="失注|受注|保留|アポお断り"

# Statuses that trigger stale_status detection
STALE_STATUS_TARGETS="提案中|見積送付済"

# ============================================================================
# Argument Parsing
# ============================================================================

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-path)
      REPO_PATH="$2"
      shift 2
      ;;
    --stale-contact-days)
      STALE_CONTACT_DAYS="$2"
      shift 2
      ;;
    --stale-status-days)
      STALE_STATUS_DAYS="$2"
      shift 2
      ;;
    --today)
      TODAY="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# ============================================================================
# Resolve repo path from skill-config.json if not provided
# ============================================================================

if [[ -z "$REPO_PATH" ]]; then
  # Try global config
  GLOBAL_CONFIG="${HOME}/.claude/skill-config.json"
  if [[ -f "$GLOBAL_CONFIG" ]] && command -v jq &>/dev/null; then
    REPO_PATH=$(jq -r '.sales.repo_path // empty' "$GLOBAL_CONFIG" 2>/dev/null || true)
  fi
  # Expand ~
  REPO_PATH="${REPO_PATH/#\~/$HOME}"
fi

if [[ -z "$REPO_PATH" || ! -d "$REPO_PATH/companies" ]]; then
  echo '{"status":"error","error":"Sales repo not found. Use --repo-path or set sales.repo_path in skill-config.json"}' >&2
  exit 1
fi

COMPANIES_DIR="$REPO_PATH/companies"

# ============================================================================
# Date calculation helper
# ============================================================================

days_between() {
  # Usage: days_between "YYYY-MM-DD" "YYYY-MM-DD"
  # Returns: number of days (date1 - date2), positive if date1 > date2
  local date1="$1"
  local date2="$2"

  # Use python3 for portable date arithmetic (avoids GNU/BSD date differences)
  python3 -c "
from datetime import date
d1 = date.fromisoformat('$date1')
d2 = date.fromisoformat('$date2')
print((d1 - d2).days)
"
}

# ============================================================================
# YAML field extraction (simple key: value format)
# ============================================================================

yaml_get() {
  # Usage: yaml_get "key" "file"
  local key="$1"
  local file="$2"
  local val
  val=$(grep "^${key}:" "$file" 2>/dev/null | head -1 | sed "s/^${key}:[[:space:]]*//" | sed 's/^["'"'"']//;s/["'"'"']$//' | sed 's/[[:space:]]*$//')
  echo "$val"
}

# ============================================================================
# Get latest activity date for a company
# ============================================================================

latest_activity_date() {
  local company_dir="$1"
  local activities_dir="$company_dir/activities"

  if [[ ! -d "$activities_dir" ]]; then
    echo ""
    return
  fi

  # Extract YYYY-MM-DD from filenames, sorted descending
  ls -1 "$activities_dir" 2>/dev/null \
    | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' \
    | sort -r \
    | head -1
}

# ============================================================================
# JSON escape helper (no jq dependency)
# ============================================================================

json_esc() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  echo "$s"
}

# ============================================================================
# Main scan
# ============================================================================

overdue_items=()
stale_contact_items=()
stale_status_items=()
total=0
healthy=0

for company_dir in "$COMPANIES_DIR"/*/; do
  [[ -d "$company_dir" ]] || continue

  slug=$(basename "$company_dir")
  pipeline_file="$company_dir/pipeline.yml"
  profile_file="$company_dir/profile.yml"

  [[ -f "$pipeline_file" ]] || continue

  total=$((total + 1))

  # Read fields
  status=$(yaml_get "status" "$pipeline_file")
  next_action=$(yaml_get "next_action" "$pipeline_file")
  deadline=$(yaml_get "next_action_deadline" "$pipeline_file")
  last_contact=$(yaml_get "last_contact" "$pipeline_file")
  company_name=$(yaml_get "name" "$profile_file" 2>/dev/null || echo "$slug")
  [[ -z "$company_name" ]] && company_name="$slug"

  flagged=false

  # ---- Check 1: Overdue (deadline < today) ----
  if [[ -n "$deadline" && "$deadline" != "null" ]]; then
    days_over=$(days_between "$TODAY" "$deadline")
    if [[ "$days_over" -gt 0 ]]; then
      flagged=true
      overdue_items+=("{\"slug\":\"$(json_esc "$slug")\",\"company\":\"$(json_esc "$company_name")\",\"next_action\":\"$(json_esc "$next_action")\",\"deadline\":\"$deadline\",\"days_overdue\":$days_over}")
    fi
  fi

  # ---- Check 2: Stale contact (14+ days, active statuses only, no deadline set) ----
  if [[ -n "$last_contact" && "$last_contact" != "null" ]]; then
    # Check if status is excluded
    if ! echo "$status" | grep -qE "^($EXCLUDED_CONTACT_STATUSES)$"; then
      # Skip if next_action_deadline is set (covered by overdue/upcoming)
      if [[ -z "$deadline" || "$deadline" == "null" ]]; then
        days_since=$(days_between "$TODAY" "$last_contact")
        if [[ "$days_since" -ge "$STALE_CONTACT_DAYS" ]]; then
          flagged=true
          stale_contact_items+=("{\"slug\":\"$(json_esc "$slug")\",\"company\":\"$(json_esc "$company_name")\",\"last_contact\":\"$last_contact\",\"days_since\":$days_since,\"status\":\"$(json_esc "$status")\"}")
        fi
      fi
    fi
  fi

  # ---- Check 3: Stale status (提案中/見積送付済 for 30+ days) ----
  if echo "$status" | grep -qE "^($STALE_STATUS_TARGETS)$"; then
    last_activity=$(latest_activity_date "$company_dir")
    # Fallback to last_contact if no activities
    ref_date="${last_activity:-$last_contact}"
    if [[ -n "$ref_date" && "$ref_date" != "null" ]]; then
      days_stale=$(days_between "$TODAY" "$ref_date")
      if [[ "$days_stale" -ge "$STALE_STATUS_DAYS" ]]; then
        flagged=true
        stale_status_items+=("{\"slug\":\"$(json_esc "$slug")\",\"company\":\"$(json_esc "$company_name")\",\"status\":\"$(json_esc "$status")\",\"last_activity\":\"$ref_date\",\"days_stale\":$days_stale}")
      fi
    fi
  fi

  if [[ "$flagged" == false ]]; then
    healthy=$((healthy + 1))
  fi
done

needs_attention=$(( ${#overdue_items[@]} + ${#stale_contact_items[@]} + ${#stale_status_items[@]} ))

# ============================================================================
# Build JSON output
# ============================================================================

join_json_array() {
  local arr=("$@")
  if [[ ${#arr[@]} -eq 0 ]]; then
    echo "[]"
    return
  fi
  local result="["
  local first=true
  for item in "${arr[@]}"; do
    if [[ "$first" == true ]]; then
      first=false
    else
      result+=","
    fi
    result+="$item"
  done
  result+="]"
  echo "$result"
}

overdue_json=$(join_json_array "${overdue_items[@]+"${overdue_items[@]}"}")
stale_contact_json=$(join_json_array "${stale_contact_items[@]+"${stale_contact_items[@]}"}")
stale_status_json=$(join_json_array "${stale_status_items[@]+"${stale_status_items[@]}"}")

cat <<EOF
{
  "overdue": $overdue_json,
  "stale_contact": $stale_contact_json,
  "stale_status": $stale_status_json,
  "scan_date": "$TODAY",
  "total_companies": $total,
  "healthy": $healthy,
  "needs_attention": $needs_attention
}
EOF
