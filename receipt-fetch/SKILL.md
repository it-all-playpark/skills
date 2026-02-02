---
name: receipt-fetch
description: |
  Automated receipt/invoice fetching from web services (MoneyForward, JR East, Amazon).
  Use when: (1) user needs to download receipts for expense reports,
  (2) keywords like "領収書取得", "経費精算", "receipt download",
  (3) monthly receipt collection automation.
  Accepts args: --month YYYY-MM [--service names] [--headed] [--dry-run]
user-invocable: true
---

# Receipt Fetch

各種Webサービスから領収書・請求書を自動取得し、所定のディレクトリに保存。

## Usage

```bash
/receipt-fetch --month 2024-01
/receipt-fetch --month 2024-01 --service moneyforward,amazon
/receipt-fetch --month 2024-01 --headed  # デバッグモード
/receipt-fetch --month 2024-01 --dry-run
/receipt-fetch --list-services
```

## Prerequisites

1. **1Password CLI** がインストール・ログイン済み
2. **設定ファイル** `~/.config/receipt-fetch/config.yaml` を作成
3. **Anthropic API Key** を `.env` に設定（AIフォールバック用）

## Setup

```bash
# 1Password CLI インストール（Homebrew）
brew install --cask 1password-cli

# 1Password サインイン
eval $(op signin)

# 依存関係インストール
cd ~/.claude/skills/receipt-fetch && npm install

# 設定ファイル作成
mkdir -p ~/.config/receipt-fetch
cp ~/.claude/skills/receipt-fetch/references/config-example.yaml ~/.config/receipt-fetch/config.yaml
# 設定を編集...
```

## Init

```bash
npx tsx ~/.claude/skills/receipt-fetch/scripts/fetch.ts --month YYYY-MM [options]
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-m, --month` | 当月 | 対象年月 (YYYY-MM) |
| `-s, --service` | 全有効 | 対象サービス (カンマ区切り) |
| `-c, --config` | ~/.config/receipt-fetch/config.yaml | 設定ファイルパス |
| `--headed` | false | ブラウザ表示モード |
| `--dry-run` | false | ダウンロードせず表示のみ |
| `-v, --verbose` | false | 詳細ログ出力 |
| `--list-services` | - | 対応サービス一覧表示 |

## Supported Services

- **moneyforward** - MoneyForward 会計/経費精算
- **jr-east** - JR東日本 えきねっと
- **amazon** - Amazon.co.jp

## Output

```
~/Documents/receipts/
├── 2024-01/
│   ├── moneyforward/
│   │   └── invoice_001.pdf
│   ├── jr-east/
│   │   └── receipt_20240115.pdf
│   ├── amazon/
│   │   └── order_123-456.pdf
│   └── report.json
```

## References

- `references/config-schema.md` - 設定ファイル仕様
- `.env.example` - 環境変数設定例
