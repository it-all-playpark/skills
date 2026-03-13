---
name: seed-refresh
description: |
  Bulk refresh seed cache files (`seed/**/exported.md`, `commits.md`, `issues.md`, `pr-summary.md`) by checking repository updates after `manifest.json.exportedAt`.
  Use when: (1) seed cache is stale, (2) user asks to refresh/update seed files in batch, (3) keywords like "seed更新", "再取得", "exportedAt以降", "main branch更新".
  Accepts args: [--seed DIR] [--branch main] [--force] [--dry-run] [--limit N]
---

# Seed Refresh

Refresh `seed/**` caches in batch.

## Usage

```bash
python3 ~/.claude/skills/seed-refresh/scripts/refresh_seed_cache.py [--seed DIR] [--branch main] [--force] [--dry-run] [--limit N]
```

## Rules

1. Read each `seed/*/manifest.json`.
2. Resolve source repository from `source` or `url`.
3. Compare `manifest.json.exportedAt` with latest commit time on `--branch` (default: `main`).
4. Re-fetch only when repository has newer commits, unless `--force` is set.
5. Re-fetch all of:
   - `exported.md`
   - `commits.md`
   - `issues.md`
   - `pr-summary.md`
6. After successful re-fetch, update `manifest.json.exportedAt` to current UTC timestamp.

## Examples

```bash
# default: seed/*, branch=main
python3 ~/.claude/skills/seed-refresh/scripts/refresh_seed_cache.py

# dry-run only (no file updates)
python3 ~/.claude/skills/seed-refresh/scripts/refresh_seed_cache.py --dry-run

# only one seed directory
python3 ~/.claude/skills/seed-refresh/scripts/refresh_seed_cache.py --seed seed/playpark-llc-corporate-site

# force refresh regardless of commit date
python3 ~/.claude/skills/seed-refresh/scripts/refresh_seed_cache.py --force
```

## Dependencies

- `gh` authenticated (`gh auth status`)
- `python3`
- Existing global skills:
  - `~/.claude/skills/repo-export/scripts/export_repo.py`
  - `~/.claude/skills/repo-commit/scripts/export_commit.py`
  - `~/.claude/skills/repo-issue/scripts/export_issue.py`
  - `~/.claude/skills/repo-pr/scripts/export_pr.py`
