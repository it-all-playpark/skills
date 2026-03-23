# データ構造・設定・共通ロジック

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
│       ├── briefs/           # 企業分析レポート
│       │   └── analyze-YYYY-MM-DD.md
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
> `gbiz` CLI は環境変数 `GBIZ_API_TOKEN` または `--token` オプションで認証。
> skill-config.json の `gbiz_api_token` は `/sales` スキル内で `GBIZ_API_TOKEN` として `gbiz` コマンドに渡される。

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

## 企業検索ロジック

全サブコマンド共通の企業検索:

1. `companies/` 内のディレクトリ名で完全一致を試行
2. 完全一致なし → 部分一致で候補を表示
3. 候補が1件 → 自動選択（ユーザーに確認）
4. 候補が複数 → ユーザーに選択を促す
5. 候補が0件 → エラー（`add` を提案）

## 自動デプロイパイプライン

データ変更を伴うサブコマンド（`add`, `update`, `log`, `followup`, `sync`, `migrate`, `analyze`）の処理完了後、
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
