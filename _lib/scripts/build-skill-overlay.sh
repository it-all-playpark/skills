#!/usr/bin/env bash
# build-skill-overlay.sh — merge portable SKILL.md + adapter overlay into a
# Claude Code-ready SKILL.md.
#
# This is the reference implementation for issue #106 (Phase C of #103).
#
# Design decisions (Q1-Q4, issue #106):
#   Q1=A: adapter overlay lives at <skill>/adapters/<vendor>.yaml
#   Q2=1: build script writes merged artifact to --output path
#   Q3=Y: artifact is NOT committed to git (output path is outside the repo by default)
#   Q4=A: build artifact contains context: fork so Claude Code subagent behavior is preserved
#
# Usage:
#   build-skill-overlay.sh <skill-name> [--vendor <vendor>] [--skill-root <path>]
#                          [--output <path>]
#
# Arguments:
#   <skill-name>         name of the skill directory (e.g. dev-plan-review)
#
# Options:
#   --vendor <vendor>    adapter vendor to use (default: claude)
#   --skill-root <path>  root directory where skill subdirectories live
#                        (default: parent of this script, i.e. the repo root)
#   --output <path>      output path for merged SKILL.md
#                        (default: $HOME/.cache/claude-skill-build/<skill-name>/SKILL.md)
#   --help               print this help and exit 0
#
# Merge rules:
#   1. Body comes entirely from portable SKILL.md (overlay has no body section)
#   2. Frontmatter = union(portable_fm, overlay_fm)
#   3. Same-key conflict → overlay wins + warning to stderr
#   4. Missing overlay → portable passthrough (exit 0, log to stderr)
#   5. Malformed YAML in overlay → exit 2 + error to stderr
#   6. Malformed YAML in portable SKILL.md → exit 2 + error to stderr
#
# Exit codes:
#   0  success
#   1  usage / argument error
#   2  YAML parse error or other I/O error

set -euo pipefail

# ---------------------------------------------------------------------------
# Script location
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YAML_MERGE_PY="$SCRIPT_DIR/yaml-merge.py"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat >&2 << EOF
usage: $(basename "$0") <skill-name> [--vendor <vendor>] [--skill-root <path>] [--output <path>]

  <skill-name>       skill directory name (required)
  --vendor <vendor>  adapter vendor (default: claude)
  --skill-root <p>   repo root that contains skill subdirs (default: auto-detect from BASH_SOURCE)
  --output <path>    output path for merged SKILL.md
                     default: \$HOME/.cache/claude-skill-build/<skill-name>/SKILL.md
  --help             print this help and exit 0

Merge rules:
  - frontmatter: union(portable, overlay), overlay wins on key conflict
  - body: from portable SKILL.md only (overlay must not contain body)
  - missing overlay: portable passthrough (exit 0)
  - malformed YAML: exit 2

Exit codes: 0=success, 1=usage error, 2=YAML/IO error
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
SKILL_NAME=""
VENDOR="claude"
SKILL_ROOT=""
OUTPUT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vendor)    VENDOR="$2";     shift 2 ;;
    --skill-root) SKILL_ROOT="$2"; shift 2 ;;
    --output)    OUTPUT_PATH="$2"; shift 2 ;;
    --help|-h)   usage; exit 0 ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -z "$SKILL_NAME" ]]; then
        SKILL_NAME="$1"
        shift
      else
        echo "error: unexpected argument: $1" >&2
        usage
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$SKILL_NAME" ]]; then
  echo "error: <skill-name> is required" >&2
  usage
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
# Default skill-root: two directories up from this script (_lib/scripts → repo)
if [[ -z "$SKILL_ROOT" ]]; then
  SKILL_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

PORTABLE_SKILL_MD="$SKILL_ROOT/$SKILL_NAME/SKILL.md"
OVERLAY_FILE="$SKILL_ROOT/$SKILL_NAME/adapters/$VENDOR.yaml"

# Default output: genuinely outside the repo to avoid overwriting tracked sources.
# IMPORTANT: ~/.claude/skills may be a symlink TO the repo on some setups; use
# $HOME/.cache/claude-skill-build/ as a safe, non-repo default.
if [[ -z "$OUTPUT_PATH" ]]; then
  OUTPUT_PATH="$HOME/.cache/claude-skill-build/$SKILL_NAME/SKILL.md"
fi

# ---------------------------------------------------------------------------
# Validate inputs
# ---------------------------------------------------------------------------
if [[ ! -f "$PORTABLE_SKILL_MD" ]]; then
  echo "error: portable SKILL.md not found: $PORTABLE_SKILL_MD" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Extract frontmatter and body from portable SKILL.md
# ---------------------------------------------------------------------------
# Frontmatter = content between first and second '---' delimiters.
# Body = everything after the second '---'.
#
# We write frontmatter to a temp file and pass it to yaml-merge.py.
# Body is preserved verbatim.

TMPDIR_LOCAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT

PORTABLE_FM_FILE="$TMPDIR_LOCAL/portable_fm.yaml"
BODY_FILE="$TMPDIR_LOCAL/body.txt"

# Use awk to split frontmatter / body (handles embedded '---' in body).
# We pass file paths via -v to stay compatible with both GNU awk and macOS awk.
awk -v fm_file="$PORTABLE_FM_FILE" -v body_file="$BODY_FILE" '
  BEGIN { fm_open=0; fm_done=0; delimiter_count=0; }
  /^---[[:space:]]*$/ {
    delimiter_count++;
    if (delimiter_count == 1) { fm_open=1; next }
    if (delimiter_count == 2) { fm_done=1; fm_open=0; next }
  }
  fm_open  { print > fm_file; next }
  fm_done  { print > body_file; next }
' "$PORTABLE_SKILL_MD"

# Verify frontmatter was extracted
if [[ ! -s "$PORTABLE_FM_FILE" ]]; then
  echo "error: portable SKILL.md does not have valid frontmatter: $PORTABLE_SKILL_MD" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Merge frontmatter
# ---------------------------------------------------------------------------
MERGED_FM_FILE="$TMPDIR_LOCAL/merged_fm.yaml"

if [[ -f "$OVERLAY_FILE" ]]; then
  # Overlay exists — merge portable + overlay (overlay wins on conflict).
  # IMPORTANT: stderr (warnings, parse errors) must stay on stderr so it does
  # not leak into MERGED_FM_FILE. Only stdout is the merged YAML.
  if ! python3 "$YAML_MERGE_PY" "$PORTABLE_FM_FILE" "$OVERLAY_FILE" > "$MERGED_FM_FILE"; then
    # yaml-merge.py already printed the error to stderr; propagate exit 2.
    exit 2
  fi
  # Re-check that yaml-merge.py wrote non-empty output (unlikely to be empty on success).
  if [[ ! -s "$MERGED_FM_FILE" ]]; then
    echo "error: yaml-merge.py produced empty output for $SKILL_NAME" >&2
    exit 2
  fi
else
  # No overlay — portable passthrough.
  echo "[build-skill-overlay] no overlay found: $OVERLAY_FILE (passthrough)" >&2
  cp "$PORTABLE_FM_FILE" "$MERGED_FM_FILE"
fi

# ---------------------------------------------------------------------------
# Assemble merged SKILL.md (atomic write via temp → mv)
# ---------------------------------------------------------------------------
MERGED_TMP_FILE="$TMPDIR_LOCAL/SKILL.md.tmp"

{
  printf -- '---\n'
  cat "$MERGED_FM_FILE"
  printf -- '---\n'
  if [[ -s "$BODY_FILE" ]]; then
    cat "$BODY_FILE"
  fi
} > "$MERGED_TMP_FILE"

# ---------------------------------------------------------------------------
# Write output (atomic)
# ---------------------------------------------------------------------------
mkdir -p "$(dirname "$OUTPUT_PATH")"
mv "$MERGED_TMP_FILE" "$OUTPUT_PATH"

echo "[build-skill-overlay] written: $OUTPUT_PATH" >&2
