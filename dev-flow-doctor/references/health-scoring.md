# Health Score Calculation

## Scoring Formula

```
score = 100
score -= (failure_rate * 30)        # Max -30 for high failure rate (includes partial)
score -= (avg_recovery_turns * 5)    # Max -25 for slow recovery
score -= (stale_worktrees * 2)       # Max -10 for cleanup debt
score -= (orphaned_dirs * 3)         # Max -15 for unregistered worktree dirs
score -= (duration_outlier_pct * 10) # Max -10 for high outlier rate in single mode
score -= (env_errors_pct * 15)       # Max -15 for env issues
score -= anomaly_penalty             # Max -15 for dev-flow telemetry anomalies (Check 8)
score -= baseline_regression_penalty # Max -15 for baseline regressions (Check 11, AC4/AC5)
score = max(0, score)
```

## dev-flow telemetry anomaly penalty (Check 8)

Check 8 は `analyze-dev-flow-telemetry.sh` が集計した dev-flow / pr-iterate journal telemetry
（shape / merge_tier / eval_iter / plan_iter / gate_policy / iterate_status の分布）から検出した
anomaly に応じて、最大 `-15` のペナルティを加算する。`run-diagnostics.sh --scope full` および
`--scope telemetry` で `run_telemetry_checks` 関数が計算する。

anomaly は次の 3 種類で、それぞれ `severity: "warn"` のとき `-5`:

- `cap_pinned`: dev-flow entry が `eval_iter_cap`（既定 10）または `plan_iter_cap`（既定 8）に
  張り付いている件数が 1 件以上
- `iterate_unhealthy`: `iterate_status`（lgtm / stuck / fix_failed / max_reached）を持つ全 run
  （dev-flow + pr-iterate）のうち非 lgtm で終了した割合が `iterate_unhealthy_rate`（既定 0.30）を
  超え、かつ母数が `iterate_min_runs`（既定 3）以上
- `micro_nonfiring`: dev-flow の総 run 数が `micro_min_runs`（既定 10）以上あるにもかかわらず
  `shape: micro` の run が 0 件

合計は `-15` でクランプ。`micro_nonfiring` が `severity: "skipped"`（`reason: "insufficient_data"`、
総 run 数が `micro_min_runs` 未満で判定不能な場合）のときは penalty は `0`（この anomaly は
ペナルティ計算にもカウントされない）。閾値はすべて `skill-config.json` の
`dev-flow-doctor.thresholds` から読み込む。

## Baseline regression penalty (Check 11, AC4/AC5)

`run-diagnostics.sh --compare <baseline-path>` が指定された場合、
`compare-baseline.sh` の `findings[]` を参照して penalty を加算する:

- `findings[].severity == "critical"` 1 件あたり `-5`
- 合計は `-15` でクランプ
- `findings[].severity == "error"`（window mismatch / corrupt baseline / IO error）は
  health score に影響しない（warning として `issues` に記録のみ）

baseline 比較は pre vs post の時間軸変化を測る指標で、telemetry anomaly penalty (Check 8) とは
独立に加算される。詳細・schema は [`baseline-comparison.md`](./baseline-comparison.md) を参照。

## Rating Table

| Score | Rating | Action |
|-------|--------|--------|
| 80-100 | Healthy | Minor optimizations only |
| 60-79 | Fair | Address top 2 findings |
| 40-59 | Needs Attention | Run /skill-retrospective, fix top issues |
| 0-39 | Critical | Systematic review needed |
