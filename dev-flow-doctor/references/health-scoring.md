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
score -= family_penalty              # Max -20 for dev-flow family connector issues (Check 8)
score -= baseline_regression_penalty # Max -15 for baseline regressions (Check 11, AC4/AC5)
score = max(0, score)
```

## dev-flow family penalty (Check 8)

Check 8 の検出結果に応じて最大 `-20` のペナルティを加算する:

- dead phase が 1 件以上: `-5`
- stuck skill が 1 件以上: `-5`
- disconnected skill が 1 件以上: `-5`
- bottleneck は informational のみ（penalty なし）

合計は `-20` でクランプ。`run-diagnostics.sh --scope full` および `--scope family` で
`run_family_checks` 関数が計算する。

## Baseline regression penalty (Check 11, AC4/AC5)

`run-diagnostics.sh --compare <baseline-path>` が指定された場合、
`compare-baseline.sh` の `findings[]` を参照して penalty を加算する:

- `findings[].severity == "critical"` 1 件あたり `-5`
- 合計は `-15` でクランプ
- `findings[].severity == "error"`（window mismatch / corrupt baseline / IO error）は
  health score に影響しない（warning として `issues` に記録のみ）

baseline 比較は pre vs post の時間軸変化を測る指標で、family penalty (Check 8) とは
独立に加算される。詳細・schema は [`baseline-comparison.md`](./baseline-comparison.md) を参照。

## Rating Table

| Score | Rating | Action |
|-------|--------|--------|
| 80-100 | Healthy | Minor optimizations only |
| 60-79 | Fair | Address top 2 findings |
| 40-59 | Needs Attention | Run /skill-retrospective, fix top issues |
| 0-39 | Critical | Systematic review needed |
