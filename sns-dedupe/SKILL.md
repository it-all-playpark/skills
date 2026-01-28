---
name: sns-dedupe
description: |
  Filter out SNS posts that are already scheduled in Late API.
  Use when: (1) before running /sns-schedule-post to avoid duplicates,
  (2) after /sns-announce when re-running with updated content,
  (3) keywords like "重複除外", "dedupe", "filter scheduled".
  Accepts args: <input.json> [-o output.json] [--dry-run] [--verbose]
---

# SNS Dedupe

Filter out posts from a JSON file that are already scheduled in Late API.
Compares by date (YYYY-MM-DD) and platform.

## Usage

```
/sns-dedupe <input.json> [-o output.json] [--dry-run] [--verbose]
```

| Argument | Description |
|----------|-------------|
| `<input.json>` | Input JSON file (sns-schedule-post format) |
| `-o, --output` | Output file path (default: stdout) |
| `-n, --dry-run` | Preview without changes |
| `-v, --verbose` | Show details for each post |

## Examples

### Filter and output to stdout
```
/sns-dedupe post/blog/2026-01-20-shift-bud.json
```

### Filter and save to new file
```
/sns-dedupe post/blog/2026-01-20-shift-bud.json -o filtered.json
```

### Preview with details
```
/sns-dedupe post/blog/2026-01-20-shift-bud.json --dry-run --verbose
```

### Pipe to sns-schedule-post
```
/sns-dedupe post/blog/2026-01-20-shift-bud.json -o /tmp/filtered.json && /sns-schedule-post --json /tmp/filtered.json
```

## Input Format

Same as sns-schedule-post JSON format:

```json
[
  {
    "content": "投稿内容",
    "schedule": "2026-01-20 09:00",
    "platforms": ["x"]
  },
  {
    "content": "LinkedIn用投稿",
    "schedule": "2026-01-20 09:00",
    "platforms": ["linkedin"]
  }
]
```

## Duplicate Detection

A post is considered duplicate if:
- Same date (YYYY-MM-DD part of schedule)
- Same platform (any overlap)
- Existing post status is `scheduled` (not `published` or `failed`)

## Setup

Uses the same `.env` as sns-schedule-post:
- `~/.claude/skills/sns-schedule-post/.env`
- Requires `LATE_API_KEY`

## Workflow

1. Generate posts with `/sns-announce`
2. Filter duplicates with `/sns-dedupe`
3. Schedule with `/sns-schedule-post`

```
/sns-announce content/blog/2026-01-20-article.mdx
/sns-dedupe post/blog/2026-01-20-article.json -o filtered.json
/sns-schedule-post --json filtered.json
```

## Pre-Query Script (check-scheduled.ts)

For optimized workflow in sns-announce, use this script BEFORE generating posts:

```bash
npx tsx ~/.claude/skills/sns-dedupe/scripts/check-scheduled.ts --date 2026-01-20 --platforms x,linkedin,facebook
```

### Output
```json
{
  "date": "2026-01-20",
  "needed": ["x", "facebook"],
  "scheduled": ["linkedin"]
}
```

### Options
| Option | Description |
|--------|-------------|
| `--date, -d` | Target date (YYYY-MM-DD) - required |
| `--platforms, -p` | Comma-separated platform list (default: all) |
| `--verbose, -v` | Show detailed output |

### Use Case
When running `/sns-announce --dedupe`:
1. Extract article date from metadata
2. Call `check-scheduled.ts` to get `needed` platforms
3. Generate posts only for `needed` platforms (skip `scheduled`)

This saves AI tokens by not generating content that would be discarded.
