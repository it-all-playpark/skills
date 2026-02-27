---
name: ig-schedule-post
description: |
  Schedule or post to Instagram (feed, reel, story, carousel) with media upload via Late API.
  Use when: (1) user wants to schedule Instagram posts with images or videos,
  (2) after /ig-announce to publish generated content,
  (3) keywords like "Instagram投稿", "IG予約投稿", "Instagram schedule", "ig post", "ig schedule",
  (4) needs to upload media and create Instagram posts via Late API.
  Accepts args: --json FILE | --media FILE --caption TEXT [--type feed|reel|story|carousel] [--schedule "YYYY-MM-DD HH:MM"] [--first-comment TEXT] [--dry-run]
---

# IG Schedule Post

Schedule or post to Instagram via Late API with media upload support.

## Usage

```
# From JSON (ig-announce output)
/ig-schedule-post --json posts.json [--dry-run]

# Direct post
/ig-schedule-post --media FILE --caption TEXT [--type TYPE] [--schedule DATETIME] [--dry-run]
```

| Argument | Description |
|----------|-------------|
| `--json, -j` | JSON file with post data (ig-announce output format) |
| `--media, -m` | Media file path(s), comma-separated for carousel |
| `--caption, -c` | Caption text or file path |
| `--type, -t` | Content type: feed, reel, story, carousel (auto-detect) |
| `--schedule, -s` | Schedule time in JST (omit for immediate post) |
| `--first-comment` | Auto-post as first comment (hashtags, etc.) |
| `--thumbnail` | Custom thumbnail URL for Reels |
| `--dry-run, -n` | Preview without posting |

## Setup

### 1. Late Account

1. Sign up at https://getlate.dev
2. Connect Instagram account (requires Facebook Business Page)
3. Get API key from dashboard

### 2. Environment Variables

Create `$SKILLS_DIR/ig-schedule-post/.env`:

```
LATE_API_KEY=your_api_key
```

Shares API key with `sns-schedule-post` skill. If `$SKILLS_DIR/ig-schedule-post/.env` does not exist, falls back to `$SKILLS_DIR/sns-schedule-post/.env`.

## JSON Input Format

Compatible with ig-announce `--format json` output:

```json
{
  "content": "キャプション本文 #hashtag1 #hashtag2",
  "mediaItems": [
    {"type": "video", "path": "/path/to/video.mp4"},
    {"type": "image", "path": "/path/to/image.jpg"}
  ],
  "platforms": [
    {
      "platform": "instagram",
      "platformSpecificData": {
        "contentType": "reels",
        "shareToFeed": true,
        "firstComment": "#追加タグ群"
      }
    }
  ],
  "schedule": "2026-03-12 19:00"
}
```

## Implementation

Execute the script at `scripts/post.ts`:

```bash
npx tsx $SKILLS_DIR/ig-schedule-post/scripts/post.ts --json <file>
npx tsx $SKILLS_DIR/ig-schedule-post/scripts/post.ts --media <file> --caption "text" [--type reel] [--schedule "2026-03-12 19:00"]
```

DO NOT manually call the Late API. Always use the provided script.

### Script Workflow

```
1. Load .env (LATE_API_KEY)
2. Parse input (JSON or CLI args)
3. For each media item:
   a. Get presigned URL: GET /v1/media/get-media-presigned-url
   b. Upload file: PUT to uploadUrl
   c. Store publicUrl
4. Create post: POST /v1/posts/create-post
   - Attach media publicUrls
   - Set platform-specific data (contentType, firstComment, etc.)
   - Set schedule or publishNow
5. Report result
```

## Content Type Detection

| Media | Aspect | Duration | Type |
|-------|--------|----------|------|
| Video (9:16) | Portrait | <= 90s | reel |
| Video (other) | Any | Any | feed |
| Single image | Any | N/A | feed |
| Multiple files | Any | N/A | carousel |
| `--type` flag | Override | Override | (specified) |

## Platform Constraints

| Type | Media | Max Size | Duration |
|------|-------|----------|----------|
| Feed (image) | JPEG/PNG | 8 MB | N/A |
| Feed (video) | MP4/MOV | 300 MB | Max 60 min |
| Reel | MP4/MOV, 9:16 | 300 MB | 3-90 sec |
| Story | JPEG/PNG/MP4 | 100 MB | Max 60 sec |
| Carousel | Up to 10 items | 8 MB img / 300 MB vid | N/A |

## Examples

```bash
# ig-announce連携（推奨フロー）
/ig-announce packages/video/out/promo-video.mp4 --format json --output post.json
/ig-schedule-post --json post.json

# 動画リール投稿
/ig-schedule-post --media packages/video/out/promo-video.mp4 --caption "シフト管理を変える" --type reel --schedule "2026-03-12 19:00"

# 画像フィード投稿
/ig-schedule-post --media photo.jpg --caption "新機能リリース！" --first-comment "#ShiftBud #DX #シフト管理"

# カルーセル
/ig-schedule-post --media img1.jpg,img2.jpg,img3.jpg --caption "Tips5選" --type carousel

# ドライラン
/ig-schedule-post --json post.json --dry-run
```

## Notes

- Schedule time: JST (Asia/Tokyo)
- Instagram requires media for all post types (text-only posts not supported)
- Story captions are not displayed
- Unpublish not supported for Instagram posts
- 100 posts per 24-hour rolling window limit
