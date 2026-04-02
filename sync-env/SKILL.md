---
name: sync-env
description: |
  Sync .env files from source repository to target worktree directory.
  Use when: (1) worktree missing .env files, (2) retry after failed integration,
  (3) keywords: env sync, dotenv, .env copy, worktree env
  Accepts args: --worktree <path> [--mode hardlink|symlink|copy] [--source <path>] [--force]
allowed-tools:
  - Bash
---

# Sync Env

Sync `.env` files from a source repository to a target worktree directory.

## Usage

```bash
scripts/sync-env.sh --worktree <path> [--mode hardlink|symlink|copy] [--source <path>] [--force]
```

## Arguments

| Arg | Default | Description |
|-----|---------|-------------|
| `--worktree` | required | Target worktree path |
| `--mode` | `hardlink` | Link strategy: hardlink, symlink, or copy |
| `--source` | auto | Source repository root (auto-detected from worktree git info) |
| `--force` | false | Overwrite existing .env files |

## Examples

```bash
# Basic: sync .env files to worktree (auto-detect source)
scripts/sync-env.sh --worktree /path/to/worktree

# Use symlinks instead of hardlinks
scripts/sync-env.sh --worktree /path/to/worktree --mode symlink

# Force overwrite existing .env files
scripts/sync-env.sh --worktree /path/to/worktree --force

# Explicit source repository
scripts/sync-env.sh --worktree /path/to/worktree --source /path/to/repo
```

## Output

```json
{
  "status": "synced",
  "source": "/path/to/repo",
  "worktree": "/path/to/worktree",
  "mode": "hardlink",
  "files_synced": ["hardlink:.env", "hardlink:apps/api/.env.local"],
  "files_skipped": [],
  "total_synced": 2,
  "total_skipped": 0
}
```

## Requirements

- `jq` - JSON output の構築に使用

## Notes

- Follows symlinks (`find -L`) for monorepo workspace support
- Idempotent: without `--force`, existing files are skipped
- With `--force`, existing files are removed and re-created
- Excludes `node_modules/`, `.git/`, and `*-worktrees/` directories
- Falls back to copy if hardlink fails (cross-device)

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log sync-env success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log sync-env failure \
  --error-category <category> --error-msg "<message>"
```
