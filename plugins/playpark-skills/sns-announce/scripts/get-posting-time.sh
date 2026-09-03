#!/bin/bash
# Get optimal posting time for a platform
# Usage: get-posting-time.sh <platform> [--date YYYY-MM-DD]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TIMES_FILE="$SCRIPT_DIR/../references/posting-times.json"

platform=""
target_date=$(date +%Y-%m-%d)

while [[ $# -gt 0 ]]; do
  case $1 in
    --date) target_date="$2"; shift 2 ;;
    *) platform="$1"; shift ;;
  esac
done

if [[ -z "$platform" ]]; then
  echo "Usage: get-posting-time.sh <platform> [--date YYYY-MM-DD]" >&2
  exit 1
fi

if [[ ! -f "$TIMES_FILE" ]]; then
  echo "Error: posting-times.json not found" >&2
  exit 1
fi

# Get day of week (0=Sun, 1=Mon, ..., 6=Sat)
day_of_week=$(date -j -f "%Y-%m-%d" "$target_date" +%u 2>/dev/null || date -d "$target_date" +%u)
is_weekend=$([[ $day_of_week -ge 6 ]] && echo "true" || echo "false")

# Get times for platform
if command -v jq &>/dev/null; then
  platform_data=$(jq -r ".platforms.${platform}" "$TIMES_FILE")

  if [[ "$platform_data" == "null" ]]; then
    echo "Error: Unknown platform: $platform" >&2
    exit 1
  fi

  if [[ "$is_weekend" == "true" ]]; then
    time=$(jq -r ".platforms.${platform}.weekend[0] // .platforms.${platform}.weekday[0]" "$TIMES_FILE")
  else
    # Check best_days if exists
    best_days=$(jq -r ".platforms.${platform}.best_days // empty" "$TIMES_FILE")
    if [[ -n "$best_days" && "$best_days" != "null" ]]; then
      day_name=$(date -j -f "%Y-%m-%d" "$target_date" +%a 2>/dev/null | tr '[:upper:]' '[:lower:]' || date -d "$target_date" +%a | tr '[:upper:]' '[:lower:]')
      is_best_day=$(echo "$best_days" | jq -r "index(\"$day_name\") != null")
      if [[ "$is_best_day" != "true" ]]; then
        # Find next best day
        echo "Note: $platform best on $(echo $best_days | jq -r 'join(", ")')" >&2
      fi
    fi
    time=$(jq -r ".platforms.${platform}.weekday[0]" "$TIMES_FILE")
  fi

  echo "${target_date} ${time}"
else
  echo "Error: jq required" >&2
  exit 1
fi
