# Config Schema

設定ファイル `~/.config/receipt-fetch/config.yaml` の仕様。

## Schema

```yaml
# 出力ディレクトリ（~ 展開可）
output_dir: ~/Documents/receipts

# サービス設定
services:
  <service-name>:
    # 有効/無効
    enabled: true

    # 1Password アイテム名
    op_item: "Service Login"

    # TOTP(2FA) 使用
    totp: false

    # 固定セレクタによるステップ（オプション）
    steps:
      - action: goto
        url: https://example.com/login
      - action: fill
        selector: "#email"
        value: "{{username}}"
      - action: fill
        selector: "#password"
        value: "{{password}}"
      - action: click
        selector: "button[type=submit]"
      - action: wait
        selector: ".dashboard"
        timeout: 10000

    # AIフォールバック設定（オプション）
    fallback:
      ai_prompt: "ログインして請求書一覧からPDFをダウンロード"
```

## Step Actions

| Action | Required | Description |
|--------|----------|-------------|
| `goto` | url | URLに移動 |
| `fill` | selector, value | 入力欄に値を入力 |
| `click` | selector | 要素をクリック |
| `wait` | selector or timeout | 要素表示またはタイムアウト待機 |
| `download` | selector | ファイルダウンロード |

## Variables

`value` フィールドで使用可能な変数:

| Variable | Description |
|----------|-------------|
| `{{username}}` | 1Passwordから取得したユーザー名 |
| `{{password}}` | 1Passwordから取得したパスワード |
| `{{totp}}` | 1Passwordから取得したTOTPコード |

## Example

```yaml
output_dir: ~/Documents/receipts

services:
  moneyforward:
    enabled: true
    op_item: "MoneyForward Login"
    totp: true
    fallback:
      ai_prompt: "経費精算の請求書一覧ページでPDFをダウンロード"

  jr-east:
    enabled: true
    op_item: "えきねっと Login"
    totp: false

  amazon:
    enabled: true
    op_item: "Amazon Japan"
    totp: true
```

## 1Password Item Setup

1Passwordアイテムには以下のフィールドが必要:

- `username` - ログインID/メールアドレス
- `password` - パスワード
- `one-time password` (totp: true の場合) - TOTP設定

```bash
# アイテム確認
op item get "MoneyForward Login" --fields username,password

# TOTP取得テスト
op item get "MoneyForward Login" --otp
```
