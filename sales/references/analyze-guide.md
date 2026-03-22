# /sales analyze — 企業分析 + パーソナライズ返信案

問い合わせ企業の情報を自動収集・分析し、課題仮説とパーソナライズされた返信案を生成する。

## Step 1: 企業情報収集（既存スクリプト）

gBizINFO + HP スクレイピングで基本情報を取得する。

1. gBizINFO 検索:
   ```bash
   scripts/gbiz-lookup.sh --name "企業名"
   ```
   - 法人番号が取得できた場合、補助金取得履歴も取得:
     ```bash
     scripts/gbiz-lookup.sh --number "<法人番号>" --category subsidy
     ```

2. HP URL 特定:
   ```bash
   python3 scripts/find-company-urls.py --company "{slug}"
   ```

3. HP 情報スクレイピング:
   ```bash
   python3 scripts/scrape-company-info.py --company "{slug}"
   ```

## Step 2: 追加情報収集（analyze-prospect.py）

```bash
python3 scripts/analyze-prospect.py --company "企業名" --url "https://..."
```

出力 JSON:
```json
{
  "news": [{"title": "...", "date": "...", "url": "..."}],
  "hiring": {"found": true, "positions": [...], "source_urls": [...]},
  "it_signals": {"found": true, "mentions": [...], "source_urls": [...]}
}
```

## Step 3: AI分析

収集した全データを統合し、レポートを生成する。

### IT投資積極度の判定基準

| 判定 | 条件 |
|------|------|
| **高** | 補助金取得履歴あり + IT関連ニュースあり + DX/情シス求人あり（2つ以上該当） |
| **中** | 上記のいずれか1つに該当 |
| **低** | いずれにも該当しない |

### 課題仮説の推定ルール

- 従業員数・業種・事業概要から組織規模に応じた課題を推定
- 求人情報からIT人材不足・体制構築の課題を推定
- ニュースやIT関連動向から現在の取り組みと未充足領域を推定
- `--inquiry` / `--category` が指定されている場合は、問い合わせ内容を最優先で課題仮説に反映

### 返信案の生成ルール

3パターンを生成する。共通ルール:
- 相手の企業名・事業内容に必ず言及する
- 形式的な挨拶は最小限にし、具体的な話題から入る
- 「弊社は〜」の自己紹介を冒頭に置かない
- 1通あたり200文字以内
- 署名は含めない

**パターンA: 課題仮説ベース（積極的）**
- 推定した課題仮説のうち最も確度が高いものに言及
- 「御社の〇〇という状況であれば、△△が課題になりやすいと考えています」の構文
- 具体的な解決アプローチを1文で示す

**パターンB: 実績ベース（信頼構築）**
- playparkの実績に基づく。以下の事例から業種・規模が近いものを選択:
  - 製造業向け: AI証憑管理システム、業務可視化ダッシュボード
  - 不動産業向け: 動画マニュアル×AI FAQシステム
  - 公共/団体向け: データ基盤構築、レポート自動化
  - 全業種共通: Google Workspace導入支援、社内ポータル構築、kintone連携
- 「同規模の〇〇業のお客様で、△△を実現した事例があります」の構文

**パターンC: 質問ベース（ヒアリング重視）**
- 相手の状況を具体的に聞き出す質問を2-3個含める
- 「現在〇〇はどのように管理されていますか？」の構文
- 問い合わせ内容がある場合はその深掘り質問

## Step 4: 保存とアクション

1. レポートを `companies/{slug}/briefs/analyze-YYYY-MM-DD.md` に保存
2. 企業が未登録の場合は `add` 相当の処理（profile.yml + pipeline.yml 作成）
   - pipeline.yml に `source: contact_form`, `inquiry_category`, `inquiry_email`, `inquiry_content` を記録
3. 既存企業の場合は profile.yml の未充足フィールドを補完
4. 自動デプロイパイプラインを実行

## Step 5: Slack 通知（`--notify`）

slack-cli skill で通知を送信:

```
[新規問い合わせ] {企業名}
従業員数: {N}名 / 資本金: {N}万円 / IT積極度: {高/中/低}
---
課題仮説:
1. {課題1}
2. {課題2}
---
返信案A: {冒頭50文字}...
返信案B: {冒頭50文字}...
返信案C: {冒頭50文字}...
---
詳細: companies/{slug}/briefs/analyze-YYYY-MM-DD.md
```

## 出力フォーマット

```markdown
# 企業分析レポート: {企業名}

## 基本情報
| 項目 | 値 |
|------|-----|
| 法人番号 | {corporate_number} |
| 代表者 | {representative_name} |
| 資本金 | {capital_stock} |
| 従業員数 | {employee_number} |
| 設立 | {date_of_establishment} |
| 事業概要 | {business_summary} |
| HP | {url} |

## IT投資積極度: {高/中/低}
- 補助金取得履歴: {あり/なし}（{補助金名}、{年度}）
- IT関連ニュース: {あり/なし}
- DX/情シス求人: {あり/なし}

## 最新ニュース
1. {タイトル}（{日付}）

## 推定課題仮説
1. {課題1} — {根拠}
2. {課題2} — {根拠}
3. {課題3} — {根拠}

## 初回返信案

### パターンA: 課題仮説ベース（積極的）
> {返信文}

### パターンB: 実績ベース（信頼構築）
> {返信文}

### パターンC: 質問ベース（ヒアリング重視）
> {返信文}
```
