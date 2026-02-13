---
name: dev-flow-doctor
description: |
  Diagnose dev-flow health, identify unused features, and suggest improvements.
  Use when: (1) dev-flow issues or underperformance, (2) parallel mode not triggering,
  (3) wanting to optimize dev workflow, (4) keywords: doctor, diagnose, health check, dev-flow問題, 診断
  Accepts args: [--scope full|journal|worktrees|config] [--fix]
allowed-tools:
  - Bash
---

# dev-flow-doctor

Diagnose dev-flow pipeline health and generate actionable improvement recommendations.

## Usage

```
/dev-flow-doctor [--scope full|journal|worktrees|config] [--fix]
```

| Arg | Default | Description |
|-----|---------|-------------|
| `--scope` | `full` | Diagnosis scope |
| `--fix` | false | Auto-apply safe fixes |

## Diagnostic Scopes

| Scope | What It Checks |
|-------|----------------|
| `full` | All checks below |
| `journal` | Journal-based execution analysis |
| `worktrees` | Worktree state and cleanup |
| `config` | Skill configuration validation |

## Workflow

```
1. COLLECT  → Gather data from journal, worktrees, state files
2. DIAGNOSE → Run diagnostic checks
3. SCORE    → Rate overall health (0-100)
4. REPORT   → Generate findings with recommendations
5. FIX      → Apply safe fixes if --fix specified
```

## Diagnostic Checks

### Check 1: Parallel Mode Usage

```bash
# Check if --parallel has ever been used
$SKILLS_DIR/skill-retrospective/scripts/journal.sh query --skill dev-flow --limit 100 | \
  jq '[.[] | select(.args != null and (.args | contains("parallel")))] | length'
```

| Finding | Recommendation |
|---------|----------------|
| Never used | Consider using `--parallel` for issues touching 3+ files |
| Used but failed | Investigate decomposition failures |
| Used successfully | No action needed |

### Check 2: Phase Failure Distribution

Analyze journal entries to identify which dev-kickoff phases fail most:

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh query --skill dev-kickoff --outcome failure --limit 100 | \
  jq 'group_by(.error.phase) | map({phase: .[0].error.phase, count: length}) | sort_by(-.count)'
```

| Pattern | Recommendation |
|---------|----------------|
| Phase 3 (implement) > 30% | Review issue analysis depth, consider `--depth comprehensive` |
| Phase 4 (validate) > 40% | Add pre-validation linting, consider `--fix` auto-mode |
| Phase 1 (prepare) > 10% | Check git-prepare config, env-mode settings |

### Check 3: Error Category Distribution

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh stats | jq '.by_category'
```

| Category Dominance | Recommendation |
|--------------------|----------------|
| `env` > 30% | Integrate dev-env-setup into git-prepare workflow |
| `lint` > 40% | Add auto-fix in dev-validate, configure stricter editor settings |
| `test` > 40% | Review test quality, consider TDD strategy |
| `type-check` > 20% | Enable strict TypeScript mode, add pre-commit type checks |

### Check 4: Worktree Health

```bash
# List all worktrees and check for stale ones
git worktree list --porcelain
```

| Finding | Recommendation |
|---------|----------------|
| Stale worktrees (>7 days) | Clean up: `git worktree remove <path>` |
| Worktrees without kickoff.json | Orphaned worktrees, safe to remove |
| Worktrees with failed state | Investigate or remove |

### Check 5: Average Recovery Turns

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh stats | jq '.avg_recovery_turns'
```

| Value | Health | Recommendation |
|-------|--------|----------------|
| < 2.0 | Good | No action needed |
| 2.0 - 5.0 | Fair | Review common failure patterns |
| > 5.0 | Poor | Run /skill-retrospective for improvement proposals |

### Check 6: Success Rate Trend

Compare recent success rate (last 7 days) vs overall:

```bash
# Recent
$SKILLS_DIR/skill-retrospective/scripts/journal.sh stats --since 7d
# Overall
$SKILLS_DIR/skill-retrospective/scripts/journal.sh stats
```

| Trend | Meaning |
|-------|---------|
| Improving | Skills are getting better (retrospective working) |
| Stable | Consistent performance |
| Declining | New failure patterns emerging, investigate |

## Health Score Calculation

```
score = 100
score -= (failure_rate * 30)        # Max -30 for high failure rate
score -= (avg_recovery_turns * 5)    # Max -25 for slow recovery
score -= (stale_worktrees * 2)       # Max -10 for cleanup debt
score -= (parallel_unused * 10)      # -10 if parallel never used
score -= (env_errors_pct * 15)       # Max -15 for env issues
score = max(0, score)
```

| Score | Rating | Action |
|-------|--------|--------|
| 80-100 | Healthy | Minor optimizations only |
| 60-79 | Fair | Address top 2 findings |
| 40-59 | Needs Attention | Run /skill-retrospective, fix top issues |
| 0-39 | Critical | Systematic review needed |

## Output Format

```markdown
## Dev Flow Health Report

**Health Score**: 72/100 (Fair)
**Period**: 2026-01-15 ~ 2026-02-12
**Total Executions**: 24 (success: 18, failure: 4, partial: 2)

### Findings

1. **[WARN]** Parallel mode never used
   → 3+ file issues could benefit from `--parallel`

2. **[WARN]** Phase 4 (validate) fails 35% of the time
   → Most failures are lint errors (auto-fixable)

3. **[INFO]** 2 stale worktrees found (>7 days old)
   → Run cleanup commands below

### Recommended Actions
- [ ] Try `--parallel` on next large issue
- [ ] Add `--fix` to dev-validate default behavior
- [ ] Clean stale worktrees: `git worktree remove ...`

### Safe Auto-Fixes Available (--fix)
- Remove 2 stale worktrees
```

## Examples

```bash
# Full health check
/dev-flow-doctor

# Journal analysis only
/dev-flow-doctor --scope journal

# Auto-fix safe issues
/dev-flow-doctor --fix
```
