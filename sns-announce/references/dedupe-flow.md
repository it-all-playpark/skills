# Dedupe Pre-Query Flow

Uses `$SKILLS_DIR/sns-dedupe/scripts/check-scheduled.ts`:

```bash
# Step 1: Extract date from article metadata
DATE="2026-01-20"  # from frontmatter

# Step 2: Query Zernio API for scheduled platforms
npx tsx $SKILLS_DIR/sns-dedupe/scripts/check-scheduled.ts --date $DATE --platforms x,linkedin,googlebusiness,facebook,bluesky,threads

# Output: { "date": "2026-01-20", "needed": ["x", "facebook"], "scheduled": ["linkedin", "googlebusiness", "bluesky", "threads"] }

# Step 3: Generate posts for "needed" platforms only
# (Skip linkedin, googlebusiness, bluesky, threads - already scheduled)
```

Requires `ZERNIO_API_KEY` environment variable (global).

## Scripts

```bash
# Load config
$SKILLS_DIR/sns-announce/scripts/load-config.sh [project-root]

# Extract metadata (for file input)
$SKILLS_DIR/sns-announce/scripts/extract-metadata.sh <file> --base-url URL

# Get optimal posting time
$SKILLS_DIR/sns-announce/scripts/get-posting-time.sh <platform> [--date YYYY-MM-DD]

# Check scheduled platforms (for --dedupe optimization)
$SKILLS_DIR/sns-dedupe/scripts/check-scheduled.ts --date YYYY-MM-DD --platforms LIST
```
