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

Project config: `.claude/video-announce.json` — See [Config Guide](references/config-guide.md) for full example and details.

## Workflow

1. Load config (`.claude/video-announce.json`)
2. Determine target platforms (`--platforms` or config)
3. Identify source type and extract context (media metadata / article frontmatter / URL / topic)
4. Detect aspect ratio for video via `ffprobe` (see Auto-Detect table below)
5. For each platform: generate caption ([Caption Structures](references/caption-structures.md)) + hashtags ([Hashtag Strategy](references/short-video-hashtags.md))
6. Write output as JSON array or Markdown ([Output Format](references/output-format.md))
7. Generate thumbnails if `platformDefaults.thumbOffset` is set (see [Config Guide](references/config-guide.md#platformdefaultsthumboffset))

### Auto-Detect Content Type

動画ソースの場合、`ffprobe` でアスペクト比を自動検出し、プラットフォーム別に最適な設定を適用する。

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 <video>
```

| Condition | Instagram | YouTube | TikTok |
|-----------|-----------|---------|--------|
| Video, 9:16 (縦長), <= 90s | `contentType: "reels"` | Shorts（`#Shorts` 付き） | 通常投稿 |
| Video, 16:9 (横長) or other | `contentType: "feed"` | 通常動画（`#Shorts` なし） | 通常投稿（黒帯あり） |
| Video, > 90s | `contentType: "feed"` | 通常動画 | 通常投稿 |
| Single image | `contentType: "feed"` | — | — |
| Multiple images/videos (--media) | `contentType: "carousel"` | — | — |
| No media (topic/article only) | `contentType: "feed"` | — | — |

**重要**: `--type` で明示指定された場合はそちらを優先する。

## References

- [Instagram guide](references/instagram-guide.md)
- [YouTube Shorts guide](references/youtube-shorts-guide.md)
- [TikTok guide](references/tiktok-guide.md)
- [Hashtag strategy (cross-platform)](references/short-video-hashtags.md)
- [Posting times](references/posting-times.json)
- [Caption Structures](references/caption-structures.md)
- [Output Format](references/output-format.md)
- [Config Guide](references/config-guide.md)

## Examples

```bash
# 全プラットフォーム投稿文を生成（デフォルト: all-video）
/video-announce packages/video/out/promo-video.mp4

# Instagram単体
/video-announce packages/video/out/promo-video.mp4 --platforms instagram

# YouTube Shorts + TikTok のみ
/video-announce packages/video/out/promo-video.mp4 --platforms youtube,tiktok

# ブログ記事からフィード投稿文を生成
/video-announce content/blog/2026-01-15-shift-management.mdx --type feed

# JSON出力 + スケジュール
/video-announce packages/video/out/guide-setup.mp4 --format json --schedule "2026-03-12 19:00"

# 投稿パイプライン（1ファイルで全プラットフォーム）
/video-announce video.mp4 --format json
# → post/{date}-{slug}.json (配列: [instagram, youtube, tiktok])
npx tsx $SKILLS_DIR/late-schedule-post/scripts/post.ts --json post/{date}-{slug}.json
```

## Backward Compatibility

- `--platforms` 省略時 → `all-video`（全プラットフォーム生成）
- `--platforms instagram` → Instagram単体（従来の動作）
- config に `platforms` キーなし → 全プラットフォームにフォールバック
- 旧形式の config（`hashtag` がトップレベル）→ Instagram設定として解釈
