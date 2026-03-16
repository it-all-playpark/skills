# Configuration Guide

Project config: `.claude/video-announce.json`

## Full Example

```json
{
  "default_lang": "ja",
  "output": {
    "dir": "post",
    "pattern": "{date}-{slug}.json",
    "format": "json"
  },
  "platforms": {
    "instagram": {
      "enabled": true,
      "hashtag": { "max_count": 30, "target_count": 20, "strategy": "first_comment" }
    },
    "youtube": {
      "enabled": true,
      "hashtag": { "max_count": 5, "always_include": ["Shorts (縦長のみ)"], "strategy": "description" },
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

## output.pattern variables

| Variable | Description |
|----------|-------------|
| `{date}` | **Schedule date** (投稿日, YYYY-MM-DD). `--schedule` 指定時はその日付、省略時は当日 |
| `{slug}` | Source filename or topic slug |

**重要**: `{date}` はファイル生成日ではなく、投稿予定日（schedule日）を使用する。sns-announceと同じ規約。

## platformDefaults.thumbOffset

動画メディアのサムネイル用フレーム切り出し位置（ミリ秒）。設定すると:

1. JSON出力時、ffmpegで動画の指定位置からJPEGフレームを `{output.dir}/thumbnails/{platform}/{slug}.jpg` に自動生成
2. **Instagram**: `platformSpecificData.instagramThumbnail` にサムネパスを設定 → `late-schedule-post` がアップロード
3. **YouTube**: `mediaItems[].thumbnail.url` にサムネパスを設定 → 投稿スクリプトがアップロードし `platformSpecificData.thumbnail` としてAPIに送信
4. **TikTok**: `tiktokSettings.video_cover_timestamp_ms` にミリ秒を設定（フレーム指定のみ、サムネアップロード不要）
