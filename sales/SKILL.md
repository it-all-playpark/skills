---
name: sales
version: 1.0.0
description: "リポジトリベースの統合営業管理スキル。YAML/Markdownで顧客情報・パイプライン・活動履歴を管理し、議事録生成・メール下書き・Gmail同期・ダッシュボードデプロイまでを一元化。gBizINFO APIで法人公開情報を自動取得。
Use when: (1) 営業パイプライン管理, (2) 顧客ステータス更新・確認, (3) 商談履歴・アポ回数の確認, (4) 顧客情報の登録・検索,
(5) 議事録作成・お礼メール, (6) Gmail同期, (7) ダッシュボード更新, (8) 法人情報の調査・企業リサーチ,
(9) keywords: 営業管理, パイプライン, 顧客追加, ステータス更新, NA期限, sales, CRM, 商談管理, フォローアップ, アポ, 活動履歴, 顧客マスタ, 議事録, meeting minutes, followup, お礼メール, dashboard, 法人情報, gBizINFO, 企業調査, 法人番号,
(10) meeting-followup, sales-tracker, sales-sync の後継スキル。
Accepts args: <subcommand> [options]
Subcommands: add <企業名>, update <企業名>, log <企業名>, history <企業名>, info <企業名>, lookup <企業名|法人番号>, list [--status STATUS], followup [date], sync [--since DATE], remind, migrate, dashboard"
---

# sales

リポジトリ内のYAML/Markdownで営業パイプラインを管理する統合スキル。
旧 meeting-followup / sales-tracker / sales-sync を統合。

## データ構造

```
sales/
├── schema.yml                # フィールド定義（単一真実源）
├── companies/
│   └── {slug}/
│       ├── profile.yml       # 顧客マスタ
│       ├── pipeline.yml      # パイプライン状態
│       ├── activities/       # 活動履歴
│       │   └── YYYY-MM-DD_{type}.md
│       └── minutes/          # 議事録
│           └── YYYY-MM-DD.md
├── templates/                # テンプレート
│   ├── profile.yml
│   ├── pipeline.yml
│   └── activity.md
└── dashboard/                # Next.js（Vercelデプロイ）
```

## 設定

### 設定の優先順位

1. **CLI引数** — 最優先
2. **プロジェクト設定** — `.claude/skill-config.json`（salesリポジトリ）
3. **グローバル設定** — `~/.claude/skill-config.json`

### Config

`skill-config.json` の `sales` セクション:

```json
{
  "sales": {
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
    "remind_days_before": 1,
    "repo_path": "~/ghq/github.com/playpark-llc/sales",
    "gbiz_api_token": "取得したAPIトークン"
  }
}
```

> **gBizINFO APIトークン取得**: https://info.gbiz.go.jp/api/registration から申請。
> 環境変数 `GBIZ_API_TOKEN` でも設定可能（skill-config.json が優先）。

## 自動リマインド

**全サブコマンド実行時**、処理前に期限チェックを行い警告を表示する:

1. `companies/*/pipeline.yml` を全件スキャンする
2. 以下を検出して冒頭に表示:
   - `next_action_deadline` が今日以前 → ⚠ 期限超過
   - `next_action_deadline` が `remind_days_before` 日以内 → ⏰ 直近の予定
3. 表示フォーマット:

```
⚠ 期限超過:
  - 環境公害センター: 見積書送付（期限: 3/15、2日超過）

⏰ 直近の予定:
  - サンユー都市開発: デモ実施（期限: 3/19、あと2日）
```

4. リマインド表示後、元のサブコマンドの処理に進む

## サブコマンド

### `add <企業名>` — 顧客追加

新規企業ディレクトリを作成し、profile.yml + pipeline.yml を生成する。

1. slug化: 「株式会社」「（株）」等を除去した企業通称をディレクトリ名にする
2. `companies/{slug}/` を作成
3. `templates/profile.yml` をコピーし、引数・対話で得た情報を埋める
4. `templates/pipeline.yml` をコピーし、`created_at` に今日の日付、`last_contact` に今日の日付を設定
5. 重複チェック: 既存ディレクトリがあればエラー（部分一致で候補表示）
6. `activities/` と `minutes/` ディレクトリを作成

```
/sales add 環境公害センター --contact "村瀬様" --status "初回ヒアリング済" --next-action "資料送付"
```

引数が不足している場合はLLMがユーザーに対話で確認する。profile.ymlの全項目を埋める必要はない — 分かっている情報だけで良い。

#### gBizINFO 自動補完

`add` 実行時、gBizINFO APIトークンが設定済みの場合:

1. `scripts/gbiz-lookup.sh --name "企業名"` で法人情報を検索
2. 候補が見つかったらユーザーに確認（複数候補の場合は選択）
3. 確認された法人情報で profile.yml を自動補完:
   - `corporate_number` — 法人番号
   - `location` — 所在地
   - `capital_stock` — 資本金
   - `employee_number` — 従業員数
   - `date_of_establishment` — 設立年月日
   - `business_summary` — 事業概要
   - `company_url` — 企業HP
   - `representative_name` — 代表者名
4. `--skip-gbiz` で自動補完をスキップ可能

### `update <企業名>` — パイプライン更新 + 活動ログ

pipeline.yml を更新する。**具体的な営業活動（TEL、メール、訪問等）の記述が含まれる場合は、活動ログも自動作成する。**

1. `companies/` から企業を検索（部分一致）
2. 現在の pipeline.yml を読み込み、変更箇所を特定
3. pipeline.yml を更新
4. **活動ログ判定**: 引数に営業活動の内容（TEL結果、商談結果、メール送信等）が含まれる場合:
   - `activities/YYYY-MM-DD_{type}.md` を作成（`log` サブコマンドと同じフォーマット）
   - typeは活動内容から自動判定（TEL, メール, 訪問, 日程再調整 等）
   - 純粋なステータス変更のみ（例: `--status "失注"`）の場合は活動ログ不要

```
/sales update 環境公害センター --status "提案中" --next-action "見積書作成" --deadline "2026-03-20"
```

### `log <企業名>` — 活動ログ追加（主要サブコマンド）

**活動履歴 + パイプラインの両方を更新する。** 営業活動の記録にはこれを使う。

1. `activities/YYYY-MM-DD_{type}.md` を作成（frontmatter + 内容）
2. pipeline.yml を自動更新:
   - `appointment_count` +1（type が meeting/初回ヒアリング/提案説明/見積説明/クロージングの場合）
   - `last_contact` → 活動日
   - `next_action` / `next_action_deadline` → 引数の値
3. 同日同typeのファイルが既存の場合はサフィックスを付与（`_2`）

```
/sales log 環境公害センター --date "2026-03-20" --type "提案説明" --method "オンライン" \
  --summary "動画×AI証憑管理のデモ実施" --result "具体的な見積依頼あり" \
  --next-action "見積書作成" --deadline "2026-03-25"
```

### `history <企業名>` — 活動タイムライン

該当企業の活動ログを時系列で表示 + パイプラインの最新ステータスも表示。

1. `companies/{slug}/pipeline.yml` を読み込み
2. `companies/{slug}/activities/*.md` を日付順でソート
3. テーブル形式で出力

### `info <企業名>` — 顧客情報表示

profile.yml + pipeline.yml + 活動件数を表示。

gBizINFO APIトークンが設定済み かつ profile.yml に `corporate_number` がある場合:
- `scripts/gbiz-lookup.sh --number <法人番号>` で最新の公開情報も併せて表示
- `--with-finance` で財務情報（売上・利益・総資産）も取得
- `--with-workplace` で職場情報（平均年齢・勤続年数）も取得

### `lookup <企業名|法人番号>` — gBizINFO 法人情報検索

gBizINFO APIで法人の公開情報を検索・表示する。パイプラインへの登録は行わない。

```
/sales lookup 環境公害センター
/sales lookup 1234567890123
/sales lookup 環境公害センター --category finance
```

1. 引数が13桁の数字 → 法人番号として詳細取得:
   ```bash
   scripts/gbiz-lookup.sh --number "1234567890123"
   ```
2. それ以外 → 企業名として検索:
   ```bash
   scripts/gbiz-lookup.sh --name "企業名" --limit 5
   ```
3. 結果を整形して表示:
   - 法人番号、法人名、所在地、資本金、従業員数、設立年月日、事業概要、企業HP、代表者名
4. オプション:
   - `--category finance|patent|procurement|subsidy|certification|workplace` — カテゴリ別詳細
   - `--limit N` — 検索結果の件数上限（デフォルト: 5）
5. 既存 `companies/` に該当企業がある場合は「登録済み」表示 + `info` へのリンクを案内

### `list` — パイプライン一覧

全企業の pipeline.yml を読み込みテーブル表示。

オプション:
- `--status <STATUS>` — ステータスでフィルタ
- `--overdue` — NA期限超過のみ
- `--upcoming N` — 直近N日以内のNAがある企業のみ

### `followup [date]` — 議事録 + メール下書き

旧 meeting-followup の機能。カレンダーイベント → 議事録 → お礼メール → 活動記録。

#### Step 1: イベント取得

```bash
scripts/get-events.sh <date> [--event-index N]
```

- 日付: `today`, `yesterday`, `YYYY-MM-DD`, `MM/DD`, `M月D日`
- 複数イベント → LLMが一覧表示しユーザーに選択を促す

#### Step 2: Geminiメモ取得

```bash
scripts/get-gemini-notes.sh <file-id>
```

イベントの添付Google Docsからテキスト取得。添付がなければカレンダー情報のみで進行。

#### Step 3: 議事録生成（`--skip-minutes` でスキップ可）

`references/minutes-template.md` に従いLLMが議事録を生成。

**保存先:** `companies/{slug}/minutes/YYYY-MM-DD.md`
- 企業ディレクトリが存在しない場合 → `add` サブコマンド相当の処理で自動作成

#### Step 4: お礼メール下書き作成（`--skip-email` でスキップ可）

1. 設定から scheduling_url, document_url, meeting_url, sender_name, company_name を取得
2. 宛先メールアドレスはイベントの description から抽出
3. LLMが本文を構成（挨拶、内容言及、資料URL、日程調整URL、結び）
4. Gmail下書き作成:
   ```bash
   scripts/create-draft.sh --to EMAIL --subject SUBJECT --body BODY
   ```
5. `open` コマンドでブラウザで開く

#### Step 5: 活動記録

議事録から情報を抽出し、`log` サブコマンド相当の処理を実行:
- `activities/YYYY-MM-DD_meeting.md` を作成
- pipeline.yml を更新（アポ回数+1、最終接触日、NA）

### `sync [--since DATE]` — Gmail同期

旧 sales-sync の機能。Gmailから営業関連メールを検索し、活動履歴に差分反映。

#### Step 1: 現在の状態を把握

`companies/*/pipeline.yml` を全件読み込み、各企業の最終接触日を把握。

#### Step 2: Gmail検索

以下のクエリで営業関連メールを取得（`--since` 未指定時は最古の最終接触日以降）:

1. **送信済みフォローメール**: `from:playpark (subject:お礼 OR subject:打ち合わせ OR subject:ご提案) after:YYYY/M/D`
2. **顧客からの返信**: `(to:playpark) (subject:Re:) after:YYYY/M/D`
3. **Google Meet 議事メモ**: `from:gemini-notes@google.com subject:メモ after:YYYY/M/D`
4. **アイドマ週次レポート**: `from:info@member-s.com subject:週次レポート after:YYYY/M/D`
5. **キーパーソンズ通知**: `from:keypersons@aidma-hd.jp after:YYYY/M/D`
6. **確認用メール**: `from:sales@playpark.co.jp subject:確認用 after:YYYY/M/D`

#### Step 3: 差分検出

メールの接触日が pipeline.yml の `last_contact` より新しい → 差分あり。

#### Step 4: 差分レポート + ユーザー確認

```
=== sales sync 差分レポート ===

[更新対象: 2件]

1. 環境公害センター
   現在: 最終接触日 3/12 | NA: 資料送付
   検知: 3/14 フォローメール送信
   提案: activities に追加 + pipeline 更新

全件更新しますか？ (y/n/個別選択)
```

#### Step 5: 反映

承認された企業について `log` サブコマンド相当の処理を実行。

### `remind` — リマインド表示

自動リマインドと同じ内容を明示的に表示。`--dry-run` 相当。

### `migrate` — Spreadsheetからの移行

既存Google Spreadsheetのデータをリポジトリに移行する。

1. gws CLI で3シート全データ取得:
   ```bash
   gws sheets +read --spreadsheet "<ID>" --range "パイプライン!A:I"
   gws sheets +read --spreadsheet "<ID>" --range "顧客マスタ!A:V"
   gws sheets +read --spreadsheet "<ID>" --range "活動履歴!A:H"
   ```
2. 企業ごとにディレクトリ作成
3. 顧客マスタ → profile.yml（schema.yml のフィールドにマッピング）
4. パイプライン → pipeline.yml
5. 活動履歴 → activities/*.md
6. 既存 `minutes/` のファイルを企業名で照合し `companies/{slug}/minutes/` に移動
7. 移行内容をプレビュー表示し、ユーザー確認後に実行

### `dashboard` — ダッシュボード手動デプロイ

通常は自動デプロイパイプライン（push → Vercel）で更新されるため不要。
手動でビルド確認したい場合に使用。

1. `cd dashboard && npm run build`
2. ビルド成功を確認

## 企業検索ロジック

全サブコマンド共通の企業検索:

1. `companies/` 内のディレクトリ名で完全一致を試行
2. 完全一致なし → 部分一致で候補を表示
3. 候補が1件 → 自動選択（ユーザーに確認）
4. 候補が複数 → ユーザーに選択を促す
5. 候補が0件 → エラー（`add` を提案）

## スクリプト

既存の meeting-followup スクリプトを再利用:

- `scripts/load-config.sh` — 設定マージ
- `scripts/get-events.sh` — カレンダーイベント取得
- `scripts/get-gemini-notes.sh` — Geminiメモ取得
- `scripts/create-draft.sh` — Gmail下書き作成
- `scripts/gbiz-lookup.sh` — gBizINFO API 法人情報取得

## リファレンス

- `references/minutes-template.md` — 議事録テンプレート
- `references/gbiz-api.md` — gBizINFO REST API リファレンス

## 自動デプロイパイプライン

データ変更を伴うサブコマンド（`add`, `update`, `log`, `followup`, `sync`, `migrate`）の処理完了後、
自動で `scripts/auto-deploy.sh` を実行する。

```bash
cd "$REPO_PATH" && bash scripts/auto-deploy.sh
```

このスクリプトは:
1. 変更がなければスキップ
2. `dashboard/` のビルドテスト（失敗したら中断）
3. 変更ファイルを commit
4. push → Vercel Git Integration が自動デプロイ

**参照系コマンド**（`list`, `history`, `info`, `remind`）では実行しない。

## 注意事項

- データはすべてリポジトリ内のファイル。外部DB/Spreadsheet依存なし（migrate以外）
- schema.yml がフィールド定義の真実源。項目追加・変更は schema.yml → templates/ の順で更新
- ダッシュボードは SSG（Static Site Generation）。companies/ のデータをビルド時に読み込む
