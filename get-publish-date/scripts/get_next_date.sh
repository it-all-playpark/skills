#!/bin/bash
# get_next_date.sh - Calculate next available publish date
# Output: YYYY-MM-DD (single line)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source common utilities
source "$SKILLS_DIR/_lib/common.sh"

# Load config
CONFIG=$(load_skill_config "get-publish-date")
PUBLISH_DAYS=$(echo "$CONFIG" | jq -r '.publish_days // empty' 2>/dev/null | jq -r '.[]' 2>/dev/null | tr '\n' ' ')
CONTENT_DIR=$(echo "$CONFIG" | jq -r '.content_dir // "content/blog"' 2>/dev/null)

# Default publish days if not configured
[[ -z "$PUBLISH_DAYS" ]] && PUBLISH_DAYS="monday thursday"

# Resolve content dir relative to git root
GIT_ROOT=$(git_root)
BLOG_DIR="$GIT_ROOT/$CONTENT_DIR"

# Map day names to numbers (0=Sun, 1=Mon, ..., 6=Sat)
day_to_num() {
  case "$1" in
    sunday)    echo 0 ;;
    monday)    echo 1 ;;
    tuesday)   echo 2 ;;
    wednesday) echo 3 ;;
    thursday)  echo 4 ;;
    friday)    echo 5 ;;
    saturday)  echo 6 ;;
    *) echo -1 ;;
  esac
}

# Build array of valid day numbers
VALID_DAYS=""
for day in $PUBLISH_DAYS; do
  num=$(day_to_num "$day")
  [[ $num -ge 0 ]] && VALID_DAYS="$VALID_DAYS $num"
done

# Get latest article date from content dir
LATEST=""
if [[ -d "$BLOG_DIR" ]]; then
  LATEST=$(ls "$BLOG_DIR"/*.mdx 2>/dev/null | \
    sed 's/.*\///' | \
    grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' | \
    sort -r | head -1)
fi

# Determine start date (day after latest, or tomorrow if no articles)
TODAY=$(date +%Y-%m-%d)
if [[ -n "$LATEST" ]] && [[ "$LATEST" > "$TODAY" || "$LATEST" == "$TODAY" ]]; then
  # Start from day after latest article
  START_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$LATEST" +%Y-%m-%d 2>/dev/null || \
               date -d "$LATEST + 1 day" +%Y-%m-%d)
else
  # Start from tomorrow
  START_DATE=$(date -j -v+1d +%Y-%m-%d 2>/dev/null || \
               date -d "tomorrow" +%Y-%m-%d)
fi

# Find next valid publish day (check up to 14 days)
CURRENT="$START_DATE"
i=0
while [ $i -lt 14 ]; do
  # Get day of week (0=Sun, 6=Sat)
  DOW=$(date -j -f "%Y-%m-%d" "$CURRENT" +%w 2>/dev/null || \
        date -d "$CURRENT" +%w)

  # Check if this day is a valid publish day
  for valid in $VALID_DAYS; do
    if [ "$DOW" = "$valid" ]; then
      echo "$CURRENT"
      exit 0
    fi
  done

  # Move to next day (macOS vs GNU date)
  CURRENT=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT" +%Y-%m-%d 2>/dev/null || \
            date -d "$CURRENT + 1 day" +%Y-%m-%d)
  i=$((i + 1))
done

# Fallback: return start date if no valid day found
echo "$START_DATE"
