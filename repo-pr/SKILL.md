---
name: repo-pr
description: |
  Export GitHub Pull Request information to a Markdown file using gh CLI.
  Use when: (1) user wants to extract PR history for documentation,
  (2) needs PR context for blog articles or case studies,
  (3) keywords like "export PR", "PR history", "pull request summary".
  Accepts args: GITHUB_URL [-o output.md] [--state open|closed|merged|all] [--limit N]
---

# Repository PR Export

Export GitHub Pull Request information to a Markdown file.

## Usage

```
/repo-pr <github-url> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<url>` | GitHub URL (`https://github.com/owner/repo`) or `owner/repo` format |
| `-o, --output` | Output file path (default: `pr-summary.md`) |
| `--state` | PR state filter: `open`, `closed`, `merged`, `all` (default: `all`) |
| `--limit` | Maximum number of PRs to export (default: 50) |

### Examples

```bash
# Export all PRs
/repo-pr https://github.com/user/repo

# Export only merged PRs
/repo-pr user/repo --state merged

# Export to seed directory
/repo-pr user/repo -o seed/project-name/pr-summary.md --limit 30
```

## Execution

Run the export script:

```bash
python3 ~/.claude/skills/repo-pr/scripts/export_pr.py <url> [options]
```

## Output Format

```markdown
# Pull Requests: repo-name

Source: <https://github.com/owner/repo>
Exported: 2026-01-17
Total PRs: 25

---

## #123: Feature: Add user authentication

- **State**: merged
- **Author**: username
- **Created**: 2026-01-10
- **Merged**: 2026-01-15
- **Labels**: feature, enhancement

### Description

PR description body here...

---
```

## Requirements

- `gh` CLI installed and authenticated
- Python 3.10+
