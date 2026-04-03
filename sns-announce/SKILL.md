---
name: sns-announce
description: |
  Generate SNS announcement posts from MDX/Markdown articles or published URLs.
  Use when: (1) user wants to create social media posts from blog content,
  (2) needs X, LinkedIn, Google Business, Facebook, Bluesky, Threads text,
  (3) keywords like "SNS告知", "告知文", "投稿文", "announce", "social media post",
  (4) input: MDX/Markdown files or published blog URLs.
  Accepts args: <source> [--output FILE] [--format md|json|yaml] [--schedule "YYYY-MM-DD HH:MM"] [--dedupe] [--x] [--linkedin] [--google] [--facebook] [--bluesky] [--threads] [--platforms LIST] [--base-url URL] [--lang ja|en]
---

# SNS Announce

Generate platform-optimized social media posts from articles or URLs.

## Usage

```
/sns-announce <source> [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--output, -o FILE` | Output to file | config or stdout |
| `--format FORMAT` | md, json, yaml | config or md |
| `--schedule DATETIME` | Schedule time (enables Zernio API format) | config or none |
| `--dedupe` | Pre-check Zernio API and skip already scheduled platforms | false |
| `--x` | X only | all enabled |
| `--linkedin` | LinkedIn only | all enabled |
| `--google` | Google Business only | all enabled |
| `--facebook` | Facebook only | all enabled |
| `--bluesky` | Bluesky only | all enabled |
| `--threads` | Threads only | all enabled |
| `--base-url URL` | Base URL for links | config |
| `--lang LANG` | ja, en | config or ja |

**Priority**: CLI args > config file > defaults

## Configuration

Project config: `.claude/sns-announce.json` -- defines base_url, output path/format, schedule mode, and per-platform enable/disable.

Details: [Config Schema](references/config-schema.md)

## Workflow

### Standard (without --dedupe)
```
1. Load config → 2. Extract metadata → 3. Generate posts (all platforms) → 4. Write output
```

### Optimized (with --dedupe)
```
1. Load config → 2. Extract metadata (get date) → 3. Query Zernio API → 4. Generate posts (needed only) → 5. Write output
```

**Key optimization**: When `--dedupe` is specified, query Zernio API BEFORE generation to identify which platforms need posts. This avoids wasting AI tokens generating content for already-scheduled platforms.

Details: [Dedupe Flow & Scripts](references/dedupe-flow.md)

## Platform Guidelines

See [Platform Guide](references/platform-guide.md) for detailed limits, audience, style, and templates per platform.

**Quick reference**: X ~120字, LinkedIn 1,300, Google 1,500, Facebook 500推奨, Bluesky 300, Threads 500

## Output Format

Markdown (default): separator-delimited blocks per platform. JSON: standard object or Zernio API array format when schedule is enabled.

Details: [Output Formats](references/output-formats.md)

## Examples

```bash
# Auto-save to config path
/sns-announce content/blog/2026-01-15-article.mdx

# With dedupe (optimized: only generates needed platforms)
/sns-announce content/blog/2026-01-15-article.mdx --dedupe

# Override output
/sns-announce article.mdx --output custom/path.md

# URL input
/sns-announce https://example.com/blog/my-article

# Specific platform
/sns-announce article.mdx --x --lang en

# Zernio API format with schedule
/sns-announce article.mdx --format json --schedule "2026-03-12 09:00"
```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log sns-announce success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log sns-announce failure \
  --error-category <category> --error-msg "<message>"
```
