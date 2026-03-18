# gBizINFO REST API リファレンス

gBizINFO（経済産業省）が提供する法人公開情報API。

- 公式: https://info.gbiz.go.jp/
- Swagger UI: https://api.info.gbiz.go.jp/hojin/swagger-ui/index.html

## 認証

全エンドポイントにヘッダー `X-hojinInfo-api-token` が必要。
トークンは https://info.gbiz.go.jp/api/registration から申請・取得する。

## 使用エンドポイント（v2）

### GET /v2/hojin — 法人検索

| パラメータ | 説明 |
|-----------|------|
| `name` | 企業名（部分一致） |
| `corporate_number` | 法人番号（13桁完全一致） |
| `prefecture` | 都道府県コード |
| `capital_stock_from/to` | 資本金範囲 |
| `employee_number_from/to` | 従業員数範囲 |
| `limit` | 取得件数（max 5000） |
| `page` | ページ（max 10） |

### GET /v2/hojin/{corporate_number} — 法人詳細

法人番号指定で全カテゴリ情報を一括取得。

### カテゴリ別エンドポイント

| カテゴリ | パス | 内容 |
|---------|------|------|
| finance | `/v2/hojin/{no}/finance` | 財務情報（売上、純利益、総資産） |
| patent | `/v2/hojin/{no}/patent` | 特許・商標 |
| procurement | `/v2/hojin/{no}/procurement` | 官公需調達実績 |
| subsidy | `/v2/hojin/{no}/subsidy` | 補助金情報 |
| certification | `/v2/hojin/{no}/certification` | 届出・認定 |
| commendation | `/v2/hojin/{no}/commendation` | 表彰情報 |
| workplace | `/v2/hojin/{no}/workplace` | 職場情報（平均年齢、勤続年数、残業時間、女性比率） |
| corporation | `/v2/hojin/{no}/corporation` | 事業所情報 |

## レスポンスの主要フィールド

```
hojin-infos[]:
  corporate_number    # 法人番号（13桁）
  name                # 法人名
  name_en             # 英語名
  location            # 所在地
  status              # 法人ステータス
  capital_stock       # 資本金
  employee_number     # 従業員数
  date_of_establishment  # 設立年月日
  business_summary    # 事業概要
  company_url         # 企業HP
  representative_name # 代表者名
  business_items[]    # 営業品目
  finance:
    net_sales                    # 売上高
    net_income_loss              # 純利益
    total_assets                 # 総資産
  workplace_info:
    average_age                  # 平均年齢
    average_continuous_service_years  # 平均勤続年数
```

## 営業活用ポイント

- **商談前リサーチ**: 資本金・従業員数・事業概要で企業規模を把握
- **財務分析**: finance カテゴリで売上・利益推移を確認
- **提案材料**: 補助金・認定情報から課題感を推測
- **職場環境**: workplace でDX推進度やIT投資余力を推察
