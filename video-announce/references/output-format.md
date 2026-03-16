# Output Format

## JSON (Late API format) - Array

全プラットフォームの投稿データを単一のJSON配列として `{output.dir}/{date}-{slug}.json` に出力する。

### Example: `post/2026-03-12-promo-video.json`

```json
[
  {
    "content": "キャプション本文",
    "mediaItems": [
      {"type": "video", "path": "/path/to/video.mp4"}
    ],
    "platforms": [
      {
        "platform": "instagram",
        "platformSpecificData": {
          "contentType": "reels or feed (アスペクト比で自動判定)",
          "instagramThumbnail": "post/thumbnails/instagram/{slug}.jpg",
          "firstComment": "#追加ハッシュタグ群"
        }
      }
    ],
    "schedule": "2026-03-12 19:00"
  },
  {
    "content": "動画の説明文（Description）\n\nチャンネル登録お願いします！\n\n#シフト管理 #業務効率化 (縦長なら #Shorts 追加)",
    "mediaItems": [
      {
        "type": "video",
        "path": "/path/to/video.mp4",
        "thumbnail": {
          "url": "post/thumbnails/youtube/{slug}.jpg"
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
  },
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
]
```

### Platform-specific Notes

- **Instagram**: `platformSpecificData.instagramThumbnail` にサムネパスを設定
- **YouTube**: `content` = 説明文、`platformSpecificData.title` = タイトル（max 100字）、`mediaItems[].thumbnail.url` = サムネパス
- **TikTok**: `tiktokSettings` はトップレベルに配置、`content_preview_confirmed` / `express_consent_given` は常に `true`

## Markdown (default)

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
