---
name: gmail-cleanup
description: >-
  Deploys the shared Gmail auto-cleanup Apps Script (trashes old promotions / blocked mail daily)
  to every Google account listed in the current repo's `gmail-cleanup.json`.
  Use when: (1) user wants unwanted mail trashed automatically, or to add an account to it,
  (2) user changes cleanup queries / protected labels / retention and wants it reflected,
  (3) keywords: gmail-cleanup, メール自動削除, 不要メール, ゴミ箱, プロモーション削除, クリーンアップ, GAS デプロイ.
  Accepts args: [list|deploy|create|logs] [target-id|all]
---

# Gmail Cleanup

Gmail のフィルタは受信時にしか動かず「N日経ったら削除」を表せないので、Apps Script の日次トリガーで行う。
Google 側で動くため Mac の起動は不要。GAS の Gmail 操作は所有アカウントのメールにしか届かないので、
**アカウントごとに Apps Script プロジェクトが1つ**要る。コード (`gas/Code.gs`) はこの skill に1本だけ置き、
アカウントごとの差分は各 repo の `gmail-cleanup.json` に書く。

## 設定 (`<repo>/gmail-cleanup.json`)

```json
{
  "defaults": { "retentionDays": 30, "queries": ["category:promotions"], "protectedLabelPrefixes": ["領収書"] },
  "targets": [
    { "id": "company", "account": "me@example.com", "scriptId": "1Zlw...",
      "gwsConfigDir": "~/.config/gws/accounts/x" }
  ]
}
```

- `defaults` は各 target に下敷きとしてマージされる（配列は target 側で丸ごと置き換え）
- `queries` には `older_than:<retentionDays>d -is:starred` が自動で付く。空クエリ・空配列は拒否される
- `protectedLabelPrefixes` のラベルとその配下（`領収書/2026` など）が付いたスレッドは消さない
- `gwsConfigDir` は任意。gws をアカウント別の設定ディレクトリで使う repo だけ書く
- `retentionDays` は 7 以上

## 実行

repo ルートで bare 名を使う（`gmail-cleanup` は plugin の `bin/` にある）:

```bash
gmail-cleanup list   gmail-cleanup.json             # 設定の検証と一覧
gmail-cleanup deploy gmail-cleanup.json <id|all>    # Code.gs + config.gs を push
gmail-cleanup create gmail-cleanup.json <id>        # scriptId が空の target に新規プロジェクト作成
gmail-cleanup logs   gmail-cleanup.json <id|all> [N] # 直近 N 件(既定10)の実行状態と所要時間
```

- deploy の前に `list` の結果（target ごとのクエリと保護ラベル）をユーザーに見せて確認を取る。
  push は Google 側のプロジェクトのファイルを丸ごと置き換え、翌朝4時台からその条件でゴミ箱へ移す
- `create` は返った `scriptId` を設定 JSON に書いてから `deploy`
- exit 4 は gws の失敗。message に出る `gws auth login ...` をユーザーに伝える（自分では実行しない）
- 「途中で止まる・エラーになる」と言われたら `logs` で状態を見る。`FAILED` / `TIMED_OUT` の本文はエディタの「実行数」にしかない

## 動き

GAS は Gmail API の Advanced Service で ID だけを扱う（1ページ500件の列挙と、1000件ずつの `batchModify`）。
スター付き・`retentionDays` 以内・保護ラベルのメールを1通でも含むスレッドを先に集めて丸ごと除外し、
残りのスレッドのうちクエリに該当するメールをゴミ箱へ移す。除外の収集が時間内に終わらなければ何も消さない。

## 新しいアカウントを足すとき

`create` → `deploy` の後、権限承認とトリガー作成は Google の仕様でエディタでしかできない。
ユーザーに https://script.google.com/d/<scriptId>/edit で `dryRun` → ログ確認 → `setup` を1回ずつ実行してもらう。
前提条件（Apps Script API の有効化・gws のスコープ）は [references/setup.md](references/setup.md)。

## 止めるとき

エディタ左の「トリガー」から `cleanup` を削除する。
