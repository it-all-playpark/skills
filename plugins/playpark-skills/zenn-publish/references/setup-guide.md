# Zenn Publish セットアップガイド

## GitHub連携モード（推奨）

`ZENN_REPO_PATH` が設定済みの場合、自動で下書き投稿:

1. `published: false` を強制（元が true でも上書き）
2. `articles/{slug}.md` にファイル配置
3. git add → commit → push
4. Zenn が自動同期し下書きとして登録

## クリップボードモード（フォールバック）

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
