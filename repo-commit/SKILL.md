---
name: repo-commit
description: |
  Export GitHub Commit history to a Markdown file using gh CLI.
  Use when: (1) user wants to extract commit history for documentation,
  (2) needs commit context for understanding development timeline,
  (3) keywords like "export commits", "commit history", "changelog".
  Accepts args: GITHUB_URL [-o output.md] [--limit N] [--since DATE] [--author AUTHOR]
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
| `--since` | Only commits after this date (YYYY-MM-DD) |
| `--author` | Filter by author username |
| `--branch` | Branch to export commits from (default: default branch) |

### Examples

```bash
# Export recent commits
/repo-commit https://github.com/user/repo

# Export commits from specific date
/repo-commit user/repo --since 2026-01-01 --limit 50

# Export to seed directory
/repo-commit user/repo -o seed/project-name/commits.md --branch main
```

## Execution

Run the export script:

```bash
python3 ~/.claude/skills/repo-commit/scripts/export_commit.py <url> [options]
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
- **Files Changed**: 5

Full commit message body here...

---
```

## Requirements

- `gh` CLI installed and authenticated
- Python 3.10+
