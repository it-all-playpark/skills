#!/usr/bin/env bash
# zombie-kill.sh - Detect and kill zombie Claude Code sessions
# Usage: zombie-kill.sh [--force] [--min-hours N]
#   --force:      Skip confirmation and kill immediately
#   --min-hours N: Only target processes older than N hours (implies --force)

set -euo pipefail

FORCE=false
MIN_HOURS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=true; shift ;;
    --min-hours) MIN_HOURS="$2"; FORCE=true; shift 2 ;;
    *) shift ;;
  esac
done

# Parse etime string (mm:ss, hh:mm:ss, dd-hh:mm:ss) to total hours
etime_to_hours() {
  local etime="$1"
  local days=0 hours=0 mins=0

  if [[ "$etime" == *-* ]]; then
    # dd-hh:mm:ss
    days="${etime%%-*}"
    local rest="${etime#*-}"
    hours="${rest%%:*}"
    rest="${rest#*:}"
    mins="${rest%%:*}"
  elif [[ "$etime" =~ ^[0-9]+:[0-9]+:[0-9]+$ ]]; then
    # hh:mm:ss
    hours="${etime%%:*}"
    local rest="${etime#*:}"
    mins="${rest%%:*}"
  else
    # mm:ss
    mins="${etime%%:*}"
  fi

  # Remove leading zeros for arithmetic
  days=$((10#$days))
  hours=$((10#$hours))
  mins=$((10#$mins))

  echo $(( days * 24 + hours + (mins > 0 ? 1 : 0) ))
}

# Get today's date markers for comparison (macOS ps shows "HH:MMAM/PM" for today, "DayHH" for older)
# On macOS, processes started today show time like "10:15AM", older ones show "MonHHAM" or "Thu06AM"
TODAY_WEEKDAY=$(date +%a)

# Find claude and related child processes, excluding grep itself and Chrome native host
ZOMBIES=()
ZOMBIE_DETAILS=()

while IFS= read -r line; do
  pid=$(echo "$line" | awk '{print $2}')
  tty=$(echo "$line" | awk '{print $7}')
  started=$(echo "$line" | awk '{print $9}')
  cpu_time=$(echo "$line" | awk '{print $10}')
  cmd=$(echo "$line" | awk '{for(i=11;i<=NF;i++) printf "%s ", $i; print ""}')

  # Skip Chrome native host (Claude Desktop extension, not CLI)
  [[ "$cmd" == *"chrome-native-host"* ]] && continue

  # Skip own process tree
  [[ "$pid" == "$$" ]] && continue

  is_zombie=false

  if [[ "$MIN_HOURS" -gt 0 ]]; then
    # --min-hours mode: use etime for precise age detection
    local_etime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ') || continue
    proc_hours=$(etime_to_hours "$local_etime")
    if [[ "$proc_hours" -ge "$MIN_HOURS" ]]; then
      is_zombie=true
    fi
  else
    # Default mode: detect non-today processes by STARTED column format
    # Today's processes show time format like "10:15AM" (contains ":" and AM/PM)
    # Older processes show format like "Thu06AM" or "Wed04PM" (weekday prefix)
    if [[ ! "$started" =~ ^[0-9]+:[0-9]+(AM|PM)$ ]]; then
      is_zombie=true
    fi
  fi

  if [[ "$is_zombie" == true ]]; then
    ZOMBIES+=("$pid")
    # Truncate command for display
    short_cmd="${cmd:0:80}"
    ZOMBIE_DETAILS+=("$(printf "  PID %-7s | Started: %-10s | CPU: %-10s | %s" "$pid" "$started" "$cpu_time" "$short_cmd")")
  fi
done < <(ps aux | grep -E "(claude|claude-code)" | grep -v grep)

if [[ ${#ZOMBIES[@]} -eq 0 ]]; then
  # Silent exit for automated mode, friendly message for interactive
  [[ "$MIN_HOURS" -gt 0 ]] && exit 0
  echo "No zombie Claude sessions found. All clean!"
  exit 0
fi

echo "Found ${#ZOMBIES[@]} zombie Claude session(s):"
echo ""
for detail in "${ZOMBIE_DETAILS[@]}"; do
  echo "$detail"
done
echo ""

if [[ "$FORCE" == true ]]; then
  echo "Force mode: killing all zombies..."
else
  read -p "Kill these processes? [y/N] " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

KILLED=0
FORCE_KILLED=0

for pid in "${ZOMBIES[@]}"; do
  if kill "$pid" 2>/dev/null; then
    ((KILLED++))
  fi
done

# Wait briefly and check for stubborn processes
sleep 1

for pid in "${ZOMBIES[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "PID $pid didn't respond to SIGTERM, sending SIGKILL..."
    kill -9 "$pid" 2>/dev/null && ((FORCE_KILLED++))
  fi
done

echo ""
echo "Done: ${KILLED} killed, ${FORCE_KILLED} force-killed."
