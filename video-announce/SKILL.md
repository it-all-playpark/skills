---
name: video-announce
description: |
  Generate video/image post captions with SEO-optimized hashtags for Instagram, YouTube Shorts, and TikTok.
  Use when: (1) user wants to create social media post content for video platforms,
  (2) needs captions and hashtags for Instagram feed/reel, YouTube Shorts, or TikTok,
  (3) keywords like "Instagram投稿文", "IG投稿", "キャプション作成", "Instagram caption", "ig announce", "video announce", "YouTube Shorts", "TikTok投稿",
  (4) input: video/image files, MDX/Markdown articles, URLs, or topic text.
  Accepts args: SOURCE [--type feed|reel|story|carousel] [--platforms instagram,youtube,tiktok|all-video] [--output FILE] [--format md|json] [--schedule "YYYY-MM-DD HH:MM"] [--lang ja|en]
---

# Video Announce

Generate platform-optimized captions with SEO hashtags for Instagram, YouTube Shorts, and TikTok from media files, articles, or topics.

## Usage

```
/video-announce <source> [options]
```

### Source Types

| Source | Example |
|--------|---------|
| Video file | `packages/video/out/promo-video.mp4` |
| Image file | `/path/to/image.jpg` |
| MDX/Markdown | `content/blog/2026-01-15-article.mdx` |
| URL | `https://example.com/blog/my-article` |
| Topic text | `"シフト管理の効率化テクニック"` |

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--type, -t TYPE` | Content type: feed, reel, story, carousel | Auto-detect from media |
| `--platforms, -p PLATFORMS` | Target platforms: `instagram`, `youtube`, `tiktok`, `all-video` (comma-separated) | `all-video` |
| `--output, -o FILE` | Output to file | config or stdout |
| `--format FORMAT` | md, json | config or md |
| `--schedule DATETIME` | Schedule time (enables Late API format) | none |
| `--lang LANG` | ja, en | config or ja |
| `--media PATHS` | Additional media file paths (comma-separated) | none |

### Platform Selection

| Value | Platforms |
|-------|-----------|
| `all-video` | Instagram + YouTube Shorts + TikTok (default) |
| `instagram` | Instagram only |
| `youtube` | YouTube Shorts only |
| `tiktok` | TikTok only |
| `instagram,youtube` | Instagram + YouTube Shorts |
| `instagram,tiktok` | Instagram + TikTok |

## Configuration

Project config: `.claude/video-announce.json`

```json
{
  "default_lang": "ja",
  "output": {
    "dir": "post",
    "pattern": "{platform}/{date}-{slug}.json",
    "format": "json"
  },
  "platforms": {
    "instagram": {
      "enabled": true,
      "hashtag": { "max_count": 30, "target_count": 20, "strategy": "first_comment" }
    },
    "youtube": {
      "enabled": true,
      "hashtag": { "max_count": 5, "always_include": ["Shorts"], "strategy": "description" },
      "defaults": { "visibility": "public", "categoryId": "28", "madeForKids": false }
    },
    "tiktok": {
      "enabled": true,
      "hashtag": { "max_count": 5, "strategy": "caption" },
      "defaults": { "privacy_level": "PUBLIC_TO_EVERYONE", "allow_comment": true, "allow_duet": true, "allow_stitch": true, "video_cover_timestamp_ms": 2000 }
    }
  },
  "brand": { "always_tags": ["ShiftBud", "playpark"] },
  "platformDefaults": { "thumbOffset": 2000 },
  "schedule": { "enabled": true, "mode": "auto" }
}
```

### output.pattern variables

| Variable | Description |
|----------|-------------|
| `{platform}` | Target platform: `instagram`, `youtube`, `tiktok` |
| `{date}` | **Schedule date** (投稿日, YYYY-MM-DD). `--schedule` 指定時はその日付、省略時は当日 |
| `{slug}` | Source filename or topic slug |

**重要**: `{date}` はファイル生成日ではなく、投稿予定日（schedule日）を使用する。sns-announceと同じ規約。

### platformDefaults.thumbOffset

動画メディアのサムネイル用フレーム切り出し位置（ミリ秒）。設定すると:
1. JSON出力時、ffmpegで動画の指定位置からJPEGフレームを `{output.dir}/{platform}/thumbnails/{slug}.jpg` に自動生成
2. **Instagram**: `platformSpecificData.instagramThumbnail` にサムネパスを設定 → `video-schedule-post` がアップロード
3. **YouTube**: `mediaItems[].thumbnail.url` にサムネパスを設定 → 投稿スクリプトがアップロードし `platformSpecificData.thumbnail` としてAPIに送信
4. **TikTok**: `tiktokSettings.video_cover_timestamp_ms` にミリ秒を設定（フレーム指定のみ、サムネアップロード不要）

## Workflow

```
1. Load config (.claude/video-announce.json)
2. Determine target platforms (--platforms or config)
3. Identify source type (media/article/topic)
4. Extract context:
   - Media → infer content from filename, path, video metadata
   - Article → extract title, description, key points from frontmatter/body
   - URL → fetch and parse article content
   - Topic → use as-is
5. Detect content type (feed/reel/story/carousel)
6. For each target platform:
   a. Generate platform-specific caption (see Caption Structure below)
   b. Generate platform-specific hashtags (see references/)
   c. Write output JSON to: {output.dir}/{platform}/{date}-{slug}.json
      ({date} = schedule date, not generation date)
7. Thumbnail generation (if platformDefaults.thumbOffset is set and media is video):
   - Extract frame at thumbOffset ms using ffmpeg:
     ffmpeg -y -ss <seconds> -i <video> -frames:v 1 -q:v 2 -update 1 <output>.jpg
   - Instagram: set `platformSpecificData.instagramThumbnail`
   - YouTube: set `mediaItems[].thumbnail.url` to local path (post script uploads → platformSpecificData.thumbnail)
   - TikTok: set `tiktokSettings.video_cover_timestamp_ms` (no thumbnail file needed)
```

### Reference Files

- **Instagram guide**: [references/instagram-guide.md](references/instagram-guide.md)
- **YouTube Shorts guide**: [references/youtube-shorts-guide.md](references/youtube-shorts-guide.md)
- **TikTok guide**: [references/tiktok-guide.md](references/tiktok-guide.md)
- **Hashtag strategy (cross-platform)**: [references/short-video-hashtags.md](references/short-video-hashtags.md)
- **Posting times**: [references/posting-times.json](references/posting-times.json)

### Auto-Detect Content Type

| Condition | Detected Type |
|-----------|---------------|
| Video, 9:16 aspect, <= 90s | reel |
| Video, other aspect or > 90s | feed (video) |
| Single image | feed (image) |
| Multiple images/videos (--media) | carousel |
| No media (topic/article only) | feed (placeholder) |

## Caption Structure

### Instagram: Feed/Carousel (Japanese)

```
{フック文（最初の125文字が重要 - "もっと見る"前に表示される部分）}

{本文 - 価値提供・ストーリー・解説}

{CTA（行動喚起）}

・
・
・

{ハッシュタグ群（15-30個）}
```

### Instagram: Reel (Japanese)

```
{フック文 - 短く強いインパクト}

{内容の要約（2-3行）}

{CTA}

{ハッシュタグ群（15-20個）}
```

### Instagram: Story

Caption not displayed on Stories. Generate hashtag sticker suggestions (5-10 tags) only.

### YouTube Shorts

```
Title (max 100字): {インパクトのあるタイトル - 主要キーワードを前方に}

Description:
{動画の説明 2-3行}

{CTA - チャンネル登録促進}

{ハッシュタグ 3-5個} #Shorts
```

**YouTube Title Rules**:
- Max 100 characters
- Front-load primary keyword
- No hashtags in title
- Numbers attract clicks ("3 Tips", "5 Ways")

### TikTok

```
{フック文 - 最初の1行で注意を引く}

{内容の要約 1-2行}

{CTA}

{ハッシュタグ 3-5個 インライン}
```

**TikTok Caption Rules**:
- Max 2,200 characters (hashtags included)
- Hook in first line
- 3-5 hashtags max (fewer = better reach)
- Inline hashtags (not separated)

## Output Format

### JSON (Late API format) - Per Platform

Each platform outputs a separate JSON file to `{output.dir}/{platform}/{date}-{slug}.json`.

#### Instagram JSON: `post/instagram/{date}-{slug}.json`

```json
{
  "content": "キャプション本文",
  "mediaItems": [
    {"type": "video", "path": "/path/to/video.mp4"}
  ],
  "platforms": [
    {
      "platform": "instagram",
      "platformSpecificData": {
        "contentType": "reels",
        "instagramThumbnail": "post/instagram/thumbnails/{slug}.jpg",
        "firstComment": "#追加ハッシュタグ群"
      }
    }
  ],
  "schedule": "2026-03-12 19:00"
}
```

#### YouTube JSON: `post/youtube/{date}-{slug}.json`

```json
{
  "content": "動画の説明文（Description）\n\nチャンネル登録お願いします！\n\n#シフト管理 #業務効率化 #Shorts",
  "mediaItems": [
    {
      "type": "video",
      "path": "/path/to/video.mp4",
      "thumbnail": {
        "url": "post/youtube/thumbnails/{slug}.jpg"
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

**YouTube JSON Notes**:
- `content` = 動画の説明文（Description）
- `platformSpecificData.title` = 動画タイトル（max 100字）
- `mediaItems[].thumbnail.url` = サムネイル画像パス（JSON入力形式。投稿スクリプトがアップロードし `platformSpecificData.thumbnail` としてLate APIに送信）
- `firstComment` = ピン留めコメント（任意）

#### TikTok JSON: `post/tiktok/{date}-{slug}.json`

```json
{
  "content": "シフト管理、まだ手作業でやってない？\n\nAIが自動で最適なシフトを作成！\n店長の負担が劇的に減ります\n\nプロフィールのリンクから無料で試せるよ\n\n#シフト管理 #飲食店 #業務効率化 #ShiftBud",
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

**TikTok JSON Notes**:
- `content` = キャプション本文（ハッシュタグ込み）
- `tiktokSettings` = トップレベルに配置（`platformSpecificData`内ではない）
- `content_preview_confirmed` / `express_consent_given` は常に `true`（必須）
- `video_cover_timestamp_ms` = カバー画像のフレーム位置（ミリ秒）

### Markdown (default)

```
## 投稿テンプレート

**プラットフォーム**: instagram, youtube, tiktok
**タイプ**: reel
**メディア**: /path/to/media.mp4

---

### Instagram

#### キャプション
{caption}

#### ハッシュタグ（{count}個）
{hashtags}

#### ファーストコメント（推奨）
{first_comment_hashtags}

---

### YouTube Shorts

#### タイトル（{length}/100字）
{title}

#### 説明
{description}

{hashtags} #Shorts

---

### TikTok

#### キャプション
{caption with inline hashtags}
```

## Backward Compatibility

- `--platforms` 省略時 → `all-video`（IG + YT + TikTok 全部生成）
- `--platforms instagram` → Instagram単体（従来の動作を明示指定で再現）
- config に `platforms` キーなし → 全プラットフォームにフォールバック
- 旧形式の config（`hashtag` がトップレベル）→ Instagram設定として解釈

## Examples

```bash
# リール動画から全プラットフォーム投稿文を生成（デフォルト: all-video）
/video-announce packages/video/out/promo-video.mp4

# Instagram単体（従来互換）
/video-announce packages/video/out/promo-video.mp4 --platforms instagram

# YouTube Shorts + TikTok のみ
/video-announce packages/video/out/promo-video.mp4 --platforms youtube,tiktok

# ブログ記事からフィード投稿文を生成
/video-announce content/blog/2026-01-15-shift-management.mdx --type feed

# トピックから投稿文を生成
/video-announce "AIを活用したシフト管理の未来" --type feed

# カルーセル（Instagram + YouTube のみ）
/video-announce "シフト管理Tips5選" --type carousel --media img1.jpg,img2.jpg,img3.jpg --platforms instagram

# JSON出力 + スケジュール（全プラットフォーム）
/video-announce packages/video/out/guide-setup.mp4 --format json --schedule "2026-03-12 19:00"

# 投稿パイプライン
/video-announce video.mp4 --format json
# → post/instagram/{date}-{slug}.json
# → post/youtube/{date}-{slug}.json
# → post/tiktok/{date}-{slug}.json
npx tsx $SKILLS_DIR/video-schedule-post/scripts/post.ts --json post/instagram/{date}-{slug}.json
npx tsx $SKILLS_DIR/video-schedule-post/scripts/post.ts --json post/youtube/{date}-{slug}.json
npx tsx $SKILLS_DIR/video-schedule-post/scripts/post.ts --json post/tiktok/{date}-{slug}.json
```
