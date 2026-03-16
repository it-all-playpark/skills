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
2. DIAGNOSE → Run diagnostic checks (see references/diagnostic-checks.md)
3. SCORE    → Rate overall health 0-100 (see references/health-scoring.md)
4. REPORT   → Generate findings with recommendations
5. FIX      → Apply safe fixes if --fix specified
```

## Key Context

- dev-flow defaults to auto-detect via `dev-decompose --dry-run`
- Auto-detect resolves to `single` or `parallel` based on codebase file dependencies
- `--force-single` / `--force-parallel` skip dry-run
- Journal `context.mode` tracks resolved mode (added 2026-03-13)
- Older entries without `context.mode` use heuristics (see Check 1 in references)

## Output Format

```markdown
## Dev Flow Health Report

**Health Score**: 85/100 (Healthy)
**Period**: 2026-02-12 ~ 2026-03-13
**Total Executions**: 90 (success: 88, failure: 0, partial: 2)

### Findings

1. **[INFO]** 80% of executions use single mode via auto-detect
   → Auto-detect is correctly routing small issues to single mode

2. **[WARN]** 3 stale worktree directories found
   → Not registered as git worktrees, safe to remove

### Recommended Actions
- [ ] Clean orphaned worktree directories

### Safe Auto-Fixes Available (--fix)
- Remove orphaned worktree directories
```

## Scripts

### `scripts/run-diagnostics.sh`

Deterministic diagnostic data collection and health score calculation.

```bash
# Full diagnostics
./scripts/run-diagnostics.sh
# Specific scope
./scripts/run-diagnostics.sh --scope journal
./scripts/run-diagnostics.sh --scope worktrees
./scripts/run-diagnostics.sh --scope config
```

Output: JSON with `score`, `rating`, `checks`, and `issues` fields. The LLM uses this structured data to generate the human-readable report with recommendations and prose.

## References

- [Diagnostic Checks](references/diagnostic-checks.md) -- Check 1-7: mode distribution, failure analysis, error categories, worktree health, recovery turns, success trend, duration outliers
- [Health Scoring](references/health-scoring.md) -- Scoring formula and rating table

## Examples

```bash
# Full health check
/dev-flow-doctor

# Journal analysis only
/dev-flow-doctor --scope journal

# Auto-fix safe issues
/dev-flow-doctor --fix
```
