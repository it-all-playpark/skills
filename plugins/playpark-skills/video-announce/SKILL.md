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

Generate platform-optimized captions with SEO hashtags for Instagram, YouTube Shorts, and TikTok.

## Usage

```
/video-announce <source> [options]
```

Source: video/image file, MDX/Markdown, URL, or topic text.

| Option | Default | Description |
|--------|---------|-------------|
| `-t` | auto | feed, reel, story, carousel |
| `-p` | all-video | instagram, youtube, tiktok |
| `-o` | stdout | Output file |
| `--format` | md | md, json |
| `--schedule` | — | `"YYYY-MM-DD HH:MM"` |
| `--lang` | ja | ja, en |
| `--media` | — | Extra media paths |

Platforms: `all-video` (default) = IG + YT Shorts + TikTok. Or comma-separated subset.

Config: `.claude/video-announce.json` — [Config Guide](references/config-guide.md)

## Workflow

| # | Action | Details |
|---|--------|---------|
| 1 | Load config | `scripts/load-config.sh` |
| 2 | Determine platforms | `-p` or config |
| 3 | Extract source | metadata / frontmatter / URL |
| 4 | Detect media | `scripts/detect-media.sh` |
| 5 | Thumbnails | JSON + video only |
| 6 | Captions + hashtags | Per platform |
| 7 | Write output | JSON or Markdown |

[Workflow Detail](references/workflow-detail.md) — thumbnails, auto-detect rules, backward compat

Scripts: `load-config.sh`, `detect-media.sh <path> [--type T]`, `extract-thumbnail.sh <path> --offset-ms N --output P`

## References

- [Workflow Detail](references/workflow-detail.md) | [Config Guide](references/config-guide.md) | [Output Format](references/output-format.md)
- [Caption Structures](references/caption-structures.md) | [Hashtag strategy](references/short-video-hashtags.md) | [Posting times](references/posting-times.json)
- [Instagram](references/instagram-guide.md) | [YouTube Shorts](references/youtube-shorts-guide.md) | [TikTok](references/tiktok-guide.md)

## Examples

```bash
/video-announce promo-video.mp4                          # all-video (default)
/video-announce promo-video.mp4 --platforms instagram     # Instagram only
/video-announce promo-video.mp4 --platforms youtube,tiktok
/video-announce blog/article.mdx --type feed
/video-announce video.mp4 --format json --schedule "2026-03-12 19:00"
/video-announce video.mp4 --format json && zernio post --json post/*.json
```

## Journal Logging

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log video-announce success --duration-turns $TURNS
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log video-announce failure --error-category <cat> --error-msg "<msg>"
```
