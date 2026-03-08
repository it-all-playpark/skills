---
name: late-schedule-post
description: |
  Schedule or post to all supported SNS platforms (X, LinkedIn, Facebook, Google Business, Threads, Bluesky, Instagram, YouTube, TikTok) via Late API.
  Use when: (1) user wants to schedule SNS posts (text or media),
  (2) after /sns-announce or /video-announce to schedule generated posts,
  (3) keywords like "SNS投稿", "予約投稿", "schedule post", "Instagram投稿", "YouTube投稿", "TikTok投稿".
  Accepts args: TEXT or FILE [--schedule "YYYY-MM-DD HH:MM"] [--platforms PLATFORMS] [--dry-run]
user-invocable: true
argument-hint: --json FILE [--dry-run] | TEXT [--schedule "YYYY-MM-DD HH:MM"] [--platforms PLATFORMS]
---

# Late Schedule Post

Schedule or post to all supported SNS platforms via Late API (getlate.dev).
Unified skill replacing `sns-schedule-post` (text) and `video-schedule-post` (media).

## Usage

```
# Text post (single)
/late-schedule-post "投稿内容" --schedule "2026-01-20 09:00" --platforms x,linkedin

# Text batch (sns-announce output)
/late-schedule-post --json posts.json

# Media batch (video-announce output)
/late-schedule-post --json video-posts.json

# Media direct
/late-schedule-post --media video.mp4 --caption "Caption" --type reel --schedule "2026-03-12 19:00"

# Dry run
/late-schedule-post --json posts.json --dry-run
```

| Argument | Description |
|----------|-------------|
| TEXT or FILE | Post content (quoted text or file path) |
| `--json, -j` | JSON file with post(s) — supports both text and media formats |
| `--schedule, -s` | Schedule time in JST (omit for immediate post) |
| `--platforms, -p` | Platforms: x, linkedin, facebook, googlebusiness, threads, bluesky, all (default: all) |
| `--media, -m` | Media file path(s), comma-separated for carousel |
| `--caption, -c` | Caption text for media posts |
| `--type, -t` | Content type: feed, reel, story, carousel (auto-detect) |
| `--first-comment` | Auto-post as first comment |
| `--thumbnail` | Custom thumbnail for Reels |
| `--dry-run, -n` | Preview without posting |

## Setup

### 1. Late Account

1. Sign up at https://getlate.dev
2. **Connect ALL accounts (X, LinkedIn, Facebook, Google Business, Threads, Bluesky, Instagram, YouTube, TikTok) to the same profile**
3. Get API key from dashboard
4. Get profile ID: `GET /v1/profiles`

### 2. Environment Variables

Create `$SKILLS_DIR/late-schedule-post/.env`:

```
LATE_API_KEY=your_api_key
```

Falls back to `$SKILLS_DIR/sns-schedule-post/.env` if not found.

### 3. skill-config.json (Required)

```json
{
  "late-schedule-post": {
    "profile_id": "your_late_profile_id",
    "timezone": "Asia/Tokyo"
  }
}
```

`profile_id` is **required** to isolate posts per project. Ensure all platform accounts are linked to this profile in the Late dashboard.

## JSON Input Formats

### Text Posts (sns-announce output)

```json
[
  {
    "content": "X用投稿 #hashtag",
    "schedule": "2026-03-12 09:00",
    "platforms": ["x"]
  },
  {
    "content": "全プラットフォーム投稿",
    "schedule": "2026-03-12 10:00",
    "platforms": "all"
  }
]
```

### Media Posts (video-announce output)

```json
[
  {
    "content": "Instagram caption #hashtag",
    "mediaItems": [{"type": "video", "path": "/path/to/video.mp4"}],
    "platforms": [{"platform": "instagram", "platformSpecificData": {"contentType": "reels"}}],
    "schedule": "2026-03-12 19:00"
  }
]
```

### Mixed Batch (text + media in same array)

Both formats can be mixed in the same JSON array. The script auto-detects based on `mediaItems` field.

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
| all | All text platforms |

## Implementation

Execute the script at `scripts/post.ts`:

```bash
npx tsx $SKILLS_DIR/late-schedule-post/scripts/post.ts --json <file> [--dry-run]
```

DO NOT manually call the Late API. Always use the provided script.

## Notes

- Schedule time: JST (Asia/Tokyo)
- Instagram requires media for all post types
- YouTube: Title max 100 chars
- TikTok: Caption max 2,200 chars
- `content_preview_confirmed` and `express_consent_given` are automatically forced to `true` for TikTok
- CLI mode (`--media --caption`) defaults to Instagram
