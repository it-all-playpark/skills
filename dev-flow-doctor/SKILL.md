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

## Key Context

- **dev-flow defaults to auto-detect** via `dev-decompose --dry-run`
- Auto-detect resolves to `single` or `parallel` based on codebase file dependencies
- `--force-single` / `--force-parallel` skip dry-run
- Journal entries with `context.mode` field track the resolved mode (added 2026-03-13)
- Older entries without `context.mode` must be analyzed via heuristics (see Check 1)

## Diagnostic Checks

### Check 1: Mode Distribution

Analyze how often single vs parallel mode is actually used.

```bash
# New entries (with context.mode)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh query --skill dev-flow --limit 200 | \
  jq 'group_by(.context.mode // "unknown") | map({mode: .[0].context.mode // "unknown", count: length})'

# Legacy entries (without context.mode): infer from heuristics
# - duration_turns <= 5 AND no "parallel" in args → likely single
# - duration_turns >= 10 OR "parallel" in args → likely parallel
$SKILLS_DIR/skill-retrospective/scripts/journal.sh query --skill dev-flow --limit 200 | \
  jq '[.[] | select(.context.mode == null)] |
    { legacy_count: length,
      likely_single: [.[] | select(.duration_turns <= 5 and (.args // "" | test("parallel|force-parallel") | not))] | length,
      likely_parallel: [.[] | select(.duration_turns >= 10 or (.args // "" | test("parallel|force-parallel")))] | length,
      ambiguous: [.[] | select(.duration_turns > 5 and .duration_turns < 10 and (.args // "" | test("parallel|force-parallel") | not))] | length
    }'
```

| Finding | Recommendation |
|---------|----------------|
| All single (no parallel ever) | Auto-detect may be too conservative, review decompose dry-run criteria |
| Parallel used but only via --force-parallel | Auto-detect not triggering when it should |
| Healthy mix of single/parallel | Auto-detect working as intended |
| Many ambiguous legacy entries | No action (will resolve as new mode-tagged entries accumulate) |

### Check 2: Failure & Partial Distribution

Analyze journal entries for both `failure` AND `partial` outcomes:

```bash
# Include both failure and partial outcomes
$SKILLS_DIR/skill-retrospective/scripts/journal.sh query --skill dev-kickoff --limit 200 | \
  jq '[.[] | select(.outcome == "failure" or .outcome == "partial")] |
    group_by(.error.phase // "unknown") |
    map({phase: .[0].error.phase // "unknown", count: length, outcomes: (group_by(.outcome) | map({outcome: .[0].outcome, count: length}))}) |
    sort_by(-.count)'
```

| Pattern | Recommendation |
|---------|----------------|
| Phase 3 (implement) > 30% | Review issue analysis depth, consider `--depth comprehensive` |
| Phase 4 (validate) > 40% | Add pre-validation linting, consider `--fix` auto-mode |
| Phase 1 (prepare) > 10% | Check git-prepare config, env-mode settings |
| Phase 2 (analyze) issues | Check dev-issue-analyze / dev-decompose flow control |

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
| `runtime` > 20% | Investigate skill flow control issues (phase transitions) |

### Check 4: Worktree Health

Check worktrees across all known repository locations, including sibling `-worktrees/` directories:

```bash
# List worktrees registered in git
git worktree list --porcelain

# Check for orphaned worktree directories (siblings of repo)
REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")
WORKTREE_BASE="${REPO_ROOT}/../${REPO_NAME}-worktrees"
if [[ -d "$WORKTREE_BASE" ]]; then
  echo "=== Worktree directory: $WORKTREE_BASE ==="
  ls -lt "$WORKTREE_BASE" 2>/dev/null
  # Check each for staleness (>7 days old)
  find "$WORKTREE_BASE" -maxdepth 1 -type d -mtime +7 2>/dev/null
  # Check each for kickoff.json
  for wt in "$WORKTREE_BASE"/*/; do
    [[ -f "$wt/.claude/kickoff.json" ]] && echo "HAS_STATE: $wt" || echo "NO_STATE: $wt"
  done
fi
```

| Finding | Recommendation |
|---------|----------------|
| Stale worktrees (>7 days) | Clean up: `git worktree remove <path>` |
| Directories without kickoff.json | Orphaned worktrees, safe to remove |
| Worktrees with failed state | Investigate or remove |
| Directories not registered as git worktrees | Leftover from failed cleanup, safe to remove |

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

### Check 7: Duration Outliers

Identify executions with unusually high turn counts:

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh query --skill dev-flow --limit 200 | \
  jq '(map(.duration_turns) | add / length) as $avg |
    { average_turns: $avg,
      outliers: [.[] | select(.duration_turns > ($avg * 3))] |
        map({issue: .context.issue, turns: .duration_turns, mode: (.context.mode // "unknown"), args: .args})
    }'
```

| Finding | Recommendation |
|---------|----------------|
| Outliers are all parallel mode | Expected — parallel takes more turns |
| Outliers in single mode | Investigate: likely validation failures or complex implementations |
| Average > 8 turns | Overall pipeline may need optimization |
| Average < 5 turns | Pipeline is efficient |

## Health Score Calculation

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

| Score | Rating | Action |
|-------|--------|--------|
| 80-100 | Healthy | Minor optimizations only |
| 60-79 | Fair | Address top 2 findings |
| 40-59 | Needs Attention | Run /skill-retrospective, fix top issues |
| 0-39 | Critical | Systematic review needed |

## Output Format

```markdown
## Dev Flow Health Report

**Health Score**: 85/100 (Healthy)
**Period**: 2026-02-12 ~ 2026-03-13
**Total Executions**: 90 (success: 88, failure: 0, partial: 2)

### Mode Distribution
- Single (auto-detect): 65
- Parallel (auto-detect): 12
- Parallel (force): 8
- Unknown (legacy): 5

### Findings

1. **[INFO]** 80% of executions use single mode via auto-detect
   → Auto-detect is correctly routing small issues to single mode

2. **[WARN]** 3 stale worktree directories found in corporate-site-worktrees/
   → Not registered as git worktrees, safe to remove

3. **[INFO]** Average duration: 4.2 turns, 5 outliers (>12 turns, all parallel)
   → Expected variance for parallel mode

### Recommended Actions
- [ ] Clean orphaned worktree directories
- [ ] Legacy journal entries will auto-resolve as mode-tagged entries accumulate

### Safe Auto-Fixes Available (--fix)
- Remove 3 orphaned worktree directories
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
