---
name: meeting-followup
version: 1.0.0
description: "Google Calendarのアポ情報取得 → Geminiメモ（Google Docs）読み取り → 営業議事録生成 → お礼メール下書き作成を一気通貫で実行するスキル。
Use when: (1) 打ち合わせ・アポの議事録を作りたい, (2) アポ後のお礼メールを作成したい,
(3) keywords: 議事録, meeting minutes, followup, フォローアップ, お礼メール, アポまとめ, 打ち合わせまとめ, MTG議事録,
(4) Google CalendarのイベントからGeminiメモを取得して整理したい場合。
Accepts args: <date|today|yesterday> [--event-index N] [--skip-email] [--skip-minutes] [--scheduling-url URL] [--document-url URL] [--meeting-url URL]"
---

# meeting-followup

Google Calendarのアポ情報を起点に、議事録生成とお礼メール下書き作成を自動化する。

## 設定

### 設定の優先順位

1. **CLI引数**（`--scheduling-url` 等） — 最優先
2. **プロジェクト設定** — `.claude/skill-config.json`（プロジェクトルート）
3. **グローバル設定** — `~/.claude/skill-config.json`

`skill-config.json` の `meeting-followup` セクションを参照する。グローバル → プロジェクトの順でディープマージ（プロジェクトが勝つ）。CLI引数があればさらに上書きする。

### Config

`skill-config.json` の `meeting-followup` セクション:

```json
{
  "meeting-followup": {
    "defaults": {
      "scheduling_url": "https://...",
      "document_url": "https://...",
      "meeting_url": "https://...",
      "sender_name": "奈良本",
      "company_name": "プレイパーク"
    },
    "email_template": {
      "subject": "本日のお打ち合わせのお礼【{{company_name}} {{sender_name}}】",
      "closing": "引き続き、どうぞよろしくお願いいたします。"
    },
    "minutes": {
      "output_dir": "claudedocs/minutes"
    }
  }
}
```

| キー | 説明 | デフォルト |
|------|------|-----------|
| `defaults.scheduling_url` | 日程調整URL | — |
| `defaults.document_url` | 資料URL | — |
| `defaults.meeting_url` | Web会議URL | — |
| `defaults.sender_name` | 送信者名 | — |
| `defaults.company_name` | 自社名 | — |
| `email_template.subject` | メール件名テンプレート | — |
| `email_template.closing` | メール結び文 | — |
| `minutes.output_dir` | 議事録保存ディレクトリ | `claudedocs/minutes` |

## ワークフロー

### Step 0: 設定読み込み

1. `~/.claude/skill-config.json` の `meeting-followup` セクションを読み込む（グローバル）
2. プロジェクトルートの `.claude/skill-config.json` があればディープマージ（プロジェクトが勝つ）
3. CLI引数（`--scheduling-url` 等）があればさらに上書き

### Step 1: イベント取得

1. 引数の日付を解釈する（`today`, `yesterday`, `YYYY-MM-DD`, `MM/DD`, `M月D日` など）
2. `mcp__claude_ai_Google_Calendar__gcal_list_events` で該当日のイベントを取得（`condenseEventDetails=false`、`timeZone=Asia/Tokyo`）
3. 複数イベントがある場合:
   - `--event-index` 指定あり → そのインデックスのイベントを選択
   - 指定なし → イベント一覧を表示し、ユーザーに選択を促す
4. 終日イベントや「総会」「懇親会」など非商談イベントは一覧に含めるが、自動選択はしない

### Step 2: Geminiメモ取得

1. 選択したイベントの `attachments` から Google Docs のリンクを探す（`mimeType` が `application/vnd.google-apps.document`）
2. 添付がある場合:
   - `fileId` を抽出
   - `gws docs documents get --params '{"documentId": "<fileId>"}'` でドキュメントを取得
   - トークンキャッシュが古い場合は `rip ~/.config/gws/token_cache.json` してリトライ
   - JSONレスポンスからテキストを抽出する（paragraph要素の `textRun.content`, `dateElement.displayText`, `richLink.richLinkProperties.title` を結合）
3. 添付がない場合: カレンダー情報のみで進行し、ユーザーに通知する

### Step 3: 議事録生成（`--skip-minutes` でスキップ可）

`references/minutes-template.md` のフォーマットとペルソナ指示に従い、議事録を生成する。

**情報ソース優先度:**
1. Geminiメモの内容（最優先）
2. カレンダーイベントの description フィールド
3. カレンダーイベントの基本情報（日時、場所、参加者）

情報が取れない項目は「未確認」と明示する。事実と推測は分離し、推測には《推測》タグを付ける。

**保存先:** `{minutes.output_dir}/YYYY-MM-DD_顧客企業名.md`（デフォルト: `claudedocs/minutes/`）
- 保存先は設定の `minutes.output_dir` で変更可能
- ディレクトリが存在しない場合は作成する
- 顧客企業名はイベントタイトルやGeminiメモから推定する

### Step 4: お礼メール下書き作成（`--skip-email` でスキップ可）

1. 設定ファイルまたは引数から以下を取得:
   - `scheduling_url`: 日程調整URL
   - `document_url`: 資料URL
   - `meeting_url`: 次回MTG用のWeb会議URL
   - `sender_name`: 送信者名
   - `company_name`: 自社名
2. 宛先メールアドレスはイベントの description から抽出する（`Email :` フィールドなど）
3. 件名は設定ファイルの `email_template.subject` テンプレートを使用
4. 本文の構成:
   - 宛名（先方の名前 + 様）
   - 挨拶と御礼
   - 打ち合わせ内容への言及（議事録の要約から2〜3行）
   - 資料URL（`document_url` がある場合）
   - 日程調整URL（`scheduling_url` がある場合）
   - Web会議URL（`meeting_url` がある場合、「次回のお打ち合わせは下記URLよりご参加ください」等）
   - 結び
   - **署名は入れない**（Gmail側で自動付与されるため）
5. `mcp__claude_ai_Gmail__gmail_create_draft` で下書きを作成
6. 作成されたGmail下書きのURLを `open` コマンドでブラウザで開く
7. ユーザーにGmail下書きのURLも合わせて報告する

### Step 5: sales-tracker 連携

Step 3（議事録）と Step 4（メール）の完了後、`/sales-tracker` スキルを呼び出して営業パイプラインを更新する。

1. 議事録から以下を抽出:
   - 顧客企業名
   - 担当者名・メールアドレス
   - 種別（初回ヒアリング、提案説明、等）
   - 議題・内容サマリー（議事録セクション1の要約）
   - 結果（議事録セクション2の結論）
   - ネクストアクション（議事録セクション2の【Next Action】）
   - 議事録ファイルパス
2. `/sales-tracker` のパイプラインシートで該当企業を検索
   - 存在しない → `add`（新規顧客としてパイプライン + 活動履歴に追加）
   - 存在する → `log`（活動履歴にログ追加 + パイプラインのアポ回数・最終接触日・NA等を自動更新）
3. 更新/追加内容をユーザーに確認してから実行する

## 出力

実行完了時に以下を報告:
- 議事録ファイルのパス（生成した場合）
- Gmail下書きのURL（作成した場合）
- sales-tracker の更新内容（追加/更新した場合）
- 未確認項目や手動対応が必要な事項のリスト
