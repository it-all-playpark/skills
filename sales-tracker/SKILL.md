---
name: sales-tracker
version: 3.0.0
description: "Google Spreadsheetで営業パイプラインを管理するスキル。3シート構成（パイプライン/顧客マスタ/活動履歴）で顧客情報・商談ステータス・活動ログを一元管理。NA期限切れをSlackで通知。meeting-followupスキルと連携し、商談後のステータス・履歴を自動更新。Sales Crowdからのデータインポートにも対応。
Use when: (1) 営業パイプライン管理, (2) 顧客ステータス更新・確認, (3) 商談履歴・アポ回数の確認, (4) 顧客情報の登録・検索,
(5) keywords: 営業管理, パイプライン, 顧客追加, ステータス更新, NA期限, sales tracker, CRM, 商談管理, フォローアップ管理, アポ回数, 活動履歴, 顧客マスタ, 顧客情報,
(6) meeting-followup実行後の商談情報記録。
Accepts args: <subcommand> [options]
Subcommands: add <企業名>, update <企業名>, log <企業名>, history <企業名>, info <企業名>, list [--status STATUS], remind [--dry-run], import, init"
---

# sales-tracker

Google Spreadsheetで営業パイプラインを管理する。3シート構成で顧客サマリー・企業情報・活動履歴を一元管理する。

## シート構成

### パイプライン（シート1）
| 企業名 | 担当者名 | アポ回数 | ステータス | セールスフェーズ | 最終接触日 | NA | NA期限 | NA予定者 |

### 顧客マスタ（シート2）
| 企業名 | 電話番号 | メールアドレス | 部署・拠点名 | 担当者名 | 担当者名カナ | 役職 | FAX番号 | 郵便番号 | 住所 | 企業HP URL | 設立年月日 | 上場区分 | 従業員数 | 業種1 | 業種2 | 業種3 | 資本金 | 売上高 | 決算期 | リード取得元 | アプローチリスト名称 |

### 活動履歴（シート3）
| 企業名 | 日付 | 種別 | アプローチ手法 | 議題・内容サマリー | 結果 | NA | 議事録リンク |

**種別:** 初回ヒアリング、提案説明、見積説明、クロージング、フォローアップ、架電、メール
**手法:** オンライン、対面、メール、電話

## 前提

- `gws` CLI（Google Sheets API）— 操作パターンは `references/gws-sheets-patterns.md` を参照
- `/slack-cli` スキル（リマインド通知用）
- 設定: `skill-config.json` の `sales-tracker` セクション

## 設定読み込み

1. `~/.claude/skill-config.json` の `sales-tracker` セクション（グローバル）
2. プロジェクトルートの `.claude/skill-config.json` があればディープマージ（プロジェクトが勝つ）

## サブコマンド

### `init` — スプレッドシート初期化

初回のみ。3シート作成 + ヘッダー行設定。config に `spreadsheet.id` がなければ新規作成。

### `add <企業名>` — 顧客追加

3シートに新規顧客を追加。重複チェック（企業名照合）あり。

1. パイプラインに追加（アポ回数: 1）
2. 顧客マスタに企業情報を追加
3. 活動履歴に初回ログを追加

```
/sales-tracker add 株式会社環境公害センター \
  --contact "村瀬様" --status "初回ヒアリング済" \
  --next-action "資料送付＋次回日程調整" --deadline "2026-03-15"
```

### `update <企業名>` — パイプライン更新

**パイプラインシートのみ** を更新する。活動履歴も追加したい場合は `log` を使うこと。

更新可能: ステータス、セールスフェーズ、NA、NA期限、NA予定者、最終接触日

```
/sales-tracker update 環境公害センター \
  --status "提案中" --next-action "見積書作成" --deadline "2026-03-20"
```

### `log <企業名>` — 活動ログ追加（主要サブコマンド）

**活動履歴 + パイプラインの両方を更新する。** 営業活動の記録にはこれを使う。

1. 活動履歴にログ追加（`values update` + 明示的行番号指定。`append` は使わない）
2. パイプラインを自動更新: アポ回数 +1、最終接触日、NA・NA期限

```
/sales-tracker log 環境公害センター \
  --date "2026-03-20" --type "提案説明" --method "オンライン" \
  --summary "動画×AI証憑管理のデモ実施" --result "具体的な見積依頼あり" \
  --next-action "見積書作成"
```

### `history <企業名>` — 活動履歴表示

該当企業の活動ログを時系列で表示 + パイプラインの最新ステータスも表示。

### `info <企業名>` — 顧客情報表示

顧客マスタから企業の詳細情報を表示。パイプラインのステータスと活動履歴件数も併記。

### `list` — パイプライン一覧

全パイプラインをテーブル形式で表示。フィルタ: `--status`, `--overdue`, `--upcoming N`

### `remind` — NA期限リマインド

期限切れ/接近案件を `/slack-cli` でSlack通知。`--dry-run` で表示のみ。

### `import` — Sales Crowdデータインポート

Sales CrowdエクスポートデータをTSV/CSVパース → 3シートに一括登録。重複チェック + プレビュー確認あり。

## meeting-followup との連携

`meeting-followup` 完了後、議事録から企業名・内容・NAを引き継ぎ:
- 企業が **存在しない** → `add`
- 企業が **存在する** → `log`

## Config

```json
{
  "sales-tracker": {
    "spreadsheet": {
      "id": "...",
      "name": "営業パイプライン管理",
      "sheets": { "pipeline": "パイプライン", "customer": "顧客マスタ", "activity": "活動履歴" }
    },
    "pipeline_columns": ["企業名", "担当者名", "アポ回数", "..."],
    "customer_columns": ["企業名", "電話番号", "..."],
    "activity_columns": ["企業名", "日付", "種別", "..."],
    "statuses": ["初回ヒアリング済", "提案中", "見積提出", "クロージング", "受注", "失注"],
    "slack": { "workspace": "playpark", "channel": "sales", "remind_days_before": 1 }
  }
}
```
