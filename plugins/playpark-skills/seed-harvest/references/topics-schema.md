# `seed/_topics` schema

writer（daily-blog-factory / seed-to-blog）はこの形を前提に読む。フィールド追加は後方互換、既存フィールドの意味変更は writer 側と同時に直す。

## `seed/_topics/<topic-slug>.json`

ネタ 1 件 = 1 ファイル。

```json
{
  "topic": "Jev",
  "slug": "jev",
  "status": "pending",
  "terms": ["Jev", "TypeSafe"],
  "repos": ["it-all-playpark/dotfiles", "it-all-playpark/skills", "playpark-llc/corporate-site"],
  "prs": [
    {
      "repo": "it-all-playpark/skills",
      "number": 728,
      "url": "https://github.com/it-all-playpark/skills/pull/728",
      "title": "feat: dev-flow prerun の Jev 判定が ...",
      "mergedAt": "2026-09-24T03:00:00Z",
      "reasons": ["metrics", "new_tool"]
    }
  ],
  "commits": [
    {
      "repo": "it-all-playpark/dotfiles",
      "sha": "0123abcd...",
      "url": "https://github.com/it-all-playpark/dotfiles/commit/0123abcd...",
      "title": "feat: ...",
      "mergedAt": "2026-09-21T10:00:00Z",
      "reasons": ["new_tool"]
    }
  ],
  "points": ["it-all-playpark/skills: feat: ... — 本文の最初の要点行"],
  "metrics": ["一致率 92% → 97%"],
  "demand": {
    "status": "partial",
    "score": 12,
    "checkedAt": "2026-09-26T00:00:00Z",
    "sensors": {
      "hatena": {"status": "ok", "hits": 1},
      "zenn": {"status": "unknown", "error": "curl exit 6: ..."},
      "qiita": {"status": "ok", "hits": 0},
      "hn": {"status": "ok", "hits": 11},
      "google_suggest": {"status": "ok", "hits": 0}
    }
  },
  "createdAt": "2026-09-26T00:00:00Z",
  "updatedAt": "2026-09-26T00:00:00Z"
}
```

| field | 型 | 意味 |
|---|---|---|
| `topic` | string | 主題語（束ねのキー）。sense はこの語でセンサーを引く |
| `slug` | string | `^[a-z0-9][a-z0-9-]*$`。ファイル名と一致 |
| `status` | `"pending"` \| `"used:<article-slug>"` | 記事化済みかどうか。記事化の管理は PR URL とこの status で行う |
| `terms` | string[] | 収録 PR / コミットの title から取った主題語の和集合 |
| `repos` | string[] | `owner/repo`、昇順 |
| `prs` | object[] | マージ済み PR。`number` を持つ |
| `commits` | object[] | 直 push の feat / fix コミット。`sha` を持つ |
| `prs[].reasons` / `commits[].reasons` | (`"metrics"` \| `"failure_cause_fix"` \| `"new_tool"`)[] | 候補に残った理由 |
| `points` | string[] | `<repo>: <title> — <本文の最初の要点行>` |
| `metrics` | string[] | 本文から拾った計測値の行（最大 20） |
| `demand` | object \| null | sense 前は `null` |
| `demand.status` | `"ok"` \| `"partial"` \| `"unknown"` | センサーの応答状況 |
| `demand.score` | integer \| null | ok センサーの hits 合計。全センサー失敗なら `null`（0 ではない） |
| `demand.sensors.<name>` | `{status:"ok",hits:int}` \| `{status:"unknown",error:string}` | センサー別の結果 |
| `createdAt` / `updatedAt` | string | UTC `YYYY-MM-DDTHH:MM:SSZ` |

writer がトピックを選ぶときは `status == "pending"` のものから、`demand.score` 降順（`null` は末尾で「不明」扱い）で見る。

## `seed/_topics/slices/<topic-slug>.md`

slice の出力。`# Topic: <topic>` の後に PR / コミットごとの `## <repo>#<n>: <title>` セクション（URL・Body・Comments・Diff）が並ぶ。常に 102400 bytes 未満。

## `seed/.seed-harvest-state.json`

```json
{"lastRunAt": "2026-09-26T00:00:00Z", "knownTerms": ["jev", "typesafe"]}
```

| field | 意味 |
|---|---|
| `lastRunAt` | 前回成功した harvest の時刻。次回はこの日付以降を取る。取得が不完全な run では更新されない |
| `knownTerms` | これまでに見た主題語（小文字）。`new_tool` 判定で「新出」かどうかに使う |
