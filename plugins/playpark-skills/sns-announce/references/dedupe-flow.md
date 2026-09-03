# Dedupe Pre-Query Flow

Zernio API（`ZERNIO_API_KEY` 必須）に予約済みプラットフォームを事前照会し、未予約分だけ生成する。

```bash
# Step 1: Extract date from article metadata
DATE="2026-01-20"  # from frontmatter

# Step 2: Query Zernio API for scheduled platforms (returns JSON: {date, needed[], scheduled[]})

# Output: { "date": "2026-01-20", "needed": ["x", "facebook"], "scheduled": ["linkedin", "googlebusiness", "bluesky", "threads"] }

# Step 3: Generate posts for "needed" platforms only
# (Skip linkedin, googlebusiness, bluesky, threads - already scheduled)
```

Requires `ZERNIO_API_KEY` environment variable (global).

## Scripts

```bash
# Load config
sns-announce-load-config [project-root]

# Extract metadata (for file input)
sns-announce-extract-metadata <file> --base-url URL

# Get optimal posting time
sns-announce-get-posting-time <platform> [--date YYYY-MM-DD]
```
