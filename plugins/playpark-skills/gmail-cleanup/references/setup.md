# gmail-cleanup セットアップ

`create` / `deploy` は Apps Script API を gws 経由で叩く。アカウントごとに次の3つが揃っている必要がある。
どれも人間がブラウザで行う作業なので、足りないときはユーザーに手順を伝える。

## 1. gws のトークンに Apps Script のスコープがある

`script.projects` スコープが無いと push / create が `insufficient authentication scopes` で落ちる。
`--services gmail,drive,script` はスコープ選択画面の候補を絞るだけで、`script.projects` は付かない。
`--scopes` で明示する。既存の権限を落とさないよう、`gws auth status` の `scopes` に
`https://www.googleapis.com/auth/script.projects` を足したものを渡す
（`deploy` / `create` が exit 4 で落ちたときの message に、組み立て済みのコマンドが出る）:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=<gwsConfigDir> gws auth logout
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=<gwsConfigDir> gws auth login --scopes '<今のスコープ>,https://www.googleapis.com/auth/script.projects'
```

- `gwsConfigDir` を使わない target は環境変数なしで同じコマンドを実行する
- スコープ文字列は長いので、コピー時に折り返しの改行が混ざると `Error 400: invalid_scope` になる
## 2. OAuth クライアントの GCP プロジェクトで Apps Script API が有効

`<gwsConfigDir>/client_secret.json` の `project_id` のプロジェクトで、
https://console.cloud.google.com/apis/library/script.googleapis.com を有効にする。

## 3. アカウント側の Apps Script API 設定が ON

アカウントごとに https://script.google.com/home/usersettings で「Google Apps Script API」を ON にする。
OFF のままだと push / create が `User has not enabled the Apps Script API` で落ちる。

## 初回の有効化（エディタで1回だけ）

権限承認とトリガー作成は Google の仕様上エディタでしかできない。`deploy` 後に:

1. https://script.google.com/d/<scriptId>/edit を開き、関数 `dryRun` を実行 → 権限を承認 →
   実行ログで対象件数と件名サンプルを確認（削除はしない）
2. 問題なければ関数 `setup` を実行 → 毎日4時台に `cleanup` が走るトリガーが作られる
3. 初回の溜まり分は1回の実行（約5分で打ち切り）で終わらないことがある。残りは翌日以降に処理される。
   すぐ片付けたい場合は `cleanup` を手で数回実行する

`gas/appsscript.json` の `oauthScopes` を変えたときは、deploy 後にエディタで一度手動実行して再承認する。
