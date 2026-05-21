#!/usr/bin/env bash
# install-claude-skills-link.sh — convert ~/.claude/skills from a single symlink
# to a real directory with per-skill symlinks, wiring adapter overlay artifacts.
#
# Subcommands:
#   install [options]  (default) — backup existing ~/.claude/skills, create real dir,
#                                   populate per-skill symlinks
#   restore [options]            — revert to latest ~/.claude/skills.bak-<ts>
#
# Per-skill symlink target:
#   - skill WITH <repo>/<skill>/adapters/claude.yaml → <repo>/.build/skills/<skill>/
#   - skill WITHOUT overlay                          → <repo>/<skill>/
#
# Skills discovered from:
#   <repo>/*/SKILL.md
#   <repo>/.claude/skills/*/SKILL.md
#   <repo>/.agents/skills/*/SKILL.md
#
# Conflicts (same name from multiple locations): root > .claude/skills > .agents/skills
#
# Usage:
#   install-claude-skills-link.sh [install] [--repo-root <path>] [--vendor <vendor>]
#                                            [--dry-run]
#   install-claude-skills-link.sh restore   [--dry-run]
#
# Options:
#   --repo-root <path>  path to skills repo root (default: auto-detect from BASH_SOURCE)
#   --vendor <vendor>   adapter vendor (default: claude)
#   --dry-run           print actions without executing
#   --help              print this help and exit 0
#
# Exit codes:
#   0  success
#   1  usage / argument error
#   2  filesystem error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat >&2 << EOF
usage: $(basename "$0") [install|restore] [--repo-root <path>] [--vendor <vendor>] [--dry-run]

  install      (default) convert ~/.claude/skills to real dir with per-skill symlinks
  restore      revert to latest ~/.claude/skills.bak-<ts> backup

  --repo-root <path>  skills repo root (default: auto-detect)
  --vendor <vendor>   adapter vendor (default: claude)
  --dry-run           print actions without executing
  --help              print this help

Exit codes: 0=success, 1=usage error, 2=filesystem error
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
SUBCOMMAND="install"
REPO_ROOT=""
VENDOR="claude"
DRY_RUN=false

# First positional may be subcommand
if [[ $# -gt 0 && ( "$1" == "install" || "$1" == "restore" ) ]]; then
  SUBCOMMAND="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)  REPO_ROOT="$2"; shift 2 ;;
    --vendor)     VENDOR="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=true; shift ;;
    --help|-h)    usage; exit 0 ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage; exit 1 ;;
    *)
      echo "error: unexpected argument: $1" >&2
      usage; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

CLAUDE_SKILLS_DIR="$HOME/.claude/skills"

# ---------------------------------------------------------------------------
# Dry-run wrapper
# ---------------------------------------------------------------------------
run_cmd() {
  if $DRY_RUN; then
    echo "[dry-run] $*" >&2
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Discover skills
# Priority: root > .claude/skills > .agents/skills (first-seen wins)
# Returns: prints "skill_name|source_root" pairs to stdout
# ---------------------------------------------------------------------------
discover_skills() {
  declare -A seen

  discover_from() {
    local base_dir="$1"
    local skill_root="$2"
    [[ -d "$base_dir" ]] || return 0

    for skill_md in "$base_dir"/*/SKILL.md; do
      [[ -f "$skill_md" ]] || continue
      local skill_name
      skill_name="$(basename "$(dirname "$skill_md")")"
      [[ "$skill_name" == "_lib" ]] && continue
      [[ "$skill_name" == "_shared" ]] && continue
      if [[ -z "${seen[$skill_name]+x}" ]]; then
        seen["$skill_name"]="$skill_root"
        echo "$skill_name|$skill_root"
      fi
    done
  }

  discover_from "$REPO_ROOT" "$REPO_ROOT"
  discover_from "$REPO_ROOT/.claude/skills" "$REPO_ROOT/.claude/skills"
  discover_from "$REPO_ROOT/.agents/skills" "$REPO_ROOT/.agents/skills"
}

# ---------------------------------------------------------------------------
# SUBCOMMAND: install
# ---------------------------------------------------------------------------
cmd_install() {
  local ts
  ts="$(date '+%Y%m%d-%H%M%S')"

  # Step 1: Backup existing ~/.claude/skills
  if [[ -e "$CLAUDE_SKILLS_DIR" ]] || [[ -L "$CLAUDE_SKILLS_DIR" ]]; then
    local bak_dir="$HOME/.claude/skills.bak-$ts"

    if $DRY_RUN; then
      echo "[dry-run] rename $CLAUDE_SKILLS_DIR → $bak_dir" >&2
      echo "[dry-run] write $bak_dir/manifest.json" >&2
    else
      # Determine original type
      local original_type="directory"
      local original_target=""
      if [[ -L "$CLAUDE_SKILLS_DIR" ]]; then
        original_type="symlink"
        original_target="$(readlink "$CLAUDE_SKILLS_DIR")"
      elif [[ ! -d "$CLAUDE_SKILLS_DIR" ]]; then
        original_type="file"
      fi

      # Create bak dir and write manifest first
      mkdir -p "$bak_dir"
      cat > "$bak_dir/manifest.json" << EOF
{
  "timestamp": "$ts",
  "original_type": "$original_type",
  "original_target": "$original_target",
  "backup_path": "$bak_dir"
}
EOF

      if [[ "$original_type" == "symlink" ]]; then
        # For a symlink: just record the target in manifest (no content to move)
        /bin/rm -f "$CLAUDE_SKILLS_DIR"
      else
        # For a real directory: move all contents into bak_dir (assert all moves succeed before cleanup)
        if [[ -d "$CLAUDE_SKILLS_DIR" ]]; then
          local move_fail=0
          for entry in "$CLAUDE_SKILLS_DIR"/.*  "$CLAUDE_SKILLS_DIR"/*; do
            [[ -e "$entry" ]] || [[ -L "$entry" ]] || continue
            local basename
            basename="$(basename "$entry")"
            [[ "$basename" == "." ]] || [[ "$basename" == ".." ]] && continue
            if ! mv "$entry" "$bak_dir/"; then
              echo "error: failed to move $entry to backup, aborting to prevent data loss" >&2
              move_fail=1
              break
            fi
          done
          if [[ $move_fail -eq 0 ]]; then
            /bin/rmdir "$CLAUDE_SKILLS_DIR" 2>/dev/null || /bin/rm -rf "$CLAUDE_SKILLS_DIR"
          else
            # Restore what we moved (roll back)
            for entry in "$bak_dir"/*; do
              [[ -e "$entry" ]] || continue
              mv "$entry" "$CLAUDE_SKILLS_DIR/" || true
            done
            exit 2
          fi
        fi
      fi

      echo "[install] backed up to $bak_dir" >&2
    fi
  else
    echo "[install] no existing ~/.claude/skills, skipping backup" >&2
  fi

  # Step 2: Create real directory
  run_cmd mkdir -p "$CLAUDE_SKILLS_DIR"

  # Step 3: Populate per-skill symlinks
  local discovered
  discovered="$(discover_skills)"

  if [[ -z "$discovered" ]]; then
    echo "[install] warning: no skills discovered in $REPO_ROOT" >&2
  fi

  while IFS='|' read -r skill_name skill_root; do
    local overlay_file="$skill_root/$skill_name/adapters/$VENDOR.yaml"
    local symlink_target

    if [[ -f "$overlay_file" ]]; then
      # Has overlay → point to .build/skills artifact
      symlink_target="$REPO_ROOT/.build/skills/$skill_name"
    else
      # No overlay → point directly to source skill dir
      symlink_target="$skill_root/$skill_name"
    fi

    local skill_link="$CLAUDE_SKILLS_DIR/$skill_name"

    if $DRY_RUN; then
      echo "[dry-run] ln -sfn $symlink_target $skill_link" >&2
    else
      ln -sfn "$symlink_target" "$skill_link"
      echo "[install] linked: $skill_name → $symlink_target" >&2
    fi
  done <<< "$discovered"

  echo "[install] done" >&2
}

# ---------------------------------------------------------------------------
# SUBCOMMAND: restore
# ---------------------------------------------------------------------------
cmd_restore() {
  # Find the latest backup dir
  local latest_bak
  latest_bak="$(find "$HOME/.claude" -maxdepth 1 -name 'skills.bak-*' -type d | sort | tail -1)"

  if [[ -z "$latest_bak" ]]; then
    echo "error: no backup found matching $HOME/.claude/skills.bak-*" >&2
    exit 2
  fi

  echo "[restore] restoring from $latest_bak" >&2

  # Read manifest to determine original type
  local original_type="directory"
  if [[ -f "$latest_bak/manifest.json" ]]; then
    original_type="$(python3 -c "import sys,json; d=json.load(open('$latest_bak/manifest.json')); print(d.get('original_type','directory'))" 2>/dev/null || echo "directory")"
  fi

  # Remove current ~/.claude/skills
  if [[ -e "$CLAUDE_SKILLS_DIR" ]] || [[ -L "$CLAUDE_SKILLS_DIR" ]]; then
    if $DRY_RUN; then
      echo "[dry-run] remove $CLAUDE_SKILLS_DIR" >&2
    else
      /bin/rm -rf "$CLAUDE_SKILLS_DIR"
    fi
  fi

  if $DRY_RUN; then
    echo "[dry-run] move $latest_bak → $CLAUDE_SKILLS_DIR" >&2
  else
    if [[ "$original_type" == "symlink" ]]; then
      local original_target
      original_target="$(python3 -c "import sys,json; d=json.load(open('$latest_bak/manifest.json')); print(d.get('original_target',''))" 2>/dev/null || echo "")"
      if [[ -n "$original_target" ]]; then
        # Remove manifest from bak before moving, then symlink back
        ln -s "$original_target" "$CLAUDE_SKILLS_DIR"
        /bin/rm -rf "$latest_bak"
        echo "[restore] restored original symlink → $original_target" >&2
        return 0
      fi
    fi
    # Default: restore as directory
    # Remove manifest.json from backup (it's a meta file, not original content)
    /bin/rm -f "$latest_bak/manifest.json"
    mv "$latest_bak" "$CLAUDE_SKILLS_DIR"
    echo "[restore] restored directory from $latest_bak" >&2
  fi
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
case "$SUBCOMMAND" in
  install) cmd_install ;;
  restore) cmd_restore ;;
  *)
    echo "error: unknown subcommand: $SUBCOMMAND" >&2
    usage; exit 1 ;;
esac
