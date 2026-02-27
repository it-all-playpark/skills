---
name: ig-announce
description: |
  Generate Instagram post captions with SEO-optimized hashtags from video files, images, blog articles, or topics.
  Use when: (1) user wants to create Instagram post content,
  (2) needs captions and hashtags for Instagram feed/reel/story/carousel,
  (3) keywords like "Instagram投稿文", "IG投稿", "キャプション作成", "Instagram caption", "ig announce",
  (4) input: video/image files, MDX/Markdown articles, URLs, or topic text.
  Accepts args: SOURCE [--type feed|reel|story|carousel] [--output FILE] [--format md|json] [--schedule "YYYY-MM-DD HH:MM"] [--lang ja|en]
---

# IG Announce

Generate Instagram-optimized captions with SEO hashtags from media files, articles, or topics.

## Usage

```
/ig-announce <source> [options]
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
| `--output, -o FILE` | Output to file | config or stdout |
| `--format FORMAT` | md, json | config or md |
| `--schedule DATETIME` | Schedule time (enables Late API format) | none |
| `--lang LANG` | ja, en | config or ja |
| `--media PATHS` | Additional media file paths (comma-separated) | none |

## Configuration

Project config: `.claude/ig-announce.json`

```json
{
  "default_lang": "ja",
  "output": {
    "dir": "post/instagram",
    "pattern": "{date}-{slug}.json",
    "format": "json"
  },
  "schedule": {
    "enabled": true,
    "mode": "auto"
  },
  "hashtag": {
    "max_count": 30,
    "target_count": 15,
    "strategy": "mixed"
  },
  "brand": {
    "always_tags": ["playpark"]
  },
  "platformDefaults": {
    "thumbOffset": 2000
  }
}
```

### platformDefaults.thumbOffset

動画メディアのサムネイル用フレーム切り出し位置（ミリ秒）。設定すると:
1. JSON出力時、ffmpegで動画の指定位置からJPEGフレームを `{output.dir}/thumbnails/{slug}.jpg` に自動生成
2. JSON出力の `platformSpecificData.instagramThumbnail` にサムネパスを自動設定
3. `ig-schedule-post` のスクリプトがサムネをLate APIにアップロードし、`mediaItems[].instagramThumbnail` として登録

## Workflow

```
1. Load config
2. Identify source type (media/article/topic)
3. Extract context:
   - Media → infer content from filename, path, video metadata
   - Article → extract title, description, key points from frontmatter/body
   - URL → fetch and parse article content
   - Topic → use as-is
4. Detect content type (feed/reel/story/carousel)
5. Generate caption following Instagram guidelines (see references/instagram-guide.md)
6. Generate SEO hashtags following hashtag strategy (see references/hashtag-strategy.md)
7. Write output (JSON/Markdown)
8. Thumbnail generation (if platformDefaults.thumbOffset is set and media is video):
   - Extract frame at thumbOffset ms using ffmpeg:
     ffmpeg -y -ss <seconds> -i <video> -frames:v 1 -q:v 2 -update 1 <output>.jpg
   - Save to: {output.dir}/thumbnails/{slug}.jpg
   - Set `platformSpecificData.instagramThumbnail` to the saved thumbnail path
   - ig-schedule-post will auto-upload and attach to mediaItems[].instagramThumbnail
```

### Auto-Detect Content Type

| Condition | Detected Type |
|-----------|---------------|
| Video, 9:16 aspect, <= 90s | reel |
| Video, other aspect or > 90s | feed (video) |
| Single image | feed (image) |
| Multiple images/videos (--media) | carousel |
| No media (topic/article only) | feed (placeholder) |

## Caption Structure

### Feed/Carousel (Japanese)

```
{フック文（最初の125文字が重要 - "もっと見る"前に表示される部分）}

{本文 - 価値提供・ストーリー・解説}

{CTA（行動喚起）}

・
・
・

{ハッシュタグ群（15-30個）}
```

### Reel (Japanese)

```
{フック文 - 短く強いインパクト}

{内容の要約（2-3行）}

{CTA}

{ハッシュタグ群（15-20個）}
```

### Story

Caption not displayed on Stories. Generate hashtag sticker suggestions (5-10 tags) only.

## Output Format

### Markdown (default)

```
## Instagram投稿テンプレート

**タイプ**: feed | reel | story | carousel
**メディア**: /path/to/media.mp4

### キャプション
{caption}

### ハッシュタグ（{count}個）
{hashtags}

### ファーストコメント（推奨）
{first_comment_hashtags}
```

### JSON (Late API format)

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

## References

- **Instagram caption best practices**: See [references/instagram-guide.md](references/instagram-guide.md)
- **Hashtag strategy & SEO**: See [references/hashtag-strategy.md](references/hashtag-strategy.md)

## Examples

```bash
# Remotion動画からリール投稿文を生成
/ig-announce packages/video/out/promo-video.mp4

# ブログ記事からフィード投稿文を生成
/ig-announce content/blog/2026-01-15-shift-management.mdx --type feed

# トピックから投稿文を生成
/ig-announce "AIを活用したシフト管理の未来" --type feed

# カルーセル（複数画像）
/ig-announce "シフト管理Tips5選" --type carousel --media img1.jpg,img2.jpg,img3.jpg

# JSON出力 + スケジュール
/ig-announce packages/video/out/guide-setup.mp4 --format json --schedule "2026-03-12 19:00"

# ig-schedule-post連携パイプライン
/ig-announce video.mp4 --format json --output post/ig/draft.json
/ig-schedule-post --json post/ig/draft.json
```
