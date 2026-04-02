---
name: zenn-publish
description: |
  Publish Zenn article as draft via GitHub integration, or copy to clipboard as fallback.
  Use when: (1) user wants to publish cross-post content to Zenn,
  (2) keywords like "Zenn投稿", "Zenn公開", "zenn publish",
  (3) user has a Zenn-formatted markdown file from blog-cross-post.
  Accepts args: <file-path> [--slug <slug>]
user-invocable: true
---

# Zenn Publish

blog-cross-post出力をZennに**下書き（published: false）**として投稿。

## Usage

```
/zenn-publish <file-path> [--slug <slug>]
```

## Modes

| Mode | Condition | Action |
|------|-----------|--------|
| GitHub連携（推奨） | `ZENN_REPO_PATH` 設定済み | articles/ に配置 → git push → Zenn自動同期 |
| クリップボード | `ZENN_REPO_PATH` 未設定 | クリップボードにコピー → ブラウザで貼り付け |

Details: [Setup Guide](references/setup-guide.md)

## Init

```bash
bash $SKILLS_DIR/zenn-publish/scripts/publish.sh <file-path> [--slug <slug>]
```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log zenn-publish success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log zenn-publish failure \
  --error-category <category> --error-msg "<message>"
```
