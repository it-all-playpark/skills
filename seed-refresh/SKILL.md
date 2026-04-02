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

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `--seed` | `seed/` | 対象ディレクトリ |
| `--branch` | `main` | 比較対象ブランチ |
| `--force` | false | コミット日時に関係なく強制更新 |
| `--dry-run` | false | プレビューのみ |
| `--limit` | all | 処理件数制限 |

## Workflow

```
manifest.json 読込 → exportedAt 比較 → 更新あり → 4ファイル再取得 → exportedAt 更新
```

Details: [Algorithm Detail](references/algorithm-detail.md)

## Examples

```bash
# default: seed/*, branch=main
python3 ~/.claude/skills/seed-refresh/scripts/refresh_seed_cache.py

# dry-run only
python3 ~/.claude/skills/seed-refresh/scripts/refresh_seed_cache.py --dry-run

# force refresh
python3 ~/.claude/skills/seed-refresh/scripts/refresh_seed_cache.py --force
```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log seed-refresh success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log seed-refresh failure \
  --error-category <category> --error-msg "<message>"
```
