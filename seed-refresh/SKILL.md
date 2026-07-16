---
name: seed-refresh
description: |
  Bulk refresh seed cache files (`seed/**/exported.md`, `commits.md`, `issues.md`, `pr-summary.md`) by checking repository updates after `manifest.json.exportedAt`.
  Use when: (1) seed cache is stale, (2) user asks to refresh/update seed files in batch, (3) keywords like "seed更新", "再取得", "exportedAt以降", "main branch更新".
  Accepts args: [--seed DIR] [--branch main] [--force] [--dry-run] [--limit N]
model: haiku
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
manifest.json 読込 → exportedAt 比較 → 更新あり → 4ファイル再取得 → exportedAt + トークン計測を manifest 更新
```

Details: [Algorithm Detail](references/algorithm-detail.md)

## Tests exclusion

`exported.md` 生成時は既定で tests 系パス
(`**/[Tt]ests/**,**/*.test.*,**/*.spec.*,**/__tests__/**,**/testdata/**,**/__snapshots__/**,**/fixtures/**`)
を repomix `--ignore` で除外する（seed のトークン削減目的・lossless）。

per-seed で除外を無効化するには `manifest.json` に `"includeTests": true` を設定する。
`includeTests` が boolean 以外の値の場合、当該 seed は error（reason: `invalid_includeTests`）になる。

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
