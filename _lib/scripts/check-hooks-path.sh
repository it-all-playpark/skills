#!/usr/bin/env bash
# check-hooks-path.sh — verify or set git core.hooksPath for the repo.
#
# Used by Makefile `setup` target to configure the repo's hook path.
#
# Usage:
#   check-hooks-path.sh --apply [--force] [--repo-root <path>] [--target <path>]
#   check-hooks-path.sh --check [--repo-root <path>] [--target <path>]
#
# Options:
#   --check              only inspect current state (no change), exit 0
#   --apply              apply the target hook path if not already set
#   --force              with --apply, override an existing conflicting hooksPath
#   --target <path>      target hooksPath value (default: .githooks)
#   --repo-root <path>   git repo directory (default: current directory)
#   --help               print this help and exit 0
#
# Output (stdout): JSON with keys: status, current, target
#   status:
#     "set"          — applied successfully (was unset or --force override)
#     "already_set"  — already matches target (--apply is no-op)
#     "conflict"     — different path set; --apply without --force exits 1
#     "unset"        — --check only: core.hooksPath is not configured
#
# Exit codes:
#   0  success (set, already_set, or unset/check-only)
#   1  usage / argument error
#   2  conflict detected (--apply without --force) or git command failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
MODE=""
FORCE=false
TARGET=".githooks"
REPO_ROOT="."

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat >&2 << EOF
usage: $(basename "$0") (--check | --apply) [--force] [--target <path>] [--repo-root <path>]

  --check              inspect current core.hooksPath state (no changes)
  --apply              set core.hooksPath to target if not already set
  --force              with --apply, override conflicting hooksPath
  --target <path>      desired hooksPath value (default: .githooks)
  --repo-root <path>   git repo root (default: current dir)
  --help               print this help

Output: JSON { "status": "set|already_set|conflict|unset", "current": "...", "target": "..." }
Exit codes: 0=ok, 1=usage error, 2=conflict or git error
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)    MODE="check"; shift ;;
    --apply)    MODE="apply"; shift ;;
    --force)    FORCE=true; shift ;;
    --target)   TARGET="$2"; shift 2 ;;
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --help|-h)  usage; exit 0 ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage
      exit 1 ;;
    *)
      echo "error: unexpected argument: $1" >&2
      usage
      exit 1 ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "error: one of --check or --apply is required" >&2
  usage
  exit 1
fi

# ---------------------------------------------------------------------------
# Get current core.hooksPath
# ---------------------------------------------------------------------------
CURRENT=""
if CURRENT="$(git -C "$REPO_ROOT" config core.hooksPath 2>/dev/null)"; then
  : # got a value
else
  CURRENT=""
fi

# ---------------------------------------------------------------------------
# Determine status and act
# ---------------------------------------------------------------------------
emit_json() {
  local status="$1"
  local current="${2:-}"
  printf '{"status":"%s","current":"%s","target":"%s"}\n' "$status" "$current" "$TARGET"
}

if [[ "$MODE" == "check" ]]; then
  if [[ -z "$CURRENT" ]]; then
    emit_json "unset" ""
  elif [[ "$CURRENT" == "$TARGET" ]]; then
    emit_json "already_set" "$CURRENT"
  else
    emit_json "conflict" "$CURRENT"
  fi
  exit 0
fi

# MODE == "apply"
if [[ -z "$CURRENT" ]]; then
  # Not set — apply
  git -C "$REPO_ROOT" config core.hooksPath "$TARGET"
  emit_json "set" "$CURRENT"
  exit 0
elif [[ "$CURRENT" == "$TARGET" ]]; then
  # Already the right value — no-op
  emit_json "already_set" "$CURRENT"
  exit 0
else
  # Conflict
  if $FORCE; then
    git -C "$REPO_ROOT" config core.hooksPath "$TARGET"
    emit_json "set" "$CURRENT"
    exit 0
  else
    emit_json "conflict" "$CURRENT" >&1
    exit 2
  fi
fi
