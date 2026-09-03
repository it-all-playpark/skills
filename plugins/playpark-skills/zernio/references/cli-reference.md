# Zernio CLI Reference

## post — Create or schedule SNS posts

```bash
# Text post
zernio post --text "投稿内容" --platforms x,linkedin --schedule "2026-03-20 09:00"

# Media post
zernio post --media video.mp4 --caption "Caption" --platforms instagram --media-type reel

# Batch from JSON (sns-announce / video-announce output)
zernio post --json posts.json [--dry-run]

# Immediate post (no --schedule)
zernio post --text "Now!" --platforms x --publish-now
```

| Option | Description |
|--------|-------------|
| `--text TEXT` | Text content |
| `--file PATH` | Text content from file |
| `--json PATH` | Batch posting from JSON file |
| `-p, --platforms LIST` | Platforms: x, linkedin, facebook, googlebusiness, threads, bluesky, instagram, youtube, tiktok, all |
| `-s, --schedule DATETIME` | Schedule time in JST (`YYYY-MM-DD HH:MM`) |
| `--publish-now` | Publish immediately (default when no --schedule) |
| `-m, --media PATH` | Media file path(s), comma-separated |
| `-c, --caption TEXT` | Caption for media post |
| `--media-type TYPE` | Instagram media type: feed, reel, story, carousel |
| `--thumbnail PATH` | Thumbnail image (Instagram/YouTube) |
| `--youtube-title TITLE` | YouTube video title |
| `--first-comment TEXT` | First comment text |
| `--dry-run` | Preview without posting |

## sync — Sync local JSON with Zernio API

```bash
# Dry-run (default)
zernio sync --dir ./post/blog --from 2026-04-01

# Execute changes
zernio sync --dir ./post/blog --from 2026-04-01 --execute

# Verbose
zernio sync --dir ./post/blog --from 2026-04-01 --verbose
```

| Option | Description |
|--------|-------------|
| `--dir DIR` | Directory containing JSON post files (required) |
| `--from DATE` | Start date filter `YYYY-MM-DD` (required) |
| `--execute` | Apply changes (default: dry-run) |
| `-v, --verbose` | Detailed output |
| `--dry-run` | Explicit dry-run |

## Other Commands

```bash
# List connected accounts
zernio list-accounts

# List posts
zernio list-posts [--status scheduled] [--from 2026-03-01] [--limit 50]

# Delete a post
zernio delete-post --id POST_ID
```

## Global Options

| Option | Description |
|--------|-------------|
| `--profile-id ID` | Profile ID (env: `ZERNIO_PROFILE_ID`) |
| `-o, --output FORMAT` | Output: json, table, compact |
| `-v, --verbose` | Verbose output |
| `--dry-run` | Skip API calls |
