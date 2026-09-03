---
name: qiita-publish
description: |
  Publish markdown file to Qiita as a private (limited sharing) draft via API.
  Use when: (1) user wants to publish cross-post content to Qiita,
  (2) keywords like "Qiita投稿", "Qiita公開", "qiita publish",
  (3) user has a Qiita-formatted markdown file from blog-cross-post.
  Accepts args: <file-path> [--public]
user-invocable: true
context: fork
model: haiku
---

# Qiita Publish

blog-cross-post出力をQiitaに**限定共有**として投稿。

## Usage

```
/qiita-publish <file-path> [--public]
```

## Prerequisites

`.env` にトークン設定が必要。未設定なら `.env.example` を参照。

## Init

```bash
bash $SKILLS_DIR/qiita-publish/scripts/publish.sh <file-path> [--public]
```

## References

- `.env.example` - トークン設定
- `references/api-spec.md` - Qiita API v2 仕様

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log qiita-publish success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log qiita-publish failure \
  --error-category <category> --error-msg "<message>"
```
