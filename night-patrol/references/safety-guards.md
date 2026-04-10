# Night Patrol Safety Guards

## ガード一覧

### 1. 破壊的変更検出 (triage)

LLM がissue内容と推定ファイルから判定。以下を breaking change と見なす:

- public API の signature 変更（関数名、引数、戻り値型の変更）
- DB migration ファイルの作成・変更
- package.json の major version bump
- 設定ファイルのスキーマ変更

### 2. 1issue変更行数上限 (triage + execute)

- triage 段階: LLM の推定行数が `max_lines_per_issue` (default: 500) を超える場合スキップ
- execute 後: `git diff --stat` の実測値でも再チェック

### 3. denylist パス (triage)

`denylist_paths` のglob パターンにマッチするファイルを含むissueをスキップ。
デフォルト: `.env*`, `*.secret`, `migrations/`

### 4. denylist ラベル (triage)

`denylist_labels` に含まれるラベルが付いたissueをスキップ。
デフォルト: `do-not-autofix`, `needs-discussion`

### 5. denylist issue番号 (scan)

`denylist_issues` に含まれるissue番号を scan 段階で除外。
ユーザーが手動で対応したいissueを指定。

### 6. 累積変更量上限 (execute)

バッチ実行前に `cumulative_lines_changed` が `max_cumulative_lines` (default: 2000) を超えていたら
残りのバッチを全てスキップ。nightly ブランチの差分が大きくなりすぎることを防ぐ。

### 7. 失敗ループ検出 (execute)

同一 issue が execute phase で **閾値回連続失敗** したら `patrol-stuck` label を付与して triage に差し戻し、以降の巡回 run ではスキップする。無限 retry を防ぐための escalation guard。

- 永続ストア: `~/.claude/night-patrol/failures.json`
  (env `NIGHT_PATROL_FAILURES_PATH` で上書き可)
- 閾値: `skill-config.json[night-patrol].max_failures` (default: 2)
- ラベル名: `skill-config.json[night-patrol].stuck_label` (default: `patrol-stuck`)
- 実装: `scripts/failures.sh` (get / incr / reset / list) + `scripts/escalate-stuck.sh`
- 連続性の定義: 成功 (PR auto-merge) したら `failures.sh reset <issue>` でカウントを 0 にリセット。**run を跨いだ累積カウント** であって、単一 run 内で同じ issue を繰り返し retry するわけではない。
- 既存の行数 guard (#2, #6) や denylist guard (#3, #4, #5) とは軸が異なり独立して動作する (`guard-check.sh` には手を入れない)。
- escalation 時の挙動: `escalate-stuck.sh` が `patrol-stuck` label を付与し、失敗理由とタイムスタンプを含むコメントを issue に投稿する。dry-run モード (`--dry-run`) では gh 呼び出しをスキップして計算結果のみ JSON 出力する。

## ガード発動時の挙動

- スキップされたissueは `night-patrol.json` の `results` に `status: "skipped"` + `reason` で記録
- 失敗上限 (#7) に達した issue は `status: "escalated"` + `reason: "patrol-stuck"` で記録
- 累積上限によるループ終了でも Phase 4 (Report) は必ず実行
- Telegram 通知にスキップ数・escalation 数を含める
- ガード発動理由は全て `claudedocs/night-patrol/YYYY-MM-DD.md` にトレース可能
