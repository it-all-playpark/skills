---
name: sales
version: 1.0.0
description: "リポジトリベースの統合営業管理スキル。YAML/Markdownで顧客情報・パイプライン・活動履歴を管理し、議事録生成・メール下書き・Gmail同期・ダッシュボードデプロイまでを一元化。gBizINFO APIで法人公開情報を自動取得。
Use when: (1) 営業パイプライン管理, (2) 顧客ステータス更新・確認, (3) 商談履歴・アポ回数の確認, (4) 顧客情報の登録・検索,
(5) 議事録作成・お礼メール, (6) Gmail同期, (7) ダッシュボード更新, (8) 法人情報の調査・企業リサーチ,
(9) keywords: 営業管理, パイプライン, 顧客追加, ステータス更新, NA期限, sales, CRM, 商談管理, フォローアップ, アポ, 活動履歴, 顧客マスタ, 議事録, meeting minutes, followup, お礼メール, dashboard, 法人情報, gBizINFO, 企業調査, 法人番号, 問い合わせ分析, 企業分析, リード分析, prospect, analyze,
(10) meeting-followup, sales-tracker, sales-sync の後継スキル。
Accepts args: <subcommand> [options]
Subcommands: add <企業名>, update <企業名>, log <企業名>, history <企業名>, info <企業名>, lookup <企業名|法人番号>, analyze <企業名>, list [--status STATUS], followup [date], sync [--since DATE], remind, migrate, dashboard"
---

# sales

リポジトリ内のYAML/Markdownで営業パイプラインを管理する統合スキル。
旧 meeting-followup / sales-tracker / sales-sync を統合。

## サブコマンド一覧

| Command | Description | Details |
|---------|-------------|---------|
| `add <企業名>` | 顧客追加（gBizINFO自動補完） | [cmd-add](references/cmd-add.md) |
| `update <企業名>` | パイプライン更新 + 活動ログ自動作成 | [cmd-update-log](references/cmd-update-log.md) |
| `log <企業名>` | 活動ログ追加 + パイプライン自動更新 | [cmd-update-log](references/cmd-update-log.md) |
| `history <企業名>` | 活動タイムライン表示 | [cmd-misc](references/cmd-misc.md) |
| `info <企業名>` | 顧客情報表示（gBizINFO連携） | [cmd-misc](references/cmd-misc.md) |
| `lookup <企業名\|法人番号>` | gBizINFO法人情報検索 | [cmd-misc](references/cmd-misc.md) |
| `list [--status]` | パイプライン一覧 | [cmd-misc](references/cmd-misc.md) |
| `followup [date]` | 議事録 + お礼メール + 活動記録 | [cmd-followup](references/cmd-followup.md) |
| `sync [--since DATE]` | Gmail同期 → 活動履歴に差分反映 | [cmd-sync](references/cmd-sync.md) |
| `remind` | 停滞レポート + フォローアップメール | [remind-guide](references/remind-guide.md) |
| `analyze <企業名>` | 企業分析 + パーソナライズメール（状況自動判定） | [analyze-guide](references/analyze-guide.md) |
| `migrate` | Spreadsheetからの移行 | [cmd-misc](references/cmd-misc.md) |
| `dashboard` | ダッシュボード手動デプロイ | [cmd-misc](references/cmd-misc.md) |

## 自動リマインド

全サブコマンド実行時、処理前に `companies/*/pipeline.yml` をスキャンし、期限超過・直近の予定を警告表示する。
詳細: [data-and-config](references/data-and-config.md#自動リマインド)

## 自動デプロイ

データ変更を伴うサブコマンド完了後、`scripts/auto-deploy.sh` で commit + push → Vercel自動デプロイ。
参照系コマンド（`list`, `history`, `info`, `remind`）では実行しない。
詳細: [data-and-config](references/data-and-config.md#自動デプロイパイプライン)

## スクリプト

- `scripts/load-config.sh` — 設定マージ
- `scripts/get-events.sh` — カレンダーイベント取得
- `scripts/get-gemini-notes.sh` — Geminiメモ取得
- `scripts/create-draft.sh` — Gmail下書き作成
- `scripts/analyze-prospect.py` — 企業追加情報収集（ニュース・求人・IT動向）
- `scripts/pipeline-health.sh` — パイプライン停滞検知（JSON出力）

## リファレンス

- [data-and-config.md](references/data-and-config.md) — データ構造・設定・企業検索・デプロイ・注意事項
- [cmd-add.md](references/cmd-add.md) — add サブコマンド詳細
- [cmd-update-log.md](references/cmd-update-log.md) — update / log サブコマンド詳細
- [cmd-followup.md](references/cmd-followup.md) — followup サブコマンド詳細
- [cmd-sync.md](references/cmd-sync.md) — sync サブコマンド詳細
- [cmd-misc.md](references/cmd-misc.md) — history / info / lookup / list / remind / analyze / migrate / dashboard
- [minutes-template.md](references/minutes-template.md) — 議事録テンプレート
- [gbiz-cli.md](references/gbiz-cli.md) — gBizINFO CLI リファレンス
- [analyze-guide.md](references/analyze-guide.md) — analyze 詳細フロー・判定基準・出力フォーマット
- [remind-guide.md](references/remind-guide.md) — remind 停滞検知ルール・フォローアップ生成・Gmail連携
