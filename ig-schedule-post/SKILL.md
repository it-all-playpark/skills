---
name: ig-schedule-post
description: |
  Schedule or post to Instagram (feed, reel, story, carousel), YouTube Shorts, or TikTok with media upload via Late API.
  Use when: (1) user wants to schedule posts with images or videos to Instagram/YouTube/TikTok,
  (2) after /ig-announce to publish generated content,
  (3) keywords like "Instagram投稿", "IG予約投稿", "Instagram schedule", "ig post", "ig schedule", "YouTube投稿", "TikTok投稿",
  (4) needs to upload media and create posts via Late API.
  Accepts args: --json FILE | --media FILE --caption TEXT [--type feed|reel|story|carousel] [--schedule "YYYY-MM-DD HH:MM"] [--first-comment TEXT] [--dry-run]
---

# IG Schedule Post

Schedule or post to Instagram, YouTube, or TikTok via Late API with media upload support.

## Usage

```
# From JSON (ig-announce output)
/ig-schedule-post --json posts.json [--dry-run]

# Direct post (Instagram, backward compatible)
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
2. Connect Instagram, YouTube, and/or TikTok accounts
3. Get API key from dashboard

### 2. Environment Variables

Create `$SKILLS_DIR/ig-schedule-post/.env`:

```
LATE_API_KEY=your_api_key
```

Shares API key with `sns-schedule-post` skill. If `$SKILLS_DIR/ig-schedule-post/.env` does not exist, falls back to `$SKILLS_DIR/sns-schedule-post/.env`.

## JSON Input Format

### Platform Detection

The script reads `platforms[0].platform` from the JSON to determine the target platform:
- `"instagram"` → Instagram post
- `"youtube"` → YouTube Shorts post
- `"tiktok"` → TikTok post

### Instagram JSON

Compatible with ig-announce `--format json` output:

```json
{
  "content": "キャプション本文 #hashtag1 #hashtag2",
  "mediaItems": [
    {"type": "video", "path": "/path/to/video.mp4"}
  ],
  "platforms": [
    {
      "platform": "instagram",
      "platformSpecificData": {
        "contentType": "reels",
        "shareToFeed": true,
        "instagramThumbnail": "post/instagram/thumbnails/slug.jpg",
        "firstComment": "#追加タグ群"
      }
    }
  ],
  "schedule": "2026-03-12 19:00"
}
```

### YouTube JSON

```json
{
  "content": "動画の説明文\n\nチャンネル登録お願いします！\n\n#シフト管理 #業務効率化 #Shorts",
  "mediaItems": [
    {
      "type": "video",
      "path": "/path/to/video.mp4",
      "thumbnail": {
        "url": "post/youtube/thumbnails/slug.jpg"
      }
    }
  ],
  "platforms": [
    {
      "platform": "youtube",
      "platformSpecificData": {
        "title": "シフト管理が劇的に変わる！AIが自動で最適配置",
        "visibility": "public",
        "categoryId": "28",
        "madeForKids": false,
        "containsSyntheticMedia": false
      }
    }
  ],
  "firstComment": "ピン留めコメント（任意）",
  "schedule": "2026-03-12 19:30"
}
```

**YouTube-specific fields**:
- `content` = 動画の説明文（Description）
- `platformSpecificData.title` = 動画タイトル（max 100字）
- `platformSpecificData.visibility` = `"public"` | `"private"` | `"unlisted"`
- `platformSpecificData.categoryId` = YouTube カテゴリID（デフォルト: `"28"` = Science & Technology）
- `platformSpecificData.madeForKids` = 子供向けコンテンツか
- `platformSpecificData.containsSyntheticMedia` = AI生成メディアを含むか
- `mediaItems[].thumbnail.url` = サムネイル画像パス（JSON入力形式。スクリプトがアップロードし `platformSpecificData.thumbnail` としてAPIに送信）
- `firstComment` = ピン留めコメント（任意、max 10,000字。スクリプトが `platformSpecificData.firstComment` としてAPIに送信）

### TikTok JSON

```json
{
  "content": "フック文\n\n内容の要約\n\nCTA\n\n#hashtag1 #hashtag2 #hashtag3",
  "mediaItems": [
    {"type": "video", "path": "/path/to/video.mp4"}
  ],
  "platforms": [
    {
      "platform": "tiktok"
    }
  ],
  "tiktokSettings": {
    "privacy_level": "PUBLIC_TO_EVERYONE",
    "allow_comment": true,
    "allow_duet": true,
    "allow_stitch": true,
    "content_preview_confirmed": true,
    "express_consent_given": true,
    "video_cover_timestamp_ms": 2000,
    "video_made_with_ai": false
  },
  "schedule": "2026-03-12 20:00"
}
```

**TikTok-specific fields**:
- `content` = キャプション本文（ハッシュタグ含む、max 2,200字）
- `tiktokSettings` = **トップレベル**に配置（`platformSpecificData`内ではない）
  - `privacy_level`: `"PUBLIC_TO_EVERYONE"` | `"MUTUAL_FOLLOW_FRIENDS"` | `"FOLLOWER_OF_CREATOR"` | `"SELF_ONLY"`
  - `allow_comment`: コメント許可
  - `allow_duet`: デュエット許可
  - `allow_stitch`: スティッチ許可
  - `content_preview_confirmed`: 常に `true`（必須、スクリプトが強制設定）
  - `express_consent_given`: 常に `true`（必須、スクリプトが強制設定）
  - `video_cover_timestamp_ms`: カバー画像のフレーム位置（ミリ秒）
  - `video_made_with_ai`: AI生成動画か

## Implementation

Execute the script at `scripts/post.ts`:

```bash
# Instagram
npx tsx $SKILLS_DIR/ig-schedule-post/scripts/post.ts --json post/instagram/2026-03-12-slug.json

# YouTube
npx tsx $SKILLS_DIR/ig-schedule-post/scripts/post.ts --json post/youtube/2026-03-12-slug.json

# TikTok
npx tsx $SKILLS_DIR/ig-schedule-post/scripts/post.ts --json post/tiktok/2026-03-12-slug.json

# Direct post (Instagram only, backward compatible)
npx tsx $SKILLS_DIR/ig-schedule-post/scripts/post.ts --media video.mp4 --caption "text" [--type reel]
```

DO NOT manually call the Late API. Always use the provided script.

### Script Workflow

```
1. Load .env (LATE_API_KEY)
2. Parse input (JSON or CLI args)
3. Detect target platform from JSON platforms[0].platform
4. For each media item:
   a. Get presigned URL: POST /v1/media/presign
   b. Upload file: PUT to uploadUrl
   c. Store publicUrl
5. Handle thumbnails per platform:
   - Instagram: upload instagramThumbnail → attach to mediaItems[].instagramThumbnail
   - YouTube: extract mediaItems[].thumbnail.url → upload → set platformSpecificData.thumbnail (URL string)
   - TikTok: no upload (uses video_cover_timestamp_ms)
6. Create post: POST /v1/posts
   - Attach media publicUrls
   - Set platform-specific data
   - TikTok: add tiktokSettings to request body top-level
   - Set schedule or publishNow
7. Report result
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

### Instagram

| Type | Media | Max Size | Duration |
|------|-------|----------|----------|
| Feed (image) | JPEG/PNG | 8 MB | N/A |
| Feed (video) | MP4/MOV | 300 MB | Max 60 min |
| Reel | MP4/MOV, 9:16 | 300 MB | 3-90 sec |
| Story | JPEG/PNG/MP4 | 100 MB | Max 60 sec |
| Carousel | Up to 10 items | 8 MB img / 300 MB vid | N/A |

### YouTube Shorts

| Type | Media | Max Size | Duration |
|------|-------|----------|----------|
| Short | MP4/MOV/WebM, 9:16 | 2 GB | Max 60 sec |

### TikTok

| Type | Media | Max Size | Duration |
|------|-------|----------|----------|
| Video | MP4/MOV/WebM, 9:16 | 4 GB | 3 sec - 10 min |

## Examples

```bash
# ig-announce連携（推奨フロー）
/ig-announce packages/video/out/promo-video.mp4 --format json
# → post/instagram/2026-03-12-promo-video.json
# → post/youtube/2026-03-12-promo-video.json
# → post/tiktok/2026-03-12-promo-video.json

# 各プラットフォームに投稿
/ig-schedule-post --json post/instagram/2026-03-12-promo-video.json
/ig-schedule-post --json post/youtube/2026-03-12-promo-video.json
/ig-schedule-post --json post/tiktok/2026-03-12-promo-video.json

# ドライラン（全プラットフォーム）
/ig-schedule-post --json post/instagram/2026-03-12-promo-video.json --dry-run
/ig-schedule-post --json post/youtube/2026-03-12-promo-video.json --dry-run
/ig-schedule-post --json post/tiktok/2026-03-12-promo-video.json --dry-run

# 動画リール投稿（Instagram直接、後方互換）
/ig-schedule-post --media packages/video/out/promo-video.mp4 --caption "シフト管理を変える" --type reel --schedule "2026-03-12 19:00"

# 画像フィード投稿
/ig-schedule-post --media photo.jpg --caption "新機能リリース！" --first-comment "#ShiftBud #DX #シフト管理"

# カルーセル
/ig-schedule-post --media img1.jpg,img2.jpg,img3.jpg --caption "Tips5選" --type carousel
```

## Notes

- Schedule time: JST (Asia/Tokyo)
- Instagram requires media for all post types (text-only posts not supported)
- Story captions are not displayed
- Unpublish not supported for Instagram posts
- 100 posts per 24-hour rolling window limit (Instagram)
- YouTube: Title max 100 chars, Description max 5,000 chars
- TikTok: Caption max 2,200 chars (hashtags included)
- TikTok `content_preview_confirmed` and `express_consent_given` are automatically forced to `true`
- CLI mode (`--media --caption`) defaults to Instagram (backward compatible)
