# SNS Announce Output Formats

## Markdown (default)

```
SNS告知テンプレート

━━━━━━━━━━━━━━━━━━━━
X（Twitter）用
━━━━━━━━━━━━━━━━━━━━
{post}

━━━━━━━━━━━━━━━━━━━━
LinkedIn用
━━━━━━━━━━━━━━━━━━━━
{post}
```

## JSON

### Standard (when schedule.enabled: false)

```json
{"source": "...", "generated_at": "ISO8601", "posts": {"x": "...", "linkedin": "..."}}
```

### Zernio API format (when schedule.enabled: true or --schedule specified)

```json
[
  {"content": "X用の投稿文 #hashtag", "schedule": "2026-03-12 12:00", "platforms": ["x"]},
  {"content": "LinkedIn用の投稿文", "schedule": "2026-03-12 08:30", "platforms": ["linkedin"]},
  {"content": "Google Business用の投稿文", "schedule": "2026-03-12 10:00", "platforms": ["googlebusiness"]},
  {"content": "Facebook用の投稿文", "schedule": "2026-03-12 09:00", "platforms": ["facebook"]},
  {"content": "Bluesky用の投稿文", "schedule": "2026-03-12 19:00", "platforms": ["bluesky"]},
  {"content": "Threads用の投稿文", "schedule": "2026-03-12 18:30", "platforms": ["threads"]}
]
```
