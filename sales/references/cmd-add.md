# add — 顧客追加

新規企業ディレクトリを作成し、profile.yml + pipeline.yml を生成する。

## 処理フロー

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

## gBizINFO 自動補完

`add` 実行時、gBizINFO APIトークンが設定済みの場合:

1. `gbiz search "企業名" --output json` で法人情報を検索
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
