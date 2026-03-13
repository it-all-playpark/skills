# File Patterns

ブログ記事関連ファイルのパターン定義。

## MDX Files

```
content/blog/YYYY-MM-DD-{slug}.mdx
```

Frontmatter fields:

- `date`: `YYYY-MM-DD`
- `image`: `/blog/YYYY-MM-DD-{slug}.webp`

## Image Files

```
public/blog/YYYY-MM-DD-{slug}.webp
```

## Seed Files

```
seed/{project-name}/articles.json
```

JSON structure:

```json
{
  "articles": [
    {
      "path": "/absolute/path/to/content/blog/YYYY-MM-DD-{slug}.mdx",
      "category": "tech-tips",
      "angle": "記事の切り口",
      "createdAt": "YYYY-MM-DDTHH:MM:SSZ",
      "slug": "{slug}"
    }
  ]
}
```

## SNS Post Files

```
post/blog/YYYY-MM-DD-{slug}.json
```

JSON structure:

```json
[
  {
    "content": "投稿テキスト",
    "schedule": "YYYY-MM-DD HH:MM",
    "platforms": ["x", "linkedin", "facebook", "googlebusiness", "bluesky"]
  }
]
```

## Date Format Rules

| Context          | Format             | Example                |
| ---------------- | ------------------ | ---------------------- |
| Filename prefix  | `YYYY-MM-DD`       | `2026-02-03`           |
| frontmatter.date | `YYYY-MM-DD`       | `2026-02-03`           |
| createdAt        | ISO 8601           | `2026-02-03T10:00:00Z` |
| schedule         | `YYYY-MM-DD HH:MM` | `2026-02-03 07:30`     |
