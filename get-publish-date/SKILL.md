---
name: get-publish-date
description: |
  Calculate next available publish date based on schedule configuration.
  Use when: determining blog/news publish date, scheduling content.
  Keywords: "次の投稿日", "公開日", "publish date", "schedule"
user-invocable: true
effort: low
---

# Get Publish Date

Calculate next publish date from skill-config.json.

```bash
bash ~/.claude/skills/get-publish-date/scripts/get_next_date.sh
```

Output: `YYYY-MM-DD`

## Config

`skill-config.json` の `get-publish-date` セクション:

```json
{
  "publish_days": ["monday", "thursday"],
  "content_dir": "content/blog"
}
```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log get-publish-date success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log get-publish-date failure \
  --error-category <category> --error-msg "<message>"
```
