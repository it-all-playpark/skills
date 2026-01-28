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

\`\`\`
/sns-announce <source> [options]
\`\`\`

### Options

| Option | Description | Default |
|--------|-------------|---------|
| \`--output, -o FILE\` | Output to file | config or stdout |
| \`--format FORMAT\` | md, json, yaml | config or md |
| \`--schedule DATETIME\` | Schedule time (enables Late API format) | config or none |
| \`--dedupe\` | Pre-check Late API and skip already scheduled platforms | false |
| \`--x\` | X only | all enabled |
| \`--linkedin\` | LinkedIn only | all enabled |
| \`--google\` | Google Business only | all enabled |
| \`--facebook\` | Facebook only | all enabled |
| \`--bluesky\` | Bluesky only | all enabled |
| \`--threads\` | Threads only | all enabled |
| \`--base-url URL\` | Base URL for links | config |
| \`--lang LANG\` | ja, en | config or ja |

**Priority**: CLI args > config file > defaults

## Configuration

Project config: \`.claude/sns-announce.json\`

\`\`\`json
{
  "base_url": "https://example.com",
  "url_pattern": "/blog/{slug}",
  "default_lang": "ja",
  "output": {
    "dir": "post/blog",
    "pattern": "{date}-{slug}.json",
    "format": "json"
  },
  "schedule": {
    "enabled": true,
    "mode": "auto"
  },
  "platforms": {
    "x": { "enabled": true },
    "linkedin": { "enabled": true },
    "google": { "enabled": true },
    "facebook": { "enabled": true },
    "bluesky": { "enabled": false },
    "threads": { "enabled": false }
  }
}
\`\`\`

### Schedule Config

| Key | Value | Description |
|-----|-------|-------------|
| \`enabled\` | true/false | Enable Late API format output |
| \`mode\` | "auto" | Auto-calculate optimal posting times per platform based on article date |

When \`schedule.enabled: true\`:
- Output format becomes Late API array format
- Each platform gets optimal posting time from \`references/posting-times.json\`
- Schedule date defaults to article's publish date

### Output Auto-Save

When \`output.dir\` and \`output.pattern\` are set:
1. Skip stdout, write directly to file
2. Pattern variables: \`{date}\`, \`{slug}\`, \`{category}\`
3. Returns only confirmation message (saves context)

When not set: stdout (traditional behavior)

## Workflow

### Standard (without --dedupe)
\`\`\`
1. Load config → 2. Extract metadata → 3. Generate posts (all platforms) → 4. Write output
\`\`\`

### Optimized (with --dedupe) ⚡
\`\`\`
1. Load config → 2. Extract metadata (get date) → 3. Query Late API → 4. Generate posts (needed only) → 5. Write output
\`\`\`

**Key optimization**: When \`--dedupe\` is specified, query Late API BEFORE generation to identify which platforms need posts. This avoids wasting AI tokens generating content for already-scheduled platforms.

### Dedupe Pre-Query Flow

Uses \`~/.claude/skills/sns-dedupe/scripts/check-scheduled.ts\`:

\`\`\`bash
# Step 1: Extract date from article metadata
DATE="2026-01-20"  # from frontmatter

# Step 2: Query Late API for scheduled platforms
npx tsx ~/.claude/skills/sns-dedupe/scripts/check-scheduled.ts --date $DATE --platforms x,linkedin,googlebusiness,facebook,bluesky,threads

# Output: { "date": "2026-01-20", "needed": ["x", "facebook"], "scheduled": ["linkedin", "googlebusiness", "bluesky", "threads"] }

# Step 3: Generate posts for "needed" platforms only
# (Skip linkedin, googlebusiness, bluesky, threads - already scheduled)
\`\`\`

Requires \`LATE_API_KEY\` in \`~/.claude/skills/sns-schedule-post/.env\`

## Scripts

\`\`\`bash
# Load config
~/.claude/skills/sns-announce/scripts/load-config.sh [project-root]

# Extract metadata (for file input)
~/.claude/skills/sns-announce/scripts/extract-metadata.sh <file> --base-url URL

# Get optimal posting time
~/.claude/skills/sns-announce/scripts/get-posting-time.sh <platform> [--date YYYY-MM-DD]

# Check scheduled platforms (for --dedupe optimization)
~/.claude/skills/sns-dedupe/scripts/check-scheduled.ts --date YYYY-MM-DD --platforms LIST
\`\`\`

## Platform Guidelines

See `references/platform-guide.md` for detailed limits, audience, style, and templates per platform.

**Quick reference**: X ~120字, LinkedIn 1,300, Google 1,500, Facebook 500推奨, Bluesky 300, Threads 500

## Output Format

### Markdown (default)
\`\`\`
📋 SNS告知テンプレート

━━━━━━━━━━━━━━━━━━━━
X（Twitter）用
━━━━━━━━━━━━━━━━━━━━
{post}

━━━━━━━━━━━━━━━━━━━━
LinkedIn用
━━━━━━━━━━━━━━━━━━━━
{post}
\`\`\`

### JSON

#### Standard (when schedule.enabled: false)
\`\`\`json
{"source": "...", "generated_at": "ISO8601", "posts": {"x": "...", "linkedin": "..."}}
\`\`\`

#### Late API format (when schedule.enabled: true or --schedule specified)
\`\`\`json
[
  {"content": "X用の投稿文 #hashtag", "schedule": "2026-03-12 12:00", "platforms": ["x"]},
  {"content": "LinkedIn用の投稿文", "schedule": "2026-03-12 08:30", "platforms": ["linkedin"]},
  {"content": "Google Business用の投稿文", "schedule": "2026-03-12 10:00", "platforms": ["googlebusiness"]},
  {"content": "Facebook用の投稿文", "schedule": "2026-03-12 09:00", "platforms": ["facebook"]},
  {"content": "Bluesky用の投稿文", "schedule": "2026-03-12 19:00", "platforms": ["bluesky"]},
  {"content": "Threads用の投稿文", "schedule": "2026-03-12 18:30", "platforms": ["threads"]}
]
\`\`\`

## Examples

\`\`\`bash
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

# Late API format with schedule
/sns-announce article.mdx --format json --schedule "2026-03-12 09:00"
\`\`\`
