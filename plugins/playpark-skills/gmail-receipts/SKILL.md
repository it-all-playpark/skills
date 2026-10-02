---
name: gmail-receipts
description: >-
  Deploys the shared Gmail receipt-saving Apps Script (saves labeled receipt mail to Drive YYYY/MM daily, then archives it)
  to every Google account listed in the current repo's `gmail-receipts.json`.
  Use when: (1) user wants receipt / invoice mail saved to Drive automatically, or to add an account to it,
  (2) user changes the receipt label / Drive folder / notify address and wants it reflected,
  (3) keywords: gmail-receipts, 領収書 自動保存, 領収書 GAS, 請求書 Drive 保存, getPdfOfReciptFromMails, GAS デプロイ.
  Accepts args: [list|deploy|create|logs] [target-id|all]
---

# Gmail Receipts

Gmail のフィルタで `領収書/<発行元>` ラベルを付けたメールを、Apps Script の日次トリガーで
Drive の `<folderId>/YYYY/MM/` に保存してアーカイブする。Google 側で動くため Mac の起動は不要。
GAS の Gmail 操作は所有アカウントのメールにしか届かないので、**アカウントごとに Apps Script プロジェクトが1つ**要る。
コード (`gas/Code.gs`) はこの skill に1本だけ置き、アカウントごとの差分は各 repo の `gmail-receipts.json` に書く。

## 設定 (`<repo>/gmail-receipts.json`)

```json
{
  "defaults": { "label": "領収書" },
  "targets": [
    { "id": "company", "account": "me@example.com", "scriptId": "1lSL...",
      "folderId": "1xGn...", "notifyEmail": "me@example.com", "gwsConfigDir": "~/.config/gws/accounts/x" }
  ]
}
```

- `defaults` は各 target に下敷きとしてマージされる
- `label` は親ラベル。その配下（`領収書/AWS`、`領収書/AWS/JP`）も対象で、配下の名前が発行元としてファイル名に入る
- `folderId` は保存先 Drive フォルダの ID（URL の `folders/` の後ろ）。`YYYY/MM` は自動で作る
- `notifyEmail` は任意（既定は `account`）。保存したときとエラーのときだけ送る
- `gwsConfigDir` は任意。gws をアカウント別の設定ディレクトリで使う repo だけ書く

## 実行

repo ルートで bare 名を使う（`gmail-receipts` は plugin の `bin/` にある）:

```bash
gmail-receipts list   gmail-receipts.json             # 設定の検証と一覧
gmail-receipts deploy gmail-receipts.json <id|all>    # Code.gs + config.gs を push
gmail-receipts create gmail-receipts.json <id>        # scriptId が空の target に新規プロジェクト作成
gmail-receipts logs   gmail-receipts.json <id|all> [N] # 直近 N 件(既定10)の実行状態と所要時間
```

- deploy の前に `list` の結果（target ごとのラベルと保存先）をユーザーに見せて確認を取る。
  push は Google 側のプロジェクトのファイルを丸ごと置き換える
- `create` は返った `scriptId` を設定 JSON に書いてから `deploy`
- exit 4 は gws の失敗。message に出る `gws auth login ...` をユーザーに伝える（自分では実行しない）
- 「保存されない・エラーメールが来た」と言われたら `logs` で状態を見る。本文はエディタの「実行数」にしかない

## 動き

受信トレイにあって `label`（と配下）が付いたスレッドの各メールを保存する:

- 添付あり → `YYYY-MM-DD_<発行元>_<添付名>`（インライン画像は保存しない）
- 添付なし → 本文を PDF にして `YYYY-MM-DD_<発行元>_<件名>.pdf`
- 日付は受信日（Asia/Tokyo）。親ラベルだけで配下が無いスレッドは `<発行元>_` が付かない

保存したスレッドはアーカイブするので翌日は対象外になる。月フォルダに同名ファイルがあれば保存しない。
4分を超えたら残りのスレッドは翌日に回す。gmail-cleanup の `protectedLabelPrefixes` に `label` を入れておけば、
保存済みメールが自動削除されることはない。

## 既存のプロジェクトをこの skill に載せ替えるとき

手書きの GAS が動いているプロジェクトは、その `scriptId` を設定に書いて `deploy` すれば中身が置き換わる。
旧コードのトリガー（関数名が違う）はそのままだと `関数が見つかりません` で毎日失敗するので、
deploy 後にエディタで `dryRun` → ログ確認 → `setup` を実行する。`setup` はプロジェクトの既存トリガーを全部消して
`collect` の日次トリガー（毎日0時台）を1つ作る。

## 新しいアカウントを足すとき

`create` → `deploy` の後、権限承認とトリガー作成は Google の仕様でエディタでしかできない。
ユーザーに https://script.google.com/d/<scriptId>/edit で `dryRun` → ログ確認 → `setup` を1回ずつ実行してもらう。
前提条件（Apps Script API の有効化・gws のスコープ）は [_shared/references/gas-project-setup.md](../_shared/references/gas-project-setup.md)。

## 止めるとき

エディタ左の「トリガー」から `collect` を削除する。
