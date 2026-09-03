# dev-flow-doctor ↔ skill-retrospective Responsibility Split

`dev-flow-doctor` と `skill-retrospective` はいずれも `~/.claude/journal/*.json` を
入力源にするが、**対象範囲・目的・出力**が異なる。両者は journal ディレクトリ
（`$CLAUDE_JOURNAL_DIR` または `~/.claude/journal`）を共通入力源として扱い、
dev-flow-doctor は skill-retrospective の内部実装に依存せず **最小依存で直接読み取る**
（詳細は後述）。そのうえで **dev-flow / pr-iterate の telemetry 健全性**に特化した集計を行う。

## 対比表

| 観点 | skill-retrospective | dev-flow-doctor |
|------|---------------------|------------------|
| **対象** | 全 skill（journal 全体） | `dev-flow` / `pr-iterate` の telemetry を持つ entry に限定 |
| **目的** | 汎用的な失敗パターン検出と自己改善 proposal | dev-flow pipeline の **telemetry 健全性**（分布 + anomaly 検出） |
| **主な検出** | failure category 集計、再発パターン、proposal 生成 | shape / merge_tier / eval_iter / plan_iter / gate_policy / iterate_status の分布と anomaly 3 種 |
| **入力** | `~/.claude/journal/*.json` 全体 | journal を `skill == "dev-flow"`（分布系）/ `telemetry.iterate_status != null`（iterate_status のみ dev-flow + pr-iterate）でフィルタ |
| **出力** | proposal JSON / patch | `claudedocs/dev-flow-health-*.md` + 構造化 JSON |
| **実行トリガ** | failure 発生時 / セッション終了 / meta-retrospective | 定期（weekly / on-demand） |
| **スコアリング** | なし（proposal ベース） | 0–100 health score |

## dev-flow telemetry が対象とする entry

dev-flow-doctor の Check 8 は固定 skill リストによるフィルタではなく、journal entry の
`skill` フィールドと `telemetry` の有無で対象を決める:

- **分布集計**（`shape` / `merge_tier` / `eval_iter` / `plan_iter` / `gate_policy`）:
  `skill == "dev-flow"` の entry のみを分母にする。
- **`iterate_status` 分布**: `telemetry.iterate_status != null` を持つ全 entry（`dev-flow` と
  `pr-iterate` standalone entry の両方）を分母にする。

`dev-flow` / `pr-iterate` 以外の skill（`blog-*`, `sns-*`, `skill-creator` など）は
dev-flow-doctor の対象外である。それらの健全性は `skill-retrospective` の全体統計で確認する。

## anomaly 3 種の定義

| anomaly | 定義 | 既定閾値 |
|---------|------|----------|
| **cap_pinned** | dev-flow entry の `eval_iter` または `plan_iter` が cap に張り付いている件数が 1 件以上 | `eval_iter_cap=10` / `plan_iter_cap=8` |
| **iterate_unhealthy** | `iterate_status` を持つ全 run のうち非 lgtm（stuck / fix_failed / max_reached）の割合が閾値超 | `iterate_unhealthy_rate=0.30`、`iterate_min_runs=3` |
| **micro_nonfiring** | dev-flow の総 run 数が十分あるにもかかわらず `shape: micro` の run が 0 件（run 数不足時は `severity: "skipped"` で判定 skip） | `micro_min_runs=10` |

閾値はすべて `skill-config.json` の `dev-flow-doctor.thresholds` に集約する。

## dev-flow-doctor が依存するもの

- `skill-retrospective/scripts/journal.sh`（query / stats）を直接呼ぶのではなく、
  dev-flow-doctor 側は同じ journal ディレクトリ（`$CLAUDE_JOURNAL_DIR` もしくは
  `~/.claude/journal`）を直接読むシンプルな jq 処理で済ませる。
  `journal.sh` の API と同等の読み取りロジック（ISO since filter、skill filter）を
  `analyze-dev-flow-telemetry.sh` 内で再実装している。これは skill-retrospective 側の
  内部変更に影響されないようにするための意図的な最小依存である。

## 境界の明示（ガードレール）

- dev-flow-doctor は **proposal を生成しない**。改善提案は skill-retrospective の
  「提案→承認→適用」フローに乗せる。
- dev-flow-doctor の `--fix` は worktree cleanup などの safe fix に限定し、
  skill 本体への変更は一切行わない。
- skill-retrospective が dev-flow-doctor を呼び出すことは無い。逆方向も同様に
  直接呼び出しはしない（それぞれ独立に実行される）。
