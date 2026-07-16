---
name: repo-export
description: |
  Export GitHub repository contents to a single Markdown file using repomix.
  Use when: (1) user wants to export/download repository code for review,
  (2) needs to consolidate repo files into one document, (3) wants to share
  codebase context, (4) keywords like "export repo", "dump repository",
  "consolidate files", "repo to markdown".
  Accepts args: GITHUB_URL [-o output.md] [-b branch] [-p path] [--compress] [--ignore patterns]
context: fork
model: haiku
effort: low
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
| `--compress` | Enable repomix code compression (reduces token count; also prints a `TOKENS_RAW=` baseline line for comparison) |
| `--ignore` | Comma-separated glob patterns passed through verbatim to repomix `--ignore`, applied in addition to repomix's default ignore rules. Default: unset (no additional exclusions) |

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

# Exclude test files via repomix --ignore passthrough
/repo-export user/repo --ignore '**/*.test.*,**/__tests__/**'
```

## Execution

Run the export script:

```bash
python3 $SKILLS_DIR/repo-export/scripts/export_repo.py <url> [options]
```

## Output Format

repomix's `markdown` style: a file-summary header followed by one section per
file (`## File: path/to/file`) with the contents in a fenced code block.

````markdown
This file is a merged representation of the entire codebase...

# File Summary
...

# Directory Structure
```
...
```

# Files

## File: path/to/file.ts
```ts
// file contents
```

## File: path/to/another.py
```python
# file contents
```
````

## Output (stdout contract)

The script transcribes repomix's own stdout/stderr verbatim, then appends:

- `TOKENS=<int>` (or `TOKENS=unknown` if repomix's summary doesn't expose a
  parseable `Total Tokens:` line) — token count of the final output.
- With `--compress`, an additional `TOKENS_RAW=<int>` (or `TOKENS_RAW=unknown`)
  line is printed first, from an uncompressed baseline run, so callers can
  compute the compression's token reduction.

## Filters

**Auto-excluded**: repomix's default ignore rules (`node_modules`, lock files,
`.git`, build artifacts, etc.) plus repomix's built-in secretlint-based
security check.

**Additional exclusions**: pass `--ignore` with comma-separated glob patterns
to exclude more files (e.g. test files) on top of repomix's default ignores.
By default nothing extra is excluded.

## Requirements

- Node.js (for `npx repomix`) or `repomix` installed directly
- `git` (for remote clone; private repositories require git credentials to be
  configured, e.g. via `gh auth setup-git`)
- Python 3.10+

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log repo-export success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log repo-export failure \
  --error-category <category> --error-msg "<message>"
```
