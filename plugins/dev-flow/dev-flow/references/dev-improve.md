# dev-improve 自己改善ループ詳細

dev-improve (self-improvement loop) の設計詳細。不変条件は `.claude/rules/dev-flow.md` を参照。
本文中の `.claude/workflows/` / `.claude/agents/` / `_lib/` は `plugins/dev-flow/` を root とする
plugin 相対パス。

dev-flow を telemetry 駆動で継続的に自己改善するループ。orchestration は
`.claude/workflows/dev-improve.js`（dynamic workflow）、起動は `/dev-flow-improve`
skill（週次 launchd: `dev-flow-improve/scripts/install-schedule.sh --install`）。

```
/dev-flow-improve → Workflow('dev-flow:dev-improve')
                      Reconcile(仮説突合) → Mine(4ソース並列) → Rank(dedup+cut) → File(issue化)
                    → 起票 issue ごとに Skill('dev-flow') を直列実行 → 人間 merge
```

- **改善ソース 4 系統**: doctor-anomaly（telemetry 分布・anomaly）/ failure-rca（失敗 run 個別掘り）/
  sunset（W7 capability-bound の再評価トリガ検知）/ pr-signal（findings 再発・merge_tier と人間判断の乖離）。
  miner は `.claude/agents/improve-miner.md`（read-only 判断系 leaf）。
- **仮説駆動の効果検証**: 起票 issue の body に hypothesis ブロック
  （metric/current/target/min_runs/status — canonical `_lib/improve-hypothesis.mjs`）を埋め込み、
  次サイクルの Reconcile が `dev-flow-improve/scripts/hypothesis-check.sh`（決定論 oracle）で
  実測突合する。metric は 3 値 closed enum（iterate_unhealthy_rate / micro_share / cap_pinned_count、
  out-of-enum は error）。not_confirmed は revert 候補として候補プールに入る（自動 revert なし）。
- **throughput cap**: `IMPROVE_MAX=2`/サイクル + open self-improve issue >= 2 で backpressure skip
  （canonical `_lib/improve-rank.mjs`）。open 数取得失敗は fail-closed（skip）。他の失敗は fail-open。
- **state は GitHub issue のみ**: label `self-improve`（起票）/ `self-improve-backlog`（落選 backlog、
  単一 issue）。外部 state JSON なし。
- **telemetry**: 完走時に `journal.sh log dev-improve success --telemetry-json '{...}'` を直接呼ぶ
  （candidates_found / issues_filed / hypotheses_* / backlog_added / backpressure_skipped）。
  dev-flow-doctor がループ自体の不調も診断できる。
- **自己改変 floor**: 候補の target_paths が dev-flow 本体（`plugins/dev-flow/.claude/workflows/` /
  `plugins/dev-flow/_lib/` / `plugins/dev-flow/agents/` / `plugins/dev-flow/.claude/agents/` /
  `tools/`）に触れる場合、issue AC に `/dev-flow-canary` 実行を自動追記。
  コード変更は既存 merge tier ロジックで REVIEW 以上になるが、`plugins/dev-flow/agents/*.md` のみの
  変更は docs 扱いで micro AUTO 推奨になり得る（REVIEW floor は未実装 — follow-up。human merge が
  最終 gate である invariant は不変）。
