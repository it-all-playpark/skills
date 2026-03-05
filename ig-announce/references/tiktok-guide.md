# TikTok Guide

## Platform Limits

| Field | Limit | Notes |
|-------|-------|-------|
| Caption | 2,200 chars max | Hashtags count toward limit |
| Hashtags | 3-5 recommended | Inline in caption |
| Video | Max 10 min, 9:16 aspect | Up to 4 GB |

## Video Requirements

- Format: MP4, MOV, WebM
- Resolution: 1080 x 1920 px (9:16)
- Duration: 3 sec - 10 min (Shorts: under 60 sec recommended)
- File size: Up to 4 GB
- Frame rate: 30-60 fps

## Caption Best Practices

### Structure
```
{フック文 - 最初の1行で注意を引く}

{内容の要約 1-2行}

{CTA}

{ハッシュタグ 3-5個 インライン}
```

### Rules
- Hook in first line (visible without expanding)
- Keep it concise and punchy
- Hashtags are inline (not separated like Instagram)
- 3-5 hashtags max (TikTok penalizes too many)
- Use trending sounds/hashtags when relevant
- Emoji usage is encouraged on TikTok

### CTA Examples (Japanese)
- `フォローして最新情報をチェック！`
- `コメントで感想教えて`
- `友達にシェアしてね`
- `プロフィールのリンクから詳細をチェック`
- `保存して後で見返してね`

### Caption Examples (Japanese)
```
シフト管理、まだ手作業でやってない？

AIが自動で最適なシフトを作成してくれるから、
店長の負担が劇的に減るんです

プロフィールのリンクから無料で試せるよ

#シフト管理 #飲食店 #業務効率化 #DX #ShiftBud
```

## Hashtag Strategy

- **Max**: 3-5 hashtags (more reduces reach)
- **Placement**: Inline at end of caption
- **Mix**: 1 trending + 2-3 niche + 1 brand
- **No `#` spam**: Quality over quantity
- **Trending**: Check TikTok Discover page for trends

### SaaS / Business (Japanese)
```
#業務効率化 #DX推進 #シフト管理 #飲食店経営 #店長あるある
#バイト管理 #人手不足 #働き方改革 #SaaS #ShiftBud
```

## TikTok SEO Signals

1. **Caption keywords**: Primary keyword in first line
2. **Hashtags**: 3-5 relevant, trending preferred
3. **Sounds**: Use trending audio when possible
4. **Engagement**: Likes, comments, shares, saves
5. **Watch time**: Hook in first 1-3 seconds
6. **Completion rate**: Most important metric

## Posting Times (JST)

| Day | Best Times | Notes |
|-----|-----------|-------|
| Weekday | 07:00, 12:00, 19:00-22:00 | Morning, lunch, evening |
| Weekend | 10:00-12:00, 19:00-23:00 | Late morning, evening |
| Best days | Tue, Thu, Fri | Higher engagement |

## Privacy & Consent Fields (Required)

TikTok API requires explicit consent fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `privacy_level` | string | Yes | `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY` |
| `allow_comment` | boolean | Yes | Allow comments |
| `allow_duet` | boolean | Yes | Allow duets |
| `allow_stitch` | boolean | Yes | Allow stitches |
| `content_preview_confirmed` | boolean | Yes | Must be `true` - user confirmed content preview |
| `express_consent_given` | boolean | Yes | Must be `true` - user gave express consent |
| `video_cover_timestamp_ms` | number | No | Timestamp for cover image (ms) |
| `video_made_with_ai` | boolean | No | Whether AI was used to create the video |

## Late API Fields

```json
{
  "tiktokSettings": {
    "privacy_level": "PUBLIC_TO_EVERYONE",
    "allow_comment": true,
    "allow_duet": true,
    "allow_stitch": true,
    "content_preview_confirmed": true,
    "express_consent_given": true,
    "video_cover_timestamp_ms": 2000,
    "video_made_with_ai": false
  }
}
```

**Note**: `tiktokSettings` is a top-level field in the Late API request body (not inside `platformSpecificData`).

### Cover Image
TikTok uses `video_cover_timestamp_ms` instead of a separate thumbnail upload:
- Specify the timestamp (in milliseconds) of the frame to use as cover
- Default: 2000 (2 seconds into the video)
