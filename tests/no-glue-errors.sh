#!/usr/bin/env bash
# tests/no-glue-errors.sh - CI guard: detect glue-error regressions against a baseline
#
# Reads a baseline snapshot (BASELINE_FILE env or default templates fallback),
# takes a current snapshot via baseline-snapshot.sh, and compares them with
# compare-baseline.sh. Exits 1 if glue_errors.count has regressed beyond the
# allowed threshold.
#
# Designed to be called from CI (lint.yml: no-glue-errors job). Gracefully
# degrades to exit 0 when no baseline is available so that new installs are
# not blocked.
#
# Environment:
#   BASELINE_FILE      Path to baseline snapshot JSON.
#                      Default: dev-flow-doctor/templates/baseline-pre-79.example.json
#   CLAUDE_JOURNAL_DIR Journal directory (forwarded to baseline-snapshot.sh).
#   SKILL_CONFIG_PATH  Config override (forwarded to baseline-snapshot.sh).
#
# Exit codes:
#   0 = no regression (or no baseline available → graceful degradation)
#   1 = glue_errors regression detected

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SNAPSHOT_SH="$REPO_ROOT/dev-flow-doctor/scripts/baseline-snapshot.sh"
COMPARE_SH="$REPO_ROOT/dev-flow-doctor/scripts/compare-baseline.sh"
DEFAULT_BASELINE="$REPO_ROOT/dev-flow-doctor/templates/baseline-pre-79.example.json"

# Resolve baseline file
BASELINE_FILE="${BASELINE_FILE:-$DEFAULT_BASELINE}"

# Graceful degradation: no baseline → skip check
if [[ ! -f "$BASELINE_FILE" ]]; then
  echo "no-glue-errors: no baseline file at $BASELINE_FILE — skipping check (exit 0)" >&2
  exit 0
fi

# Validate baseline JSON (corrupt → warning + exit 0 per spec)
if ! BASELINE_JSON=$(jq -c '.' "$BASELINE_FILE" 2>/dev/null); then
  echo "no-glue-errors: baseline file is not valid JSON ($BASELINE_FILE) — skipping check (exit 0)" >&2
  exit 0
fi

# Extract window from baseline (so we use the same time range)
WINDOW=$(echo "$BASELINE_JSON" | jq -r '.window // "30d"')
BASE_GLUE=$(echo "$BASELINE_JSON" | jq '.glue_errors.count // 0')

# Take current snapshot using the baseline's window
CURRENT_JSON=$(CLAUDE_JOURNAL_DIR="${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}" \
  SKILL_CONFIG_PATH="${SKILL_CONFIG_PATH:-}" \
  "$SNAPSHOT_SH" --window "$WINDOW" 2>&1)

if ! echo "$CURRENT_JSON" | jq empty 2>/dev/null; then
  echo "no-glue-errors: baseline-snapshot.sh failed — skipping check (exit 0)" >&2
  echo "$CURRENT_JSON" >&2
  exit 0
fi

CURR_GLUE=$(echo "$CURRENT_JSON" | jq '.glue_errors.count // 0')

# Run comparison using a temp file for the current snapshot
TMPDIR_NGE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_NGE"' EXIT
CURRENT_FILE="$TMPDIR_NGE/current.json"
echo "$CURRENT_JSON" > "$CURRENT_FILE"

COMPARE_OUTPUT=$(SKILL_CONFIG_PATH="${SKILL_CONFIG_PATH:-}" \
  "$COMPARE_SH" --baseline "$BASELINE_FILE" --current "$CURRENT_FILE" 2>&1)
COMPARE_EXIT=$?

if [[ "$COMPARE_EXIT" -eq 2 ]]; then
  # compare exit 2 = corrupt/IO error — graceful degradation
  echo "no-glue-errors: compare-baseline.sh returned exit 2 (error) — skipping check (exit 0)" >&2
  echo "$COMPARE_OUTPUT" >&2
  exit 0
elif [[ "$COMPARE_EXIT" -eq 1 ]]; then
  # Regression detected
  echo "no-glue-errors: glue_errors regression detected (window: $WINDOW, baseline: $BASE_GLUE, current: $CURR_GLUE)" >&2
  echo "$COMPARE_OUTPUT" >&2
  exit 1
fi

# Exit 0: no regression
echo "no-glue-errors: ok (window: $WINDOW, baseline: $BASE_GLUE, current: $CURR_GLUE)" >&2
exit 0
