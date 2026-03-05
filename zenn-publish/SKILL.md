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

### GitHub連携モード（推奨）

`ZENN_REPO_PATH` が設定済みの場合、自動で下書き投稿:

1. `published: false` を強制（元が true でも上書き）
2. `articles/{slug}.md` にファイル配置
3. git add → commit → push
4. Zenn が自動同期し下書きとして登録

### クリップボードモード（フォールバック）

`ZENN_REPO_PATH` 未設定の場合:

1. `published: false` に変換してクリップボードにコピー
2. Zenn ダッシュボードをブラウザで開く
3. エディタにペーストして投稿

## Prerequisites

### GitHub連携セットアップ（初回のみ）

1. Zenn にログイン → 設定 → GitHub連携 でリポジトリを接続
2. `.env` に `ZENN_REPO_PATH=/path/to/zenn-repo` を設定

```bash
# .env
ZENN_REPO_PATH=/Users/username/ghq/github.com/org/zenn-content
```

### リポジトリ構造

```
zenn-repo/
├── articles/     # 記事はここに配置される
│   └── slug.md
└── package.json  # zenn-cli（オプション：ローカルプレビュー用）
```

## Init

```bash
bash $SKILLS_DIR/zenn-publish/scripts/publish.sh <file-path> [--slug <slug>]
```
