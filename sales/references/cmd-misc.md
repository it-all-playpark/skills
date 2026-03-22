# その他サブコマンド

## history <企業名> — 活動タイムライン

該当企業の活動ログを時系列で表示 + パイプラインの最新ステータスも表示。

1. `companies/{slug}/pipeline.yml` を読み込み
2. `companies/{slug}/activities/*.md` を日付順でソート
3. テーブル形式で出力

## info <企業名> — 顧客情報表示

profile.yml + pipeline.yml + 活動件数を表示。

gBizINFO APIトークンが設定済み かつ profile.yml に `corporate_number` がある場合:
- `scripts/gbiz-lookup.sh --number <法人番号>` で最新の公開情報も併せて表示
- `--with-finance` で財務情報（売上・利益・総資産）も取得
- `--with-workplace` で職場情報（平均年齢・勤続年数）も取得

## lookup <企業名|法人番号> — gBizINFO 法人情報検索

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

## list — パイプライン一覧

全企業の pipeline.yml を読み込みテーブル表示。

オプション:
- `--status <STATUS>` — ステータスでフィルタ
- `--overdue` — NA期限超過のみ
- `--upcoming N` — 直近N日以内のNAがある企業のみ

## remind — パイプライン停滞レポート

パイプライン全体の健全性をスキャンし、停滞レポート + フォローアップメール案を生成する。

```
/sales remind                              # サマリーのみ
/sales remind --with-email                 # フォローアップメール案も表示
/sales remind --with-email --create-drafts # Gmail下書きまで一括作成
```

`scripts/pipeline-health.sh` で3種類の停滞（期限超過/長期未接触/ステータス停滞）を検知。
詳細な検知ルール・レポートフォーマット・フォローアップメール生成・Gmail下書き作成は [remind-guide.md](remind-guide.md) を参照。

## analyze <企業名> — 企業分析 + パーソナライズ返信案

問い合わせ企業の情報を自動収集・分析し、課題仮説とパーソナライズされた返信案を生成する。

```
/sales analyze <企業名> [--email <メールアドレス>] [--inquiry <問い合わせ内容>] [--category <相談カテゴリ>] [--notify]
```

詳細な処理フロー・判定基準・出力フォーマットは [analyze-guide.md](analyze-guide.md) を参照。

## migrate — Spreadsheetからの移行

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

## dashboard — ダッシュボード手動デプロイ

通常は自動デプロイパイプライン（push → Vercel）で更新されるため不要。
手動でビルド確認したい場合に使用。

1. `cd dashboard && npm run build`
2. ビルド成功を確認
