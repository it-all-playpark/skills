# SNS Announce Configuration Schema

Project config: `.claude/sns-announce.json`

## Full Example

```json
{
  "base_url": "https://example.com",
  "url_pattern": "/blog/{slug}",
  "default_lang": "ja",
  "output": {
    "dir": "post/blog",
    "pattern": "{date}-{slug}.json",
    "format": "json"
  },
  "schedule": {
    "enabled": true,
    "mode": "auto"
  },
  "utm": {
    "enabled": true,
    "medium": "social",
    "source_map": {
      "x": "x",
      "linkedin": "linkedin",
      "google": "google_business",
      "facebook": "facebook",
      "bluesky": "bluesky",
      "threads": "threads"
    }
  },
  "platforms": {
    "x": { "enabled": true },
    "linkedin": { "enabled": true },
    "google": { "enabled": true },
    "facebook": { "enabled": true },
    "bluesky": { "enabled": false },
    "threads": { "enabled": false }
  }
}
```

## UTM Config

| Key | Value | Description |
|-----|-------|-------------|
| `enabled` | true/false | Enable UTM parameter auto-append to URLs |
| `medium` | string | `utm_medium` value (e.g., "social") |
| `source_map` | object | Platform-to-`utm_source` mapping |

When `utm.enabled: true`:
- All URLs include `?utm_source={source}&utm_medium={medium}&utm_campaign={slug}`
- `{source}` is looked up from `utm.source_map` by platform key
- `{slug}` is the article slug (from filename or URL path)

## Schedule Config

| Key | Value | Description |
|-----|-------|-------------|
| `enabled` | true/false | Enable Zernio API format output |
| `mode` | "auto" | Auto-calculate optimal posting times per platform based on article date |

When `schedule.enabled: true`:
- Output format becomes Zernio API array format
- Each platform gets optimal posting time from `posting-times.json`
- Schedule date defaults to article's publish date

## Output Auto-Save

When `output.dir` and `output.pattern` are set:
1. Skip stdout, write directly to file
2. Pattern variables: `{date}`, `{slug}`, `{category}`
3. Returns only confirmation message (saves context)

When not set: stdout (traditional behavior)
