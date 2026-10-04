---
name: get-publish-date
description: |
  Calculate next available publish date based on schedule configuration.
  Use when: determining blog/news publish date, scheduling content.
  Keywords: "次の投稿日", "公開日", "publish date", "schedule"
user-invocable: true
model: haiku
effort: low
---

# Get Publish Date

Calculate next publish date from skill-config.json.

```bash
bash scripts/get_next_date.sh
```

パスは本 skill ディレクトリ基準。実行時は本 SKILL.md のロード元ディレクトリを前置した絶対パスに解決して呼ぶこと。

Output: `YYYY-MM-DD`

## Config

`skill-config.json` の `get-publish-date` セクション:

```json
{
  "publish_days": ["monday", "thursday"],
  "content_dir": "content/blog"
}
```
