---
name: seed-harvest
description: |
  Harvests blog topic candidates from merged PRs (and feat/fix direct-push commits) across GitHub owners into `seed/_topics/<topic-slug>.json`, bundling same-subject PRs from different repos into one topic, ranks pending topics against external demand sensors (Hatena / Zenn / Qiita / Hacker News / Google Suggest), and builds a <100KB slice from PR bodies and diffs for the chosen topic. No repository is cloned.
  Use when: (1) collecting article topics from recent PRs, (2) choosing a tech-article topic for daily-blog-factory, (3) building a slice for seed-to-blog from a topic, (4) marking a topic as written, (5) keywords like "ネタ収穫", "ネタ帳", "seed更新", "_topics", "harvest", "需要センサー", "技術記事の候補".
  Accepts args: harvest|sense|slice|mark-used [--seed DIR] [...]
---

# Seed Harvest

`seed/_topics/*.json`（ネタ帳）を PR 単位で育て、書くときだけ差分を取る。

## Usage

```bash
python3 scripts/seed_harvest.py <subcommand> [--seed DIR] [...]
```

パスは本 skill ディレクトリ基準。実行時は本 SKILL.md のロード元ディレクトリを前置した絶対パスに解決して呼ぶこと。
gh（`search prs` / `api search/commits` / `pr view` / `pr diff`）と curl（sense のみ）を使う。

## Workflow

```
harvest（毎日） → sense（候補の優先度付け） → slice（選んだ1件だけ） → 執筆 → mark-used
```

| Subcommand | 入力 | 出力 | 主な引数 |
|---|---|---|---|
| `harvest` | 前回実行日以降のマージ済み PR / feat・fix 直 push コミット、任意の `seed/.seed-harvest-config.json` | `seed/_topics/<slug>.json`、`seed/.seed-harvest-state.json` | `--since YYYY-MM-DD` `--owner`（複数可）`--no-commits` `--dry-run` |
| `sense` | `status: pending` のトピック | 各トピックの `demand`、stdout に ranked / unranked | `--topic <slug>` |
| `slice` | 1 トピックの PR / コミット | `seed/_topics/slices/<slug>.md`（100KB 未満） | `<slug>` `--max-kb 1..99`（既定 80）`-o` |
| `mark-used` | トピックと記事 slug | `status: used:<article-slug>` | `<slug> <article-slug>` |

各サブコマンドの手順・フィルタ条件・失敗時の扱い: [references/subcommands.md](references/subcommands.md)
`_topics/*.json` と state ファイルの schema（writer 側が読む契約）: [references/topics-schema.md](references/topics-schema.md)

## 設定ファイル

`<seed>/.seed-harvest-config.json` を harvest が任意で読む（無ければ既定の動作）。

```json
{
  "owners": ["it-all-playpark", "playpark-llc", "Cistree-dev"],
  "client_repos": ["playpark-llc/yeg", "Cistree-dev/*"],
  "exclude": [{"repo": "playpark-llc/corporate-site", "title_regex": "daily-blog-factory|blog-skills"}]
}
```

- `owners`: `--owner` が無いときの既定（`--owner` 優先）
- `client_repos`: 一致する repo を含むトピックに `"client": true` を付ける
- `exclude`: `repo` と `title_regex`（`re.search`）の両方に一致した PR / コミットを除外する

`repo` は `owner/name` か `owner/*`。詳細: [references/subcommands.md](references/subcommands.md#設定ファイル)

設定に関係なく、release-please・main/dev 同期 PR は除外し、`(#N)` / `（#N を dev に）` を除いた title が同じ同 repo の PR / コミットは先にマージされた 1 件にまとめる。

## Invariants

- 需要センサーの取得失敗は `unknown`。0 として扱わない（全センサー失敗なら `score: null` で unranked）
- 直 push コミットを取り切れなかった harvest は exit 1 で `lastRunAt` を進めない（取りこぼしを次回拾うため）
- 不正な設定ファイル（JSON・正規表現・形）は exit 2。黙って無視すると除外したい PR を収穫し、顧客案件の印が落ちる
- `client: true` のトピックの slice は先頭に「実装の詳細を記事に載せない」注記を入れる。harvest は一度付けた `client: true` を下げない
- slice は 100KB（102400 bytes）未満。縮めきれなければ exit 3

## Exit codes

| code | 意味 |
|---|---|
| 0 | 成功 |
| 1 | gh 呼び出し失敗・コミット取得が不完全（harvest / slice） |
| 2 | 引数・入力エラー（不正な slug / `--since` / 設定ファイル、トピックなし） |
| 3 | slice が上限未満に縮まらない |
