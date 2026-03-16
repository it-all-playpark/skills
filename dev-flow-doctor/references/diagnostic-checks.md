# Diagnostic Checks

## Check 1: Mode Distribution

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

## Check 2: Failure & Partial Distribution

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

## Check 3: Error Category Distribution

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

## Check 4: Worktree Health

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

## Check 5: Average Recovery Turns

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh stats | jq '.avg_recovery_turns'
```

| Value | Health | Recommendation |
|-------|--------|----------------|
| < 2.0 | Good | No action needed |
| 2.0 - 5.0 | Fair | Review common failure patterns |
| > 5.0 | Poor | Run /skill-retrospective for improvement proposals |

## Check 6: Success Rate Trend

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

## Check 7: Duration Outliers

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
| Outliers are all parallel mode | Expected -- parallel takes more turns |
| Outliers in single mode | Investigate: likely validation failures or complex implementations |
| Average > 8 turns | Overall pipeline may need optimization |
| Average < 5 turns | Pipeline is efficient |
