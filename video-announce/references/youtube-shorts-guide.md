# YouTube Shorts Guide

## Platform Limits

| Field | Limit | Notes |
|-------|-------|-------|
| Title | 100 chars max | Most important for discoverability |
| Description | 5,000 chars max | SEO-rich, links allowed |
| Hashtags | 3-5 recommended | `#Shorts` required |
| Video | Max 60 sec, 9:16 aspect | Up to 2 GB |

## Video Requirements

- Format: MP4, MOV, WebM
- Resolution: 1080 x 1920 px (9:16)
- Duration: Max 60 seconds
- File size: Up to 2 GB
- Frame rate: 30-60 fps recommended

## Title Best Practices

### Structure
```
{Primary keyword} - {Hook/Value proposition} {Emoji optional}
```

### Rules
- Max 100 characters (shorter is better for mobile)
- Front-load primary keyword
- Use numbers when possible ("3 Tips", "5 Ways")
- Avoid clickbait that doesn't deliver
- No hashtags in title (put in description)

### Examples (Japanese)
```
シフト管理が劇的に変わる！AIが自動で最適配置
飲食店の人手不足を解決する3つのテクニック
【店長必見】シフト作成を10分で終わらせる方法
```

## Description Best Practices

### Structure
```
{動画の説明 2-3行}

{CTA - チャンネル登録促進}

{関連リンク}

{ハッシュタグ 3-5個} #Shorts
```

### Rules
- First 2 lines are visible without expanding
- Include primary keywords naturally
- Add relevant links (website, related videos)
- CTA: チャンネル登録、高評価、コメント促進
- `#Shorts` is mandatory (signals YouTube Shorts algorithm)
- Keep hashtags at the end of description

### CTA Examples (Japanese)
- `チャンネル登録で最新情報をゲット！`
- `高評価＆コメントお待ちしています`
- `他の動画もチェック → [channel URL]`
- `詳しくはプロフィールのリンクから`

## Category IDs

| ID | Category | Use Case |
|----|----------|----------|
| 22 | People & Blogs | General content |
| 26 | Howto & Style | Tutorials, tips |
| 27 | Education | Educational content |
| 28 | Science & Technology | SaaS, tech products |
| 25 | News & Politics | Industry news |

**Default for Shift Bud: `28` (Science & Technology)**

## YouTube SEO Signals

1. **Title keywords**: Primary keyword in first 40 chars
2. **Description keywords**: Natural keyword placement in first 2 lines
3. **Hashtags**: 3-5 relevant + `#Shorts`
4. **Tags**: Add relevant tags (not visible but indexed)
5. **Thumbnail**: Custom thumbnail recommended (even for Shorts)
6. **Engagement**: Likes, comments, watch time
7. **Retention**: Hook viewers in first 3 seconds

## Posting Times (JST)

| Day | Best Times | Notes |
|-----|-----------|-------|
| Weekday | 12:00, 17:00-20:00 | Lunch break, after work |
| Weekend | 10:00-12:00, 15:00-18:00 | Late morning, afternoon |
| Best days | Fri, Sat, Sun | Higher engagement |

## Late API Fields

```json
{
  "platformSpecificData": {
    "title": "Max 100 chars title",
    "visibility": "public",
    "categoryId": "28",
    "madeForKids": false,
    "containsSyntheticMedia": false
  }
}
```

### Thumbnail
YouTube thumbnails are attached via `mediaItems[].thumbnail.url`:
```json
{
  "mediaItems": [
    {
      "type": "video",
      "url": "https://...",
      "thumbnail": {
        "url": "https://uploaded-thumbnail-url"
      }
    }
  ]
}
```
