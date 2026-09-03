# Google Sheets OAuth2 セットアップガイド

## 前提条件

- Google アカウント
- `uv` (Python パッケージマネージャ)

依存パッケージは `sheet_writer.py` の inline script metadata で定義済み。
`uv run` で自動インストールされるため手動インストール不要。

## GCP OAuth2 Client ID の作成手順

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. プロジェクトを選択（または新規作成）
3. **APIs & Services > Library** で「Google Sheets API」と「Google Drive API」を有効化
4. **APIs & Services > Credentials** へ移動
5. **+ CREATE CREDENTIALS > OAuth client ID** をクリック
6. 初回は **Configure consent screen** が必要:
   - User Type: **External** を選択
   - App name, User support email, Developer contact を入力
   - Scopes: `https://www.googleapis.com/auth/spreadsheets` と `https://www.googleapis.com/auth/drive` を追加
   - Test users: 自分のGoogleアカウントを追加
   - 保存
7. Credentials に戻り **+ CREATE CREDENTIALS > OAuth client ID**:
   - Application type: **Desktop app**
   - 名前を入力して作成
8. **Download JSON** をクリック
9. ダウンロードしたファイルを `~/.config/gspread/credentials.json` に配置:

```bash
mkdir -p ~/.config/gspread
mv ~/Downloads/client_secret_*.json ~/.config/gspread/credentials.json
```

## 初回認証

初回のスクリプト実行時にブラウザが開き、Google アカウントでの認証を求められる。
認証後、トークンが `~/.config/gspread/authorized_user.json` にキャッシュされ、以降は自動認証。

トークンの有効期限が切れた場合も自動的にリフレッシュされる。

## トラブルシューティング

### 「Access blocked: This app's request is invalid」エラー
→ OAuth consent screen でテストユーザーに自分のアカウントが追加されているか確認。

### 「Token has been expired or revoked」エラー
→ `~/.config/gspread/authorized_user.json` を削除して再認証:
```bash
rm ~/.config/gspread/authorized_user.json
```

### Spreadsheetにアクセスできない
→ OAuth認証したGoogleアカウントがSpreadsheetの編集権限を持っているか確認。
