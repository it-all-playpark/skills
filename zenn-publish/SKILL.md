---
name: zenn-publish
description: |
  Copy Zenn-formatted markdown to clipboard and open Zenn editor in browser.
  Use when: (1) user wants to publish cross-post content to Zenn,
  (2) keywords like "Zenn投稿", "Zenn公開", "zenn publish",
  (3) user has a Zenn-formatted markdown file from blog-cross-post.
  Accepts args: <file-path>
user-invocable: true
---

# Zenn Publish

blog-cross-post出力をクリップボードにコピーし、Zennエディタを開く。

## Usage

```
/zenn-publish <file-path>
```

## Workflow

1. ファイル内容をクリップボードにコピー
2. Zenn記事作成ページをブラウザで開く
3. エディタにペーストして投稿

## Init

```bash
bash ~/.claude/skills/zenn-publish/scripts/publish.sh <file-path>
```
