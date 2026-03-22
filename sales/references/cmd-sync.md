# sync — Gmail同期

旧 sales-sync の機能。Gmailから営業関連メールを検索し、活動履歴に差分反映。

## Step 1: 現在の状態を把握

`companies/*/pipeline.yml` を全件読み込み、各企業の最終接触日を把握。

## Step 2: Gmail検索

以下のクエリで営業関連メールを取得（`--since` 未指定時は最古の最終接触日以降）:

1. **送信済みフォローメール**: `from:playpark (subject:お礼 OR subject:打ち合わせ OR subject:ご提案) after:YYYY/M/D`
2. **顧客からの返信**: `(to:playpark) (subject:Re:) after:YYYY/M/D`
3. **Google Meet 議事メモ**: `from:gemini-notes@google.com subject:メモ after:YYYY/M/D`
4. **アイドマ週次レポート**: `from:info@member-s.com subject:週次レポート after:YYYY/M/D`
5. **キーパーソンズ通知**: `from:keypersons@aidma-hd.jp after:YYYY/M/D`
6. **確認用メール**: `from:sales@playpark.co.jp subject:確認用 after:YYYY/M/D`

## Step 3: 差分検出

メールの接触日が pipeline.yml の `last_contact` より新しい → 差分あり。

## Step 4: 差分レポート + ユーザー確認

```
=== sales sync 差分レポート ===

[更新対象: 2件]

1. 環境公害センター
   現在: 最終接触日 3/12 | NA: 資料送付
   検知: 3/14 フォローメール送信
   提案: activities に追加 + pipeline 更新

全件更新しますか？ (y/n/個別選択)
```

## Step 5: 反映

承認された企業について `log` サブコマンド相当の処理を実行。
