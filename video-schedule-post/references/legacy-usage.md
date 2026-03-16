# Video Schedule Post - Legacy Usage Reference

> This document preserves the full legacy documentation for `video-schedule-post`.
> The skill is **DEPRECATED** — use `/late-schedule-post` instead.

## Usage

```
# From JSON (video-announce output)
/video-schedule-post --json posts.json [--dry-run]

# Direct post (Instagram, backward compatible)
/video-schedule-post --media FILE --caption TEXT [--type TYPE] [--schedule DATETIME] [--dry-run]
```

| Argument | Description |
|----------|-------------|
| `--json, -j` | JSON file with post data (video-announce output format) |
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

Create `$SKILLS_DIR/video-schedule-post/.env`:

```
LATE_API_KEY=your_api_key
```

Shares API key with `sns-schedule-post` skill. If `$SKILLS_DIR/video-schedule-post/.env` does not exist, falls back to `$SKILLS_DIR/sns-schedule-post/.env`.

## JSON Input Format

### Array Format (Recommended)

video-announce が出力する配列形式JSONを直接受け付ける。各要素は `platforms[0].platform` でプラットフォームが決定される。

```json
[
  {
    "content": "キャプション本文 #hashtag1",
    "mediaItems": [{"type": "video", "path": "/path/to/video.mp4"}],
    "platforms": [{"platform": "instagram", "platformSpecificData": {"contentType": "reels", "instagramThumbnail": "post/thumbnails/instagram/slug.jpg", "firstComment": "#タグ群"}}],
    "schedule": "2026-03-12 19:00"
  },
  {
    "content": "YouTube説明文\n\n#シフト管理 #Shorts",
    "mediaItems": [{"type": "video", "path": "/path/to/video.mp4", "thumbnail": {"url": "post/thumbnails/youtube/slug.jpg"}}],
    "platforms": [{"platform": "youtube", "platformSpecificData": {"title": "タイトル", "visibility": "public", "categoryId": "28", "madeForKids": false}}],
    "schedule": "2026-03-12 19:30"
  },
  {
    "content": "TikTokキャプション\n\n#hashtag1 #hashtag2",
    "mediaItems": [{"type": "video", "path": "/path/to/video.mp4"}],
    "platforms": [{"platform": "tiktok"}],
    "tiktokSettings": {"privacy_level": "PUBLIC_TO_EVERYONE", "allow_comment": true, "allow_duet": true, "allow_stitch": true, "video_cover_timestamp_ms": 2000},
    "schedule": "2026-03-12 20:00"
  }
]
```

**後方互換**: 単一オブジェクトJSONもそのまま受け付ける（内部で `[object]` にラップして処理）。

### Platform Detection

各エントリの `platforms[0].platform` でプラットフォームを決定:
- `"instagram"` → Instagram post
- `"youtube"` → YouTube Shorts post
- `"tiktok"` → TikTok post

### Platform-specific Fields

**YouTube**:
- `content` = 動画の説明文（Description）
- `platformSpecificData.title` = 動画タイトル（max 100字）
- `platformSpecificData.visibility` = `"public"` | `"private"` | `"unlisted"`
- `platformSpecificData.categoryId` = YouTube カテゴリID（デフォルト: `"28"` = Science & Technology）
- `mediaItems[].thumbnail.url` = サムネイル画像パス（スクリプトがアップロードし `platformSpecificData.thumbnail` としてAPIに送信）
- `firstComment` = ピン留めコメント（任意、スクリプトが `platformSpecificData.firstComment` としてAPIに送信）

**TikTok**:
- `content` = キャプション本文（ハッシュタグ含む、max 2,200字）
- `tiktokSettings` = **トップレベル**に配置（`platformSpecificData`内ではない）
  - `privacy_level`: `"PUBLIC_TO_EVERYONE"` | `"MUTUAL_FOLLOW_FRIENDS"` | `"FOLLOWER_OF_CREATOR"` | `"SELF_ONLY"`
  - `content_preview_confirmed` / `express_consent_given`: 常に `true`（スクリプトが強制設定）
  - `video_cover_timestamp_ms`: カバー画像のフレーム位置（ミリ秒）

## Implementation

Execute the script at `scripts/post.ts`:

```bash
# 配列JSON（全プラットフォーム一括処理）
npx tsx $SKILLS_DIR/video-schedule-post/scripts/post.ts --json post/2026-03-12-slug.json

# Direct post (Instagram only, backward compatible)
npx tsx $SKILLS_DIR/video-schedule-post/scripts/post.ts --media video.mp4 --caption "text" [--type reel]
```

DO NOT manually call the Late API. Always use the provided script.

### Script Workflow

```
1. Load .env (LATE_API_KEY)
2. Parse input (JSON or CLI args)
3. If JSON is array → batch mode (loop each entry)
   If JSON is single object → wrap in [object] (backward compatible)
4. For each entry:
   a. Detect target platform from platforms[0].platform
   b. For each media item:
      - Get presigned URL: POST /v1/media/presign
      - Upload file: PUT to uploadUrl
      - Store publicUrl
   c. Handle thumbnails per platform:
      - Instagram: upload instagramThumbnail → attach to mediaItems[].instagramThumbnail
      - YouTube: extract mediaItems[].thumbnail.url → upload → set platformSpecificData.thumbnail
      - TikTok: no upload (uses video_cover_timestamp_ms)
   d. Create post: POST /v1/posts
   e. Track success/failed (errors skip to next entry)
5. Print summary (Success: N / Failed: N)
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
# video-announce連携（推奨フロー）
/video-announce packages/video/out/promo-video.mp4 --format json
# → post/2026-03-12-promo-video.json (配列: [instagram, youtube, tiktok])

# 全プラットフォーム一括投稿
/video-schedule-post --json post/2026-03-12-promo-video.json

# ドライラン（全プラットフォーム）
/video-schedule-post --json post/2026-03-12-promo-video.json --dry-run

# 動画リール投稿（Instagram直接、後方互換）
/video-schedule-post --media packages/video/out/promo-video.mp4 --caption "シフト管理を変える" --type reel --schedule "2026-03-12 19:00"

# 画像フィード投稿
/video-schedule-post --media photo.jpg --caption "新機能リリース！" --first-comment "#ShiftBud #DX #シフト管理"

# カルーセル
/video-schedule-post --media img1.jpg,img2.jpg,img3.jpg --caption "Tips5選" --type carousel
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
