#!/usr/bin/env bash
# get-events.sh - Fetch calendar events for a given date
# Usage: get-events.sh <date> [--event-index N]
#   date: "today", "yesterday", "YYYY-MM-DD", "MM/DD", "M月D日"
# Output: JSON array of events, or single event if --event-index specified

set -euo pipefail

source "$(dirname "$0")/../../_lib/common.sh"

require_cmds gws python3 jq

# ============================================================================
# Parse arguments
# ============================================================================

DATE_INPUT=""
EVENT_INDEX=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --event-index)
      EVENT_INDEX="$2"
      shift 2
      ;;
    -*)
      die_json "Unknown option: $1"
      ;;
    *)
      if [[ -z "$DATE_INPUT" ]]; then
        DATE_INPUT="$1"
      else
        die_json "Unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

[[ -n "$DATE_INPUT" ]] || die_json "Usage: get-events.sh <date> [--event-index N]"

# ============================================================================
# Normalize date to YYYY-MM-DD
# ============================================================================

normalize_date() {
  local input="$1"
  local today
  today=$(date +%Y-%m-%d)
  local year
  year=$(date +%Y)

  case "$input" in
    today)
      echo "$today"
      ;;
    yesterday)
      if [[ "$(uname)" == "Darwin" ]]; then
        date -v-1d +%Y-%m-%d
      else
        date -d "yesterday" +%Y-%m-%d
      fi
      ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
      echo "$input"
      ;;
    [0-9][0-9]/[0-9][0-9])
      # MM/DD → YYYY-MM-DD
      echo "${year}-${input/\//-}"
      ;;
    [0-9]/[0-9][0-9])
      # M/DD → YYYY-0M-DD
      echo "${year}-0${input/\//-}"
      ;;
    [0-9][0-9]/[0-9])
      # MM/D → YYYY-MM-0D
      local mm="${input%%/*}"
      local dd="${input##*/}"
      printf '%s-%s-0%s\n' "$year" "$mm" "$dd"
      ;;
    [0-9]/[0-9])
      # M/D → YYYY-0M-0D
      local mm="${input%%/*}"
      local dd="${input##*/}"
      printf '%s-0%s-0%s\n' "$year" "$mm" "$dd"
      ;;
    *月*日)
      # M月D日 or MM月DD日
      local mm dd
      mm=$(echo "$input" | sed 's/月.*//')
      dd=$(echo "$input" | sed 's/.*月//; s/日//')
      printf '%s-%02d-%02d\n' "$year" "$mm" "$dd"
      ;;
    *)
      die_json "Unsupported date format: $input (use today, yesterday, YYYY-MM-DD, MM/DD, or M月D日)"
      ;;
  esac
}

DATE=$(normalize_date "$DATE_INPUT")

# ============================================================================
# Build gws calendar params and fetch events
# ============================================================================

PARAMS=$(python3 -c "
import json
print(json.dumps({
    'calendarId': 'primary',
    'timeMin': '${DATE}T00:00:00+09:00',
    'timeMax': '${DATE}T23:59:59+09:00',
    'timeZone': 'Asia/Tokyo',
    'singleEvents': True,
    'orderBy': 'startTime'
}))
")

RESPONSE=$(gws calendar events list --params "$PARAMS")

# Extract items array (default to empty array)
EVENTS=$(echo "$RESPONSE" | jq '.items // []')

# ============================================================================
# Output
# ============================================================================

if [[ -n "$EVENT_INDEX" ]]; then
  EVENT=$(echo "$EVENTS" | jq --argjson idx "$EVENT_INDEX" '.[$idx] // null')
  if [[ "$EVENT" == "null" ]]; then
    die_json "Event index $EVENT_INDEX out of range (total: $(echo "$EVENTS" | jq 'length'))"
  fi
  echo "$EVENT"
else
  echo "$EVENTS"
fi
