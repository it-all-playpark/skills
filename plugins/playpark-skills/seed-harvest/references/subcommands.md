# seed-harvest サブコマンド詳細

すべて `--seed DIR`（既定 `seed`）を基点に読み書きする。

## harvest

```bash
python3 scripts/seed_harvest.py harvest [--seed DIR] [--since YYYY-MM-DD] [--owner OWNER ...] [--no-commits] [--dry-run]
```

1. 起点日を決める: `--since` → state の `lastRunAt`（日付部分）→ 30 日前 の順
2. `gh search prs --owner <owner>... --merged-at >=<since> --limit 1000` でマージ済み PR を取る。
   `--owner` 既定は `it-all-playpark` と `playpark-llc`
3. `--no-commits` でなければ、owner ごとに `gh api search/commits`
   （`q=org:<owner> committer-date:>=<since>`、`sort=committer-date`、`order=desc`、`per_page=100`）を
   `total_count` に達するまで page を回して取る。`feat` / `fix` で、subject 末尾が `(#N)`
   （PR の squash）でないものだけ残す。同じ repo・同じ title の PR があればコミット側は捨てる
   - `total_count` が 1000 超（search API の上限）・`incomplete_results: true`・途中で空ページ → exit 1。
     state を書かないので次回も同じ起点から取り直す。`--since` を後ろにずらして分割実行する
4. 除外（`excluded` に数える）:
   - `Merge ` で始まる title
   - bot 作成（renovate / dependabot）、`chore(deps)` / `deps-dev` scope、`Update dependency` / `Update module` / `Bump` 始まり
   - ブログ記事・SNS 告知: scope が `blog` / `sns`（`docs(blog)` / `assets(blog)` / `chore(sns)`）、
     または type が `blog` / `sns`（corporate-site の `blog: ...` 形式）
5. 既に `_topics` のどれかに URL がある PR / コミットは `already_harvested`
6. ネタ候補の理由（1 つもなければ `not_candidate`）:
   - `metrics`: 本文に計測値の行がある（%・ms・秒・倍・円・件・KB/MB/GB・tokens・`$`・`A → B`・before/after・一致率・レイテンシ・コスト）
   - `failure_cause_fix`: title+本文に 失敗系・原因系・対策系 の語がそろう
   - `new_tool`: `feat` で、title の主題語に state の `knownTerms` にない語がある
7. 主題語: title（conventional prefix を除く）の英字トークンのうち大文字を含むもの（`Jev` / `TypeSafe`）。
   stopword（`API` / `Claude` / `README` 等）と小文字だけの識別子は除く
8. 束ね: 候補ごとに主題語を 1 つ選ぶ。優先順は「既存 pending トピックの語」→「多くの repo に出る語」→「出現数」→ 辞書順。
   これで別 repo の同じ道具の PR が 1 トピックに入る。主題語がない候補は `<repo>-<番号>` の単独トピック
9. 同じ主題の pending トピックがあれば追記、なければ新規作成（slug 衝突時は `-<YYYYMMDD>` 付き）
10. `--dry-run` 以外は各トピック JSON と state（`lastRunAt`・`knownTerms`）を書く

stdout: `{since, owners, dry_run, topics[], fetched, excluded, not_candidate, already_harvested, candidates}`

## sense

```bash
python3 scripts/seed_harvest.py sense [--seed DIR] [--topic SLUG]
```

`status: pending` の全トピック（`--topic` 指定時はその 1 件）の `topic` 語を次のセンサーに当てる:

| sensor | 取得先 | hits の意味 |
|---|---|---|
| `hatena` | `b.hatena.ne.jp/hotentry/it.rss` | ホットエントリ中で語を含む項目数 |
| `zenn` | `zenn.dev/feed` | 同上 |
| `qiita` | `qiita.com/popular-items/feed` | 同上 |
| `hn` | `hn.algolia.com/api/v1/search`（直近 30 日の story） | `nbHits` |
| `google_suggest` | `suggestqueries.google.com` | サジェスト中で語を含む候補数 |

- 取得・パース失敗は `{"status": "unknown", "error": ...}`。DOCTYPE / ENTITY を含む feed は parse せず unknown
- `demand.status`: 全センサー ok → `ok`、一部 → `partial`、全滅 → `unknown`（`score: null`）
- `score` は ok センサーの hits 合計。unknown を 0 として足さない
- sandbox では上記ホストが `allowedDomains` に要る。未許可だと全センサー unknown になる

stdout: `{ranked: [{slug, topic, status, score}], unranked: [...]}`。ranked は score 降順。
unranked（score null）は「需要なし」ではなく「分からない」。

## slice

```bash
python3 scripts/seed_harvest.py slice <topic-slug> [--seed DIR] [--max-kb 1..99] [-o PATH]
```

1. トピックの `prs` ごとに `gh pr view <url> --json title,body,comments` と `gh pr diff <url>`、
   `commits` ごとに `gh api repos/<repo>/commits/<sha>`（diff 形式）を取る
2. lockfile（package-lock / pnpm-lock / yarn.lock / Cargo.lock / uv.lock / flake.lock / go.sum 等）の diff は省略表記に置き換える
3. Markdown にまとめ、`min(--max-kb KiB, 102399 bytes)` 未満になるまで縮める。
   縮める順は diff → コメント → 本文。最大のブロックを半分に切り、2KB 以下になったら省略表記にする
4. 既定の出力は `seed/_topics/slices/<slug>.md`

stdout: `{slice_path, topic, bytes, sources, truncated}`。縮めきれなければ exit 3。

## mark-used

```bash
python3 scripts/seed_harvest.py mark-used <topic-slug> <article-slug> [--seed DIR]
```

`status` を `used:<article-slug>` にする。以後 harvest はこのトピックに追記せず、同じ主題語の新しい PR は新しい pending トピックになる。
