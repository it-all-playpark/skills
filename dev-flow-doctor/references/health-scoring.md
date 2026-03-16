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
score = max(0, score)
```

## Rating Table

| Score | Rating | Action |
|-------|--------|--------|
| 80-100 | Healthy | Minor optimizations only |
| 60-79 | Fair | Address top 2 findings |
| 40-59 | Needs Attention | Run /skill-retrospective, fix top issues |
| 0-39 | Critical | Systematic review needed |
