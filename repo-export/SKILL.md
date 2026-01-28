---
name: repo-export
description: |
  Export GitHub repository contents to a single Markdown file using gh CLI.
  Use when: (1) user wants to export/download repository code for review,
  (2) needs to consolidate repo files into one document, (3) wants to share
  codebase context, (4) keywords like "export repo", "dump repository",
  "consolidate files", "repo to markdown".
  Accepts args: GITHUB_URL [-o output.md] [-b branch] [-p path]
---

# Repository Export

Export GitHub repository contents to a single Markdown file.

## Usage

```
/repo-export <github-url> [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<url>` | GitHub URL (`https://github.com/owner/repo`) or `owner/repo` format |
| `-o, --output` | Output file path (default: `repo-export.md`) |
| `-b, --branch` | Target branch (default: repository default branch) |
| `-p, --path` | Only export files under this directory path |

### Examples

```bash
# Export entire repository
/repo-export https://github.com/user/repo

# Export specific branch
/repo-export user/repo --branch develop

# Export only src directory
/repo-export user/repo --path src

# Custom output file
/repo-export user/repo -o analysis.md -b main -p lib
```

## Execution

Run the export script:

```bash
python3 ~/.claude/skills/repo-export/scripts/export_repo.py <url> [options]
```

## Output Format

```markdown
# repo-name

Source: <https://github.com/owner/repo>

---

## path/to/file.ts

\`\`\`ts
// file contents
\`\`\`

## path/to/another.py

\`\`\`python
# file contents
\`\`\`
```

## Filters

**Auto-excluded**:
- Binary files (images, audio, video, archives, fonts, compiled)
- Lock files (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`)
- Build artifacts (`node_modules`, `__pycache__`, `.git`)
- Environment files (`.env`, `.env.local`)

## Requirements

- `gh` CLI installed and authenticated
- Python 3.10+
