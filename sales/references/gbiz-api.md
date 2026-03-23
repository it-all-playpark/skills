# gBizINFO CLI リファレンス

gBizINFO（経済産業省）の法人公開情報を `gbiz` CLI で取得する。

- 公式: https://info.gbiz.go.jp/
- リポジトリ: `playpark-llc/gbiz-cli`

## セットアップ

```bash
# インストール（~/.cargo/bin/gbiz）
cd ~/ghq/github.com/playpark-llc/gbiz-cli && cargo install --path .

# 認証（環境変数 or --token）
export GBIZ_API_TOKEN=your-api-token
```

トークンは https://info.gbiz.go.jp/api/registration から申請・取得。
`/sales` スキルでは `skill-config.json` の `sales.gbiz_api_token` を `GBIZ_API_TOKEN` として渡す。

## コマンド一覧

### 法人検索

```bash
gbiz search "企業名"
gbiz search "企業名" --limit 5 -o table
gbiz search "企業名" --prefecture 13 --capital-from 1000000 --employee-from 10
```

| オプション | 説明 |
|-----------|------|
| `--prefecture <CODE>` | 都道府県コード |
| `--capital-from/to <N>` | 資本金範囲 |
| `--employee-from/to <N>` | 従業員数範囲 |
| `--limit <N>` | 取得件数 (default: 10, max: 5000) |
| `--page <N>` | ページ (default: 1, max: 10) |

### 法人詳細（全カテゴリ一括）

```bash
gbiz get <法人番号>
```

### カテゴリ別取得

```bash
gbiz finance <法人番号>        # 財務情報（売上、純利益、総資産）
gbiz patent <法人番号>         # 特許・商標
gbiz procurement <法人番号>    # 官公需調達実績
gbiz subsidy <法人番号>        # 補助金情報
gbiz certification <法人番号>  # 届出・認定
gbiz commendation <法人番号>   # 表彰情報
gbiz workplace <法人番号>      # 職場情報（平均年齢、勤続年数、残業、女性比率）
gbiz corporation <法人番号>    # 事業所情報
```

法人番号は13桁の数字。バリデーション付き。

### 出力フォーマット

```bash
gbiz search "企業名" -o json      # 整形済み JSON（デフォルト）
gbiz search "企業名" -o table     # 罫線付きテーブル
gbiz search "企業名" -o compact   # 1行1レコード簡易表示
```

テーブル対応: search, get, finance, subsidy, workplace。その他は JSON フォールバック。

## スキルからの呼び出しパターン

### /sales add（gBizINFO 自動補完）

```bash
gbiz search "企業名" -o json
# → 候補からユーザー選択 → profile.yml に自動補完
```

### /sales info（法人情報表示）

```bash
gbiz get <法人番号> -o json
gbiz finance <法人番号> -o json      # --with-finance 時
gbiz workplace <法人番号> -o json    # --with-workplace 時
```

### /sales lookup（法人検索）

```bash
# 企業名で検索
gbiz search "企業名" --limit 5 -o json

# 法人番号で詳細取得
gbiz get <法人番号> -o json

# カテゴリ指定
gbiz finance <法人番号> -o json
gbiz subsidy <法人番号> -o json
```

### /sales analyze（企業分析）

```bash
gbiz search "企業名" -o json
gbiz subsidy <法人番号> -o json    # 補助金取得履歴 → IT投資積極度判定
```

## レスポンスの主要フィールド

```
hojin-infos[]:
  corporate_number       # 法人番号（13桁）
  name                   # 法人名
  location               # 所在地
  status                 # 法人ステータス
  capital_stock          # 資本金
  employee_number        # 従業員数
  date_of_establishment  # 設立年月日
  business_summary       # 事業概要
  company_url            # 企業HP
  representative_name    # 代表者名
  finance:
    net_sales            # 売上高
    net_income_loss      # 純利益
    total_assets         # 総資産
  workplace_info:
    average_age                          # 平均年齢
    average_continuous_service_years     # 平均勤続年数
```

## 営業活用ポイント

- **商談前リサーチ**: `gbiz get` で資本金・従業員数・事業概要を把握
- **財務分析**: `gbiz finance` で売上・利益推移を確認
- **提案材料**: `gbiz subsidy` で補助金・認定情報から課題感を推測
- **職場環境**: `gbiz workplace` でDX推進度やIT投資余力を推察
