---
name: repo-commit
description: |
  Export GitHub Commit history to a Markdown file using gh CLI.
  Use when: (1) user wants to extract commit history for documentation,
  (2) needs commit context for understanding development timeline,
  (3) keywords like "export commits", "commit history", "changelog".
  Accepts args: GITHUB_URL [-o output.md] [--limit N] [--since DATE|Nd] [--author AUTHOR] [--no-merges] [--files]
context: fork
model: haiku
effort: low
---

# Repository Commit Export

Export GitHub Commit history to a Markdown file.

## Usage

```
/repo-commit <github-url> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<url>` | GitHub URL (`https://github.com/owner/repo`) or `owner/repo` format |
| `-o, --output` | Output file path (default: `commits.md`) |
| `--limit` | Maximum number of commits to export (default: 100) |
| `--since` | Only commits after this date: `YYYY-MM-DD` / ISO 8601 / `Nd`（例 `45d`）。committer date 基準（GitHub API `since=` と同一） |
| `--author` | Filter by author username |
| `--branch` | Branch to export commits from (default: default branch) |
| `--no-merges` | Exclude merge commits (parents が 2 以上の commit)。除外後は `--limit` 未満の件数になり得る |
| `--files` | Each commit に変更ファイル一覧を出力（commit 1件ごとに追加 API 呼び出し） |

### Examples

```bash
# Export recent commits
/repo-commit https://github.com/user/repo

# Export commits from specific date
/repo-commit user/repo --since 2026-01-01 --limit 50

# Export to seed directory
/repo-commit user/repo -o seed/project-name/commits.md --branch main

# Slice-selection input: recent non-merge commits with changed files
/repo-commit user/repo --since 45d --no-merges --files -o seed/project/commits.md
```

## Execution

Run the export script:

```bash
repo-commit <url> [options]
```

## Output Format

```markdown
# Commits: repo-name

Source: <https://github.com/owner/repo>
Branch: main
Exported: 2026-01-17
Total Commits: 50

---

## feat: Add user authentication system

- **SHA**: abc1234
- **Author**: username
- **Date**: 2026-01-15
- **Files**: src/a.ts, src/b.ts

Full commit message body here...

---
```

`- **Files**:` は `--files` 指定時のみ出力される（未指定時はこの行なし）。`--no-merges` 指定時は
`Total Commits:` が `--limit` より少なくなり得る（除外後の件数であり over-fetch はしない）。

## Requirements

- `gh` CLI installed and authenticated
- Python 3.10+

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
journal log repo-commit success \
  --duration-turns $TURNS

# On failure
journal log repo-commit failure \
  --error-category <category> --error-msg "<message>"
```
