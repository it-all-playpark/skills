#!/usr/bin/env bash
# build-all-skills.sh — discover all skills in the repo and build their
# Claude Code-ready SKILL.md artifacts via build-skill-overlay.sh.
#
# Design:
#   - Discovers skills from:
#       <repo>/*/SKILL.md           (root-level skills)
#       <repo>/.claude/skills/*/SKILL.md   (internal tooling skills)
#       <repo>/.agents/skills/*/SKILL.md   (external agent skills)
#   - Cleans <repo>/.build/skills/ before rebuilding (idempotent, no stale entries)
#   - Each skill is built by calling build-skill-overlay.sh
#   - If any skill build fails, exits non-zero (all failures reported before exit)
#   - Priority for same-name conflicts: root > .claude/skills > .agents/skills
#
# Usage:
#   build-all-skills.sh [--repo-root <path>] [--vendor <vendor>]
#                       [--subdir-strategy symlink|copy] [--list-discovered]
#
# Options:
#   --repo-root <path>     repo root directory (default: auto-detect from BASH_SOURCE)
#   --vendor <vendor>      adapter vendor (default: claude)
#   --subdir-strategy      symlink|copy (default: symlink)
#   --list-discovered      print discovered skill names to stdout (no build), exit 0
#   --help                 print this help and exit 0
#
# Exit codes:
#   0  all skills built successfully (or --list-discovered)
#   1  usage / argument error
#   2  one or more skills failed to build

set -euo pipefail

# ---------------------------------------------------------------------------
# Script location
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_SKILL_OVERLAY="$SCRIPT_DIR/build-skill-overlay.sh"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat >&2 << EOF
usage: $(basename "$0") [--repo-root <path>] [--vendor <vendor>] [--subdir-strategy symlink|copy] [--list-discovered]

  --repo-root <path>     root directory of the skills repo (default: auto-detect)
  --vendor <vendor>      adapter vendor to use (default: claude)
  --subdir-strategy <s>  symlink (default) or copy
  --list-discovered      list discovered skill names to stdout without building
  --help                 print this help and exit 0

Exit codes: 0=success or --list-discovered, 1=usage error, 2=build failure
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
REPO_ROOT=""
VENDOR="claude"
SUBDIR_STRATEGY="symlink"
LIST_DISCOVERED=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)    REPO_ROOT="$2"; shift 2 ;;
    --vendor)       VENDOR="$2"; shift 2 ;;
    --subdir-strategy)
      SUBDIR_STRATEGY="$2"
      if [[ "$SUBDIR_STRATEGY" != "symlink" && "$SUBDIR_STRATEGY" != "copy" ]]; then
        echo "error: --subdir-strategy must be 'symlink' or 'copy', got: $SUBDIR_STRATEGY" >&2
        usage
        exit 1
      fi
      shift 2 ;;
    --list-discovered) LIST_DISCOVERED=true; shift ;;
    --help|-h) usage; exit 0 ;;
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

# ---------------------------------------------------------------------------
# Resolve repo root
# ---------------------------------------------------------------------------
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

# ---------------------------------------------------------------------------
# Discover skills
# Priority: root > .claude/skills > .agents/skills (first-seen wins on conflict)
# ---------------------------------------------------------------------------
declare -A SKILL_MAP  # skill_name -> source_dir

discover_from() {
  local base_dir="$1"
  local skill_root="$2"  # the skill-root to pass to build-skill-overlay.sh
  [[ -d "$base_dir" ]] || return 0

  for skill_md in "$base_dir"/*/SKILL.md; do
    [[ -f "$skill_md" ]] || continue
    local skill_name
    skill_name="$(basename "$(dirname "$skill_md")")"
    # Skip internal dirs
    [[ "$skill_name" == "_lib" ]] && continue
    [[ "$skill_name" == "_shared" ]] && continue
    # First-seen wins (priority: caller order)
    if [[ -z "${SKILL_MAP[$skill_name]+x}" ]]; then
      SKILL_MAP["$skill_name"]="$skill_root"
    fi
  done
}

# Root-level skills (highest priority)
discover_from "$REPO_ROOT" "$REPO_ROOT"
# .claude/skills/* (internal tooling)
discover_from "$REPO_ROOT/.claude/skills" "$REPO_ROOT/.claude/skills"
# .agents/skills/* (external agent skills)
discover_from "$REPO_ROOT/.agents/skills" "$REPO_ROOT/.agents/skills"

# ---------------------------------------------------------------------------
# --list-discovered: print skill names and exit
# ---------------------------------------------------------------------------
if $LIST_DISCOVERED; then
  for skill_name in $(printf '%s\n' "${!SKILL_MAP[@]}" | sort); do
    echo "$skill_name"
  done
  exit 0
fi

# ---------------------------------------------------------------------------
# Clean build directory (idempotent: removes stale entries)
# ---------------------------------------------------------------------------
BUILD_DIR="$REPO_ROOT/.build/skills"
if [[ -d "$BUILD_DIR" ]]; then
  /bin/rm -rf "$BUILD_DIR"
fi
mkdir -p "$BUILD_DIR"

# ---------------------------------------------------------------------------
# Build all discovered skills
# ---------------------------------------------------------------------------
fail_count=0
total=0

for skill_name in $(printf '%s\n' "${!SKILL_MAP[@]}" | sort); do
  skill_root="${SKILL_MAP[$skill_name]}"
  output_path="$REPO_ROOT/.build/skills/$skill_name/SKILL.md"
  ((total++)) || true

  echo "[build-all-skills] building: $skill_name (from $skill_root)" >&2

  if bash "$BUILD_SKILL_OVERLAY" "$skill_name" \
      --skill-root "$skill_root" \
      --vendor "$VENDOR" \
      --output "$output_path" \
      --subdir-strategy "$SUBDIR_STRATEGY" \
      2>&1 >&2; then
    : # success
  else
    echo "[build-all-skills] FAILED: $skill_name" >&2
    ((fail_count++)) || true
  fi
done

echo "[build-all-skills] done: $total discovered, $fail_count failed" >&2

if [[ $fail_count -gt 0 ]]; then
  exit 2
fi
exit 0
