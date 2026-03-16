---
name: sales-sync
version: 1.0.0
description: "Gmailを確認して営業パイプラインの変更を検知し、スプレッドシートを自動更新するオーケストレーションスキル。gws CLI（gmail/docs/sheets）+ /sales-tracker を連携させ、メールの送受信履歴・Google Meet議事メモ・アイドマ週次レポートから営業活動の変化を検知→差分分析→sales-tracker log/update で一括反映する。
Use when: (1) Gmailから営業状況の変化を検知してスプレッドシートを更新したい,
(2) keywords: gmail確認, メール確認, 状況確認, sync, 同期, パイプライン同期, gmail sync, 営業メール確認, spreadsheet更新, メールから更新,
(3) 定期的な営業パイプラインの棚卸し・同期。
Accepts args: [--since DATE] [--dry-run] [--company COMPANY]"
---

# sales-sync

Gmailを確認して営業パイプラインの変更を検知し、`/sales-tracker` を使ってスプレッドシートを自動更新する。

## 概要

```
gws gmail CLI (検索・読取)
        ↓
   差分分析エンジン
        ↓
  /sales-tracker log   ← 活動履歴 + パイプライン更新
  /sales-tracker update ← パイプラインのみ更新
```

## 前提

- `gws` CLI が利用可能であること（gmail, docs, sheets サブコマンドを使用）
- `/sales-tracker` スキルが利用可能であること
- `skill-config.json` の `sales-tracker` セクションに `spreadsheet.id` が設定済みであること

## 実行フロー

### Step 1: 現在のスプレッドシート状態を取得

パイプラインと活動履歴の全データを読み取り、各企業の最終接触日・最新活動を把握する。

```bash
gws sheets +read --spreadsheet "<ID>" --range "パイプライン!A:I"
gws sheets +read --spreadsheet "<ID>" --range "活動履歴!A:H"
```

### Step 2: Gmail から営業関連メールを検索

以下のクエリで営業関連メールを取得する。`--since` が指定されていない場合は、パイプライン内の最も古い最終接触日以降を対象とする。

**検索対象:**

1. **送信済みフォローメール**: 顧客企業名・担当者名を含む送信メール
   ```bash
   gws gmail users messages list --params "$(python3 -c "import json; print(json.dumps({'userId': 'me', 'q': 'from:playpark (subject:お礼 OR subject:打ち合わせ OR subject:ご提案 OR subject:ヒアリング OR subject:確認) after:YYYY/M/D'}))")"
   ```

2. **顧客からの返信**: パイプライン内企業のドメインや担当者名で検索
   ```bash
   gws gmail users messages list --params "$(python3 -c "import json; print(json.dumps({'userId': 'me', 'q': '(to:playpark) (subject:Re: OR subject:RE:) after:YYYY/M/D'}))")"
   ```

3. **Google Meet 議事メモ（Gemini）**: 打ち合わせのAI議事録
   ```bash
   gws gmail users messages list --params "$(python3 -c "import json; print(json.dumps({'userId': 'me', 'q': 'from:gemini-notes@google.com subject:メモ after:YYYY/M/D'}))")"
   ```

4. **アイドマ週次レポート**: Sales Crowd のアプローチ結果
   ```bash
   gws gmail users messages list --params "$(python3 -c "import json; print(json.dumps({'userId': 'me', 'q': 'from:info@member-s.com subject:週次レポート after:YYYY/M/D'}))")"
   ```

5. **キーパーソンズ通知**: 新規リード・メッセージ通知
   ```bash
   gws gmail users messages list --params "$(python3 -c "import json; print(json.dumps({'userId': 'me', 'q': 'from:keypersons@aidma-hd.jp after:YYYY/M/D'}))")"
   ```

6. **確認用メール（Sales Crowd自動送信）**: 実際の顧客送信を示す
   ```bash
   gws gmail users messages list --params "$(python3 -c "import json; print(json.dumps({'userId': 'me', 'q': 'from:sales@playpark.co.jp subject:確認用 after:YYYY/M/D'}))")"
   ```

### Step 3: メール内容の分析と差分検出

取得した各メールを `gws gmail` CLI で読み取り、以下を抽出する:

```bash
# メッセージ読取
gws gmail users messages get --params '{"userId": "me", "id": "<MESSAGE_ID>", "format": "full"}'

# スレッド読取
gws gmail users threads get --params '{"userId": "me", "id": "<THREAD_ID>", "format": "full"}'
```

抽出する情報:

- **企業名**: 件名・本文から特定（パイプライン内企業との照合）
- **接触日**: メール送信日
- **種別**: メール内容から判定（フォローアップ、提案、等）
- **アプローチ手法**: メール、電話+メール、等
- **内容サマリー**: メール本文から要約
- **結果**: 返信の有無、内容から判定
- **ネクストアクション**: メール本文内のNA記述から抽出

**Google Meet 議事メモの場合:**
- メール内の `documentId` から Google Docs を取得:
  ```bash
  gws docs documents get --params '{"documentId": "<fileId>"}'
  ```
- Docs 本文からテキストを抽出し、内容・結果・NAを分析

**差分判定ルール:**
各企業について、メールの接触日がスプレッドシートの最終接触日より新しければ「差分あり」と判定する。

### Step 4: 差分レポートの表示とユーザー確認

検出した差分を一覧表示し、ユーザーに更新内容を確認する。

```
=== sales-sync 差分レポート ===

[更新対象: 3件]

1. 株式会社環境公害センター
   現在: 最終接触日 3/12 | NA: 資料送付＋次回日程調整
   検知: 3/14 フォローメール送信（資料URL・日程調整URL送付）
   提案: 最終接触日→3/14 | NA→「資料・日程調整URL送付済。村瀬様の予約待ち」

2. 株式会社マルヤス物流サービス
   現在: 最終接触日 2/17 | アポ回数 1
   検知: 2/25 初回ヒアリング MTG（Geminiメモ検出）
   提案: アポ回数→2 | 最終接触日→2/25 | NA→「資料送付済。板倉氏が社内回覧後に連絡待ち」

3. 株式会社ファミリーデンタルサービス
   現在: 最終接触日 2025/11/19
   検知: 3/12 進捗確認メール送信（架電→不在→メール）
   提案: 最終接触日→3/12 | NA→「筒井様からの返信待ち」

[情報のみ（要確認）]
- キーパーソンズ: 未読メッセージ通知あり（3/13〜3/15）→ key-persons.jp/chat で確認
- アイドマ週次: 資料送付要望1件（企業名不明）→ sales-crowd.jp で確認

全件更新しますか？ (y/n/個別選択)
```

### Step 5: sales-tracker で更新実行

ユーザー承認後、各企業の差分に応じて `/sales-tracker` のサブコマンドを呼び出す:

- **新しい活動（MTG、メール送信等）が検知された場合** → `/sales-tracker log`
  - 活動履歴に新規ログ追加
  - パイプラインのアポ回数・最終接触日・NAを自動更新
- **ステータスやNAのみ変更が必要な場合** → `/sales-tracker update`
  - パイプラインシートのみ更新

**重要:** `/sales-tracker log` を使えばパイプラインと活動履歴の両方が更新される。パイプラインのみの変更でない限り、`log` を優先的に使うこと。

### Step 6: 結果サマリーの表示

更新完了後、結果を一覧表示する。

```
=== sales-sync 完了 ===

更新済み: 3件
- 環境公害センター: log追加（3/14 フォローメール）+ パイプライン更新
- マルヤス物流: log追加（2/25 初回ヒアリング）+ パイプライン更新
- ファミリーデンタル: log追加（3/12 フォローアップ）+ パイプライン更新

要確認: 2件
- キーパーソンズ未読メッセージ → https://www.app.key-persons.jp/chat
- アイドマ資料送付要望1件 → https://sales-crowd.jp/
```

## 引数オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--since DATE` | この日付以降のメールを検索 | パイプライン内の最古の最終接触日 |
| `--dry-run` | 差分レポートのみ表示（更新しない） | false |
| `--company COMPANY` | 特定企業のみ対象（部分一致可） | 全企業 |

## 検知対象外（ノイズフィルタ）

以下のメールは営業活動として検知しない:
- ニュースレター・プロモーション（CATEGORY_PROMOTIONS）
- サービス通知（Vercel, MoneyForward, Amazon等）
- LinkedIn通知
- スペースマーケット等の予約関連
- DRAFTラベルのみのメール（テスト用ドラフト）

## 注意事項

- キーパーソンズの未読メッセージは「通知メール」であり、実際のメッセージ内容はメールに含まれない。プラットフォーム上での確認が必要な旨を報告する。
- アイドマ週次レポートの「資料送付要望」の企業名はメール本文に含まれない場合がある。Sales Crowd での確認を促す。
- Google Meet 議事メモ（Gemini）は自動生成のため、企業名・人名が誤変換されている場合がある（例: 「プレイパーク」→「牛古誠」）。パイプライン内企業名との照合で補正する。
