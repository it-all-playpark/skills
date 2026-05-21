#!/usr/bin/env bash
# lint-merged-frontmatter.sh — validate that a merged SKILL.md artifact contains
# required frontmatter keys.
#
# Usage:
#   lint-merged-frontmatter.sh <skill-md-path> --require <key1,key2,...>
#
# Arguments:
#   <skill-md-path>      path to the merged SKILL.md file
#   --require <keys>     comma-separated list of required frontmatter keys
#   --help               print this help and exit 0
#
# Exit codes:
#   0  all required keys present
#   1  usage / argument error
#   2  one or more required keys missing, or no frontmatter found

set -euo pipefail

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat >&2 << EOF
usage: $(basename "$0") <skill-md-path> --require <key1,key2,...>

  <skill-md-path>      path to merged SKILL.md to validate
  --require <keys>     comma-separated list of required frontmatter keys
                       example: --require model,effort,context,allowed-tools
  --help               print this help and exit 0

Exit codes: 0=all keys present, 1=usage error, 2=missing keys or no frontmatter
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
SKILL_MD=""
REQUIRE_KEYS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --require) REQUIRE_KEYS="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage; exit 1 ;;
    *)
      if [[ -z "$SKILL_MD" ]]; then
        SKILL_MD="$1"; shift
      else
        echo "error: unexpected argument: $1" >&2
        usage; exit 1
      fi ;;
  esac
done

if [[ -z "$SKILL_MD" ]]; then
  echo "error: <skill-md-path> is required" >&2
  usage; exit 1
fi

if [[ ! -f "$SKILL_MD" ]]; then
  echo "error: file not found: $SKILL_MD" >&2
  exit 2
fi

if [[ -z "$REQUIRE_KEYS" ]]; then
  echo "error: --require <keys> is required" >&2
  usage; exit 1
fi

# ---------------------------------------------------------------------------
# Extract frontmatter
# ---------------------------------------------------------------------------
TMPDIR_LOCAL="$(mktemp -d)"
trap '/bin/rm -rf "$TMPDIR_LOCAL"' EXIT

FM_FILE="$TMPDIR_LOCAL/frontmatter.yaml"

awk -v fm_file="$FM_FILE" '
  BEGIN { fm_open=0; fm_done=0; delim_count=0; }
  /^---[[:space:]]*$/ {
    delim_count++;
    if (delim_count == 1) { fm_open=1; next }
    if (delim_count == 2) { fm_done=1; fm_open=0; next }
  }
  fm_open  { print > fm_file; next }
  fm_done  { next }
' "$SKILL_MD"

if [[ ! -s "$FM_FILE" ]]; then
  echo "error: no frontmatter found in $SKILL_MD" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Check required keys
# ---------------------------------------------------------------------------
missing_keys=()

IFS=',' read -ra keys <<< "$REQUIRE_KEYS"
for key in "${keys[@]}"; do
  key="$(echo "$key" | tr -d ' ')"
  [[ -z "$key" ]] && continue

  # Check if key is present as a YAML key (supports multiline values like allowed-tools:)
  if ! grep -qE "^${key}:" "$FM_FILE"; then
    missing_keys+=("$key")
  fi
done

if [[ ${#missing_keys[@]} -gt 0 ]]; then
  echo "error: missing required frontmatter keys in $SKILL_MD:" >&2
  for k in "${missing_keys[@]}"; do
    echo "  - $k" >&2
  done
  exit 2
fi

echo "[lint-merged-frontmatter] OK: all required keys present in $SKILL_MD" >&2
exit 0
