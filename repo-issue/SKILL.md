---
name: repo-issue
description: |
  Export GitHub Issue information to a Markdown file using gh CLI.
  Use when: (1) user wants to extract issue history for documentation,
  (2) needs issue context for understanding project evolution,
  (3) keywords like "export issues", "issue history", "issue summary".
  Accepts args: GITHUB_URL [-o output.md] [--state open|closed|all] [--limit N] [--labels LABELS]
---

# Repository Issue Export

Export GitHub Issue information to a Markdown file.

## Usage

```
/repo-issue <github-url> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<url>` | GitHub URL (`https://github.com/owner/repo`) or `owner/repo` format |
| `-o, --output` | Output file path (default: `issues.md`) |
| `--state` | Issue state filter: `open`, `closed`, `all` (default: `all`) |
| `--limit` | Maximum number of issues to export (default: 50) |
| `--labels` | Filter by labels (comma-separated) |

### Examples

```bash
# Export all issues
/repo-issue https://github.com/user/repo

# Export only closed issues
/repo-issue user/repo --state closed

# Export to seed directory with label filter
/repo-issue user/repo -o seed/project-name/issues.md --labels bug,enhancement
```

## Execution

Run the export script:

```bash
python3 ~/.claude/skills/repo-issue/scripts/export_issue.py <url> [options]
```

## Output Format

```markdown
# Issues: repo-name

Source: <https://github.com/owner/repo>
Exported: 2026-01-17
Total Issues: 30

---

## #45: Bug: Login fails on mobile

- **State**: closed
- **Author**: username
- **Created**: 2026-01-05
- **Closed**: 2026-01-08
- **Labels**: bug, mobile
- **Comments**: 5

### Description

Issue body here...

---
```

## Requirements

- `gh` CLI installed and authenticated
- Python 3.10+
