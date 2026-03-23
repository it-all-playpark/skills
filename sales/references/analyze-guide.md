# /sales analyze — 企業分析 + パーソナライズメール

企業情報を自動収集・分析し、課題仮説とパイプライン状況に応じたメール案を生成する。

## Step 1: 企業情報収集（既存スクリプト）

gBizINFO + HP スクレイピングで基本情報を取得する。

1. gBizINFO 検索:
   ```bash
   gbiz search "企業名" --output json
   ```
   - 法人番号が取得できた場合、補助金取得履歴も取得:
     ```bash
     gbiz subsidy <法人番号> --output json
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

### メール種別の自動判定

`pipeline.yml` の `status` と活動履歴から、メールの種別を自動判定する:

| 種別 | 判定条件 | 目的 |
|------|---------|------|
| **問い合わせ返信** | 未登録企業、または status が空/問い合わせ | 問い合わせへの初回返信 |
| **資料送付フォロー** | status = 「資料送付済」 | 送付済み資料を起点に商談化を促す |
| **御用伺い** | status = 「保留」「アポお断り」、または last_contact から30日以上経過 | 関係維持・再アプローチ |

`--email-type` オプションで手動指定も可能（`inquiry` / `followup` / `checkup`）。

### メール案の生成ルール

**3パターン生成する。メール種別によって文面のトーン・構成が変わる。**

#### 共通ルール（全種別）

- 相手の企業名・事業内容に必ず言及する
- 「弊社は〜」の自己紹介を冒頭に置かない
- 完全なビジネスメール形式で出力する（宛名・本文・URL・結び）
- config の `scheduling_url` を文末に含める（日程調整への導線）
- config の `email_template.signature` を本文末尾に付与する

#### メール構成テンプレート

```
{担当者名}様

{冒頭1文: 種別に応じた導入}

{本文: パターンA/B/Cに応じた内容（3〜5文）}

{クロージング: 次のアクション提案}
下記URLよりご都合のよい日時をお選びいただけますと幸いです。
{scheduling_url}

{config.email_template.closing}

{config.email_template.signature}
```

#### 種別ごとの冒頭・トーン

**問い合わせ返信（inquiry）**
- 冒頭: 「お問い合わせいただきありがとうございます。」
- トーン: 感謝 + 迅速な対応感
- クロージング: 「詳しいお話をお聞かせいただければ、具体的なご提案が可能です。」

**資料送付フォロー（followup）**
- 冒頭: 「先日は資料をご請求いただきありがとうございました。」or「先日お送りした資料はご覧いただけましたでしょうか。」
- トーン: 押しすぎず、相手の関心に寄り添う
- クロージング: 「資料の内容について補足や、御社の状況に合わせた具体例をご紹介できればと思います。」
- 補足: `document_url` がある場合は「資料は下記からもご確認いただけます。\n{document_url}」を本文中に含める

**御用伺い（checkup）**
- 冒頭: 「ご無沙汰しております。」
- トーン: 軽く、押し売り感ゼロ
- クロージング: 「何かお力になれることがあれば、お気軽にお声がけください。」

#### パターンA/B/Cの内容（種別共通）

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

## Step 5: Gmail下書き作成

ユーザーがパターン（A/B/C）を選択後:

1. 設定から `scheduling_url`, `document_url`, `sender_name`, `company_name` を取得
2. 宛先は `profile.yml` の `contacts[0].email`
3. 件名: 種別に応じて自動生成
   - 問い合わせ返信: 「お問い合わせの件【{company_name} {sender_name}】」
   - 資料送付フォロー: 「先日の資料について【{company_name} {sender_name}】」
   - 御用伺い: 「ご状況のお伺い【{company_name} {sender_name}】」
4. Gmail下書き作成:
   ```bash
   scripts/create-draft.sh --to EMAIL --subject SUBJECT --body BODY
   ```
5. `open` コマンドでブラウザで開く

## Step 6: Slack 通知（`--notify`）

slack-cli skill で通知を送信:

```
[企業分析] {企業名}（{メール種別}）
従業員数: {N}名 / 資本金: {N}万円 / IT積極度: {高/中/低}
---
課題仮説:
1. {課題1}
2. {課題2}
---
メール案A: {冒頭50文字}...
メール案B: {冒頭50文字}...
メール案C: {冒頭50文字}...
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

## メール案（種別: {inquiry/followup/checkup}）

### パターンA: 課題仮説ベース（積極的）
**件名**: {件名}

> {完全なメール本文}

### パターンB: 実績ベース（信頼構築）
**件名**: {件名}

> {完全なメール本文}

### パターンC: 質問ベース（ヒアリング重視）
**件名**: {件名}

> {完全なメール本文}

**メール本文のフォーマットルール**:
- blockquote（`>`）形式で記述する
- 1文ごとに `> ` 付きで改行する
- 段落区切りは `>` のみの空行を挟む
- ダッシュボード側で `whitespace-pre-line` により改行保持＋自動折り返しされる
