#!/usr/bin/env bash
# sync-env.sh - Sync .env files from source repository to target worktree
# Usage: sync-env.sh --worktree <path> [--mode hardlink|symlink|copy] [--source <path>] [--force]
#
# Output: JSON with sync results

set -euo pipefail

# Defaults
WORKTREE=""
MODE="hardlink"
SOURCE=""
FORCE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --worktree) WORKTREE="$2"; shift 2 ;;
        --mode) MODE="$2"; shift 2 ;;
        --source) SOURCE="$2"; shift 2 ;;
        --force) FORCE=true; shift ;;
        -h|--help)
            echo "Usage: sync-env.sh --worktree <path> [--mode hardlink|symlink|copy] [--source <path>] [--force]"
            exit 0
            ;;
        *)
            echo "Error: Unknown option $1" >&2
            exit 1
            ;;
    esac
done

# Validate required args
if [[ -z "$WORKTREE" ]]; then
    echo "Error: --worktree is required" >&2
    exit 1
fi

if [[ ! -d "$WORKTREE" ]]; then
    echo "Error: Worktree directory does not exist: $WORKTREE" >&2
    exit 1
fi

if [[ ! "$MODE" =~ ^(hardlink|symlink|copy)$ ]]; then
    echo "Error: Invalid mode '$MODE'. Use: hardlink, symlink, or copy" >&2
    exit 1
fi

# Auto-detect source from worktree's git common dir
if [[ -z "$SOURCE" ]]; then
    SOURCE=$(cd "$WORKTREE" && git rev-parse --path-format=absolute --git-common-dir | sed 's|/\.git$||')
    if [[ -z "$SOURCE" || ! -d "$SOURCE" ]]; then
        echo "Error: Could not auto-detect source repository from worktree" >&2
        exit 1
    fi
fi

# Resolve to absolute paths
WORKTREE=$(cd "$WORKTREE" && pwd)
SOURCE=$(cd "$SOURCE" && pwd)

# Collect .env files from source
# -L: follow symlinks (monorepo workspace support)
# -maxdepth 10: prevent circular symlink traversal
ENV_FILES=()
while IFS= read -r -d '' env_file; do
    ENV_FILES+=("$env_file")
done < <(find -L "$SOURCE" -maxdepth 10 -name ".env*" -type f \
    -not -path "*/node_modules/*" \
    -not -path "*/.git/*" \
    -not -path "*-worktrees/*" \
    -print0)

# Sync files
FILES_SYNCED=()
FILES_SKIPPED=()
ERRORS=()

for env_file in "${ENV_FILES[@]}"; do
    relative_path="${env_file#$SOURCE/}"
    target_path="$WORKTREE/$relative_path"
    target_dir=$(dirname "$target_path")

    # Check if target already exists
    if [[ -e "$target_path" ]]; then
        if [[ "$FORCE" == true ]]; then
            rm -f "$target_path"
        else
            FILES_SKIPPED+=("\"existing:$relative_path\"")
            continue
        fi
    fi

    mkdir -p "$target_dir"

    case "$MODE" in
        hardlink)
            if ln "$env_file" "$target_path" 2>/dev/null; then
                FILES_SYNCED+=("\"hardlink:$relative_path\"")
            elif cp "$env_file" "$target_path"; then
                FILES_SYNCED+=("\"copy:$relative_path\"")
            else
                ERRORS+=("\"failed:$relative_path\"")
            fi
            ;;
        symlink)
            if ln -sf "$env_file" "$target_path"; then
                FILES_SYNCED+=("\"symlink:$relative_path\"")
            else
                ERRORS+=("\"failed:$relative_path\"")
            fi
            ;;
        copy)
            if cp "$env_file" "$target_path"; then
                FILES_SYNCED+=("\"copy:$relative_path\"")
            else
                ERRORS+=("\"failed:$relative_path\"")
            fi
            ;;
    esac
done

# Build JSON arrays
join_array() {
    local IFS=","
    echo "$*"
}

SYNCED_JSON=$(join_array "${FILES_SYNCED[@]+"${FILES_SYNCED[@]}"}")
SKIPPED_JSON=$(join_array "${FILES_SKIPPED[@]+"${FILES_SKIPPED[@]}"}")
ERRORS_JSON=$(join_array "${ERRORS[@]+"${ERRORS[@]}"}")

# Determine status
STATUS="synced"
if [[ ${#ERRORS[@]} -gt 0 ]]; then
    STATUS="partial"
fi
if [[ ${#FILES_SYNCED[@]} -eq 0 && ${#ERRORS[@]} -eq 0 ]]; then
    STATUS="no_changes"
fi

# Output JSON
cat <<EOF
{
  "status": "$STATUS",
  "source": "$SOURCE",
  "worktree": "$WORKTREE",
  "mode": "$MODE",
  "files_synced": [${SYNCED_JSON}],
  "files_skipped": [${SKIPPED_JSON}],
  "errors": [${ERRORS_JSON}],
  "total_synced": ${#FILES_SYNCED[@]},
  "total_skipped": ${#FILES_SKIPPED[@]},
  "total_errors": ${#ERRORS[@]}
}
EOF
