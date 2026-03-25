---
name: zernio
description: |
  Zernio CLI wrapper for SNS scheduling and sync.
  Use when: (1) scheduling or posting to SNS platforms (X, LinkedIn, Facebook, Google Business, Threads, Bluesky, Instagram, YouTube, TikTok),
  (2) syncing local JSON files with Zernio API,
  (3) after /sns-announce or /video-announce to schedule generated posts,
  (4) keywords: "SNS投稿", "予約投稿", "schedule post", "Zernio同期", "sync Zernio", "SNS同期".
  Accepts args: post|sync [OPTIONS]
user-invocable: true
argument-hint: post|sync [OPTIONS]
---

# Zernio

Zernio CLI wrapper for SNS scheduling and sync.

## Usage

```
/zernio post [OPTIONS]
/zernio sync [OPTIONS]
```

## Sub-commands

### post — Create or schedule SNS posts

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

### sync — Sync local JSON with Zernio API

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

## Global Options

| Option | Description |
|--------|-------------|
| `--profile-id ID` | Profile ID (env: `ZERNIO_PROFILE_ID`) |
| `-o, --output FORMAT` | Output: json, table, compact |
| `-v, --verbose` | Verbose output |
| `--dry-run` | Skip API calls |

## Other Commands

```bash
# List connected accounts
zernio list-accounts

# List posts
zernio list-posts [--status scheduled] [--from 2026-03-01] [--limit 50]

# Delete a post
zernio delete-post --id POST_ID
```

## Environment

- `ZERNIO_API_KEY` — API key (global)
- `ZERNIO_PROFILE_ID` — Profile ID (optional, for project isolation)

## Profile ID Resolution

**CRITICAL**: Always resolve `--profile-id` before running any `zernio` command.

Resolution order:
1. User explicitly passes `--profile-id` → use as-is
2. Read `.claude/skill-config.json` → `zernio.profile_id` → pass as `--profile-id`
3. `ZERNIO_PROFILE_ID` env var → used automatically by CLI
4. None found → **WARN the user** that commands will affect ALL profiles

To read from skill-config.json:
```bash
PROFILE_ID=$(python3 -c "import json; print(json.load(open('.claude/skill-config.json')).get('zernio',{}).get('profile_id',''))" 2>/dev/null)
```

Then append `--profile-id $PROFILE_ID` to every `zernio` command if non-empty.

## Execution

This skill calls `zernio` CLI directly. Do NOT use the old TypeScript scripts.

### Pipeline Example

```bash
# Generate posts → schedule
/sns-announce content/blog/2026-03-20-article.mdx --format json
zernio post --json post/2026-03-20-article.json

# Generate video posts → schedule
/video-announce video.mp4 --format json
zernio post --json post/2026-03-20-video.json

# Sync after date changes
zernio sync --dir ./post/blog --from 2026-03-20 --execute
```

## Platform Aliases

| Input | Platform |
|-------|----------|
| x, twitter | X (Twitter) |
| linkedin | LinkedIn |
| facebook, fb | Facebook |
| googlebusiness, google, gbp | Google Business Profile |
| threads | Threads |
| bluesky, bsky | Bluesky |
| instagram | Instagram |
| youtube | YouTube |
| tiktok | TikTok |
| all | All connected platforms |
