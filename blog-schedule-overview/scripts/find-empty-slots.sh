#!/usr/bin/env bash
#
# find-empty-slots.sh - Find empty publish slots in the schedule
# Usage: find-empty-slots.sh --schedule-json <path> --days N --publish-days "monday,thursday"
# Output: JSON array of empty date slots
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$SKILLS_DIR/_lib/common.sh"

require_cmd "jq"

# ============================================================================
# Defaults
# ============================================================================

SCHEDULE_JSON=""
DAYS=30
PUBLISH_DAYS="monday,thursday"

# ============================================================================
# Argument Parsing
# ============================================================================

usage() {
    cat << 'EOF'
Usage: find-empty-slots.sh --schedule-json <path> [--days N] [--publish-days "monday,thursday"]

Options:
  --schedule-json  Path to schedule JSON (output of collect-schedule.sh)
  --days           Number of days to look ahead (default: 30)
  --publish-days   Comma-separated publish day names (default: monday,thursday)
  -h, --help       Show this help

Output:
  JSON array of empty date slots:
  [{"date": "YYYY-MM-DD", "day": "monday"}]
EOF
    exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --schedule-json) SCHEDULE_JSON="$2"; shift 2 ;;
        --days)          DAYS="$2";          shift 2 ;;
        --publish-days)  PUBLISH_DAYS="$2";  shift 2 ;;
        -h|--help)       usage 0 ;;
        *)               warn "Unknown option: $1"; shift ;;
    esac
done

[[ -z "$SCHEDULE_JSON" ]] && die_json "Missing required --schedule-json argument"
[[ ! -f "$SCHEDULE_JSON" ]] && die_json "Schedule JSON not found: $SCHEDULE_JSON"

# ============================================================================
# Day Name to Number Mapping (macOS date uses %u: 1=Monday .. 7=Sunday)
# ============================================================================

day_name_to_number() {
    case "$(echo "$1" | tr '[:upper:]' '[:lower:]')" in
        monday)    echo 1 ;;
        tuesday)   echo 2 ;;
        wednesday) echo 3 ;;
        thursday)  echo 4 ;;
        friday)    echo 5 ;;
        saturday)  echo 6 ;;
        sunday)    echo 7 ;;
        *)         warn "Unknown day: $1"; echo "" ;;
    esac
}

number_to_day_name() {
    case "$1" in
        1) echo "monday" ;;
        2) echo "tuesday" ;;
        3) echo "wednesday" ;;
        4) echo "thursday" ;;
        5) echo "friday" ;;
        6) echo "saturday" ;;
        7) echo "sunday" ;;
        *) echo "unknown" ;;
    esac
}

# ============================================================================
# Parse Publish Days
# ============================================================================

IFS=',' read -ra DAY_NAMES <<< "$PUBLISH_DAYS"
PUBLISH_DAY_NUMBERS=()
for day_name in "${DAY_NAMES[@]}"; do
    num="$(day_name_to_number "$(echo "$day_name" | tr -d ' ')")"
    [[ -n "$num" ]] && PUBLISH_DAY_NUMBERS+=("$num")
done

if [[ ${#PUBLISH_DAY_NUMBERS[@]} -eq 0 ]]; then
    die_json "No valid publish days specified"
fi

# ============================================================================
# Collect Scheduled Dates from JSON
# ============================================================================

SCHEDULED_DATES="$(jq -r '.[].date' "$SCHEDULE_JSON" | sort -u)"

# ============================================================================
# Generate All Publish Dates and Find Empty Slots
# ============================================================================

TODAY="$(date +%Y-%m-%d)"
EMPTY_SLOTS="[]"

for (( i = 0; i <= DAYS; i++ )); do
    # macOS-compatible date arithmetic
    if date --version &>/dev/null 2>&1; then
        # GNU date
        check_date="$(date -d "$TODAY + $i days" +%Y-%m-%d)"
        day_num="$(date -d "$TODAY + $i days" +%u)"
    else
        # BSD/macOS date
        check_date="$(date -j -v+"${i}d" -f "%Y-%m-%d" "$TODAY" +%Y-%m-%d)"
        day_num="$(date -j -v+"${i}d" -f "%Y-%m-%d" "$TODAY" +%u)"
    fi

    # Check if this day is a publish day
    is_publish_day=false
    for pub_num in "${PUBLISH_DAY_NUMBERS[@]}"; do
        if [[ "$day_num" == "$pub_num" ]]; then
            is_publish_day=true
            break
        fi
    done

    [[ "$is_publish_day" == "false" ]] && continue

    # Check if date already has an article
    if echo "$SCHEDULED_DATES" | grep -qx "$check_date"; then
        continue
    fi

    day_name="$(number_to_day_name "$day_num")"

    EMPTY_SLOTS="$(echo "$EMPTY_SLOTS" | jq \
        --arg date "$check_date" \
        --arg day "$day_name" \
        '. + [{"date": $date, "day": $day}]')"
done

echo "$EMPTY_SLOTS" | jq '.'
