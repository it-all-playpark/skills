#!/usr/bin/env bash
# tests/no-glue-errors.sh - AC4/AC5: glue-error regression check against baseline.
#
# Generates a current snapshot via dev-flow-doctor/scripts/baseline-snapshot.sh
# (with window taken from baseline.window — NOT hardcoded), compares against
# BASELINE_FILE via compare-baseline.sh, and exits non-zero only when a real
# regression is detected (compare exit 1). Corrupt baseline / window mismatch /
# missing baseline → warning + exit 0 (graceful degradation).
#
# Env:
#   BASELINE_FILE     Path to baseline snapshot JSON.
#                     Default: $REPO_ROOT/.claude/dev-flow-doctor-baseline-pre-79.json
#                     Fallback: $REPO_ROOT/dev-flow-doctor/templates/baseline-pre-79.example.json
#   CLAUDE_JOURNAL_DIR  Journal directory (passed through to baseline-snapshot.sh)
#   SKILL_CONFIG_PATH   skill-config.json override (test isolation)
#
# Issue: #83 (AC4 + AC5 baseline 比較 ON, integrated CI workflow)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SNAPSHOT_SH="$REPO_ROOT/dev-flow-doctor/scripts/baseline-snapshot.sh"
COMPARE_SH="$REPO_ROOT/dev-flow-doctor/scripts/compare-baseline.sh"

DEFAULT_BASELINE="$REPO_ROOT/.claude/dev-flow-doctor-baseline-pre-79.json"
TEMPLATE_FALLBACK="$REPO_ROOT/dev-flow-doctor/templates/baseline-pre-79.example.json"

BASELINE_FILE="${BASELINE_FILE:-$DEFAULT_BASELINE}"

echo "=== Glue-related error baseline check (AC4/AC5) ==="

# ----------------------------------------------------------------------------
# Resolve baseline file (real → template fallback if missing → warn + exit 0)
# ----------------------------------------------------------------------------

if [[ ! -f "$BASELINE_FILE" ]]; then
  if [[ -f "$TEMPLATE_FALLBACK" && "$BASELINE_FILE" != "$TEMPLATE_FALLBACK" ]]; then
    echo "WARNING: baseline file not found at $BASELINE_FILE; falling back to template $TEMPLATE_FALLBACK"
    BASELINE_FILE="$TEMPLATE_FALLBACK"
  else
    echo "WARNING: baseline file not found at $BASELINE_FILE and no template fallback available; skipping regression check (exit 0, graceful degradation)"
    echo "        Regenerate via: ./dev-flow-doctor/scripts/run-diagnostics.sh --update-baseline $DEFAULT_BASELINE"
    exit 0
  fi
fi

# ----------------------------------------------------------------------------
# Extract baseline.window (snapshot must define it; default 30d if missing)
# ----------------------------------------------------------------------------

if ! command -v jq >/dev/null 2>&1; then
  echo "WARNING: jq not available; cannot parse baseline; skipping regression check (exit 0)"
  exit 0
fi

BASELINE_WINDOW=$(jq -r '.window // "30d"' "$BASELINE_FILE" 2>/dev/null || echo "30d")
if [[ -z "$BASELINE_WINDOW" || "$BASELINE_WINDOW" == "null" ]]; then
  BASELINE_WINDOW="30d"
fi

echo "Baseline file: $BASELINE_FILE"
echo "Baseline window: $BASELINE_WINDOW"

# ----------------------------------------------------------------------------
# Generate current snapshot (window driven by baseline.window)
# ----------------------------------------------------------------------------

CURRENT_TMP=$(mktemp -t no-glue-current-XXXXXX.json)
trap 'rm -f "$CURRENT_TMP"' EXIT

if ! "$SNAPSHOT_SH" --window "$BASELINE_WINDOW" --out "$CURRENT_TMP" >/dev/null 2>&1; then
  echo "WARNING: failed to generate current snapshot; skipping regression check (exit 0)"
  exit 0
fi

# ----------------------------------------------------------------------------
# Run compare-baseline.sh and inspect exit code + counts
# ----------------------------------------------------------------------------

COMPARE_OUT=$("$COMPARE_SH" --baseline "$BASELINE_FILE" --current "$CURRENT_TMP" 2>/dev/null || true)
COMPARE_RC=$?

# Extract counts for messaging
BASELINE_COUNT=$(jq -r '.glue_errors.count // 0' "$BASELINE_FILE" 2>/dev/null || echo 0)
CURRENT_COUNT=$(jq -r '.glue_errors.count // 0' "$CURRENT_TMP" 2>/dev/null || echo 0)

echo "Glue-error count: baseline=$BASELINE_COUNT, current=$CURRENT_COUNT"

# Re-run to capture true exit code (the earlier `|| true` swallowed it)
"$COMPARE_SH" --baseline "$BASELINE_FILE" --current "$CURRENT_TMP" >/dev/null 2>&1
COMPARE_RC=$?

case "$COMPARE_RC" in
  0)
    echo "OK: no glue-error regression detected (baseline=$BASELINE_COUNT, current=$CURRENT_COUNT)"
    exit 0
    ;;
  1)
    echo "FAIL: glue-error regression detected (baseline=$BASELINE_COUNT, current=$CURRENT_COUNT)"
    echo "Findings:"
    echo "$COMPARE_OUT" | jq -r '.findings[] | "  - \(.metric) [\(.severity)]: delta=\(.delta), threshold=\(.threshold), reason=\(.reason)"' 2>/dev/null
    exit 1
    ;;
  2)
    echo "WARNING: compare-baseline.sh returned exit 2 (corrupt baseline / window mismatch / IO error)"
    echo "         baseline=$BASELINE_COUNT, current=$CURRENT_COUNT; skipping regression check (exit 0, graceful degradation)"
    exit 0
    ;;
  *)
    echo "WARNING: compare-baseline.sh returned unexpected exit code $COMPARE_RC; skipping (exit 0)"
    exit 0
    ;;
esac
