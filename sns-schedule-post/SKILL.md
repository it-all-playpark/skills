---
name: sns-schedule-post
description: |
  Schedule or post to multiple SNS platforms (X, LinkedIn, Facebook, Google Business, Threads, Bluesky) using Late API.
  Use when: (1) user wants to schedule posts to social media,
  (2) user wants to post to multiple platforms at once,
  (3) after /sns-announce to schedule generated posts,
  (4) keywords like "SNS投稿", "予約投稿", "schedule post", "post to SNS".
  Accepts args: TEXT or FILE [--schedule "YYYY-MM-DD HH:MM"] [--platforms x,linkedin,facebook,googlebusiness,threads,bluesky] [--dry-run]
---

# SNS Schedule Post

Schedule or post to multiple SNS platforms via Late API (getlate.dev).

## Usage

```
# Single post
/sns-schedule-post TEXT or FILE [--schedule "YYYY-MM-DD HH:MM"] [--platforms PLATFORMS] [--dry-run]

# Batch posts from JSON
/sns-schedule-post --json posts.json [--dry-run]
```

| Argument | Description |
|----------|-------------|
| TEXT or FILE | Post content (quoted text or file path) |
| `--json, -j` | JSON file with multiple posts |
| `--schedule, -s` | Schedule time in JST (omit for immediate post) |
| `--platforms, -p` | Platforms: x, linkedin, facebook, googlebusiness, threads, bluesky, all (default: all) |
| `--dry-run, -n` | Preview without posting |

## Setup

### 1. Create Late Account

1. Sign up at https://getlate.dev (free plan: 10 posts/month, 2 profiles)
2. Connect your social accounts (X, LinkedIn, Facebook, Google Business)
3. Get API key from dashboard

### 2. Environment Variables

Create `~/.claude/skills/sns-schedule-post/.env`:

```
LATE_API_KEY=your_api_key
```

## Examples

### Single Post
```
/sns-schedule-post "新しいブログ記事を公開しました！" --schedule "2026-01-20 09:00" --platforms x,linkedin
```

### Batch Posts from JSON
```
/sns-schedule-post --json posts.json
```

JSON format:
```json
[
  {
    "content": "X用の投稿文 #hashtag",
    "schedule": "2026-03-12 09:00",
    "platforms": ["x"]
  },
  {
    "content": "LinkedIn用の投稿文（長文OK）",
    "schedule": "2026-03-12 09:00",
    "platforms": ["linkedin"]
  },
  {
    "content": "全プラットフォームに投稿",
    "schedule": "2026-03-12 10:00",
    "platforms": "all"
  }
]
```

### Dry Run (Preview)
```
/sns-schedule-post --json posts.json --dry-run
```

## Platform Aliases

| Input | Platform |
|-------|----------|
| x, twitter | X (Twitter) |
| linkedin | LinkedIn |
| facebook, fb | Facebook |
| googlebusiness, google, gbp | Google Business Profile |
| threads | Threads |
| bluesky, bsky | Bluesky |
| all | All connected platforms |

## Implementation

Execute the script at `scripts/post.ts`:

```bash
npx tsx ~/.claude/skills/sns-schedule-post/scripts/post.ts --json <file>
```

DO NOT manually call the Late API. Always use the provided script.

## Notes

- Schedule time: JST (Asia/Tokyo)
- Free plan: 10 posts/month, 2 profiles
- Paid: $19/month for 120 posts, $49/month unlimited
