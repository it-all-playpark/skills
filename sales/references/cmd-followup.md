# followup — 議事録 + メール下書き

旧 meeting-followup の機能。カレンダーイベント → 議事録 → お礼メール → 活動記録。

## Step 1: イベント取得

```bash
scripts/get-events.sh <date> [--event-index N]
```

- 日付: `today`, `yesterday`, `YYYY-MM-DD`, `MM/DD`, `M月D日`
- 複数イベント → LLMが一覧表示しユーザーに選択を促す

## Step 2: Geminiメモ取得

```bash
scripts/get-gemini-notes.sh <file-id>
```

イベントの添付Google Docsからテキスト取得。添付がなければカレンダー情報のみで進行。

## Step 3: 議事録生成（`--skip-minutes` でスキップ可）

[minutes-template.md](minutes-template.md) に従いLLMが議事録を生成。

**保存先:** `companies/{slug}/minutes/YYYY-MM-DD.md`
- 企業ディレクトリが存在しない場合 → `add` サブコマンド相当の処理で自動作成

## Step 4: お礼メール下書き作成（`--skip-email` でスキップ可）

1. 設定から scheduling_url, document_url, meeting_url, sender_name, company_name を取得
2. 宛先メールアドレスはイベントの description から抽出
3. LLMが本文を構成（挨拶、内容言及、資料URL、日程調整URL、結び）
4. Gmail下書き作成:
   ```bash
   scripts/create-draft.sh --to EMAIL --subject SUBJECT --body BODY
   ```
5. `open` コマンドでブラウザで開く

## Step 5: 活動記録

議事録から情報を抽出し、`log` サブコマンド相当の処理を実行:
- `activities/YYYY-MM-DD_meeting.md` を作成
- pipeline.yml を更新（アポ回数+1、最終接触日、NA）
