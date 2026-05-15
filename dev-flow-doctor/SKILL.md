---
name: dev-flow-doctor
description: |
  Diagnose dev-flow pipeline health from skill-retrospective journal. Detects dead phase,
  stuck skill, bottleneck, disconnected skill across the dev-flow family.
  Use when: (1) dev-flow issues or underperformance, (2) child-split mode not triggering,
  (3) stuck skill / dead phase suspicion, (4) weekly dev-flow health review,
  (5) keywords: doctor, diagnose, health check, dev-flow問題, 診断, dead phase, stuck skill, bottleneck, connector, child-split
  Accepts args: [--scope full|journal|worktrees|config|family|feedback] [--window 7d|30d] [--fix] [--compare <path>] [--update-baseline <path>]
allowed-tools:
  - Bash(~/.claude/skills/dev-flow-doctor/scripts/*)
  - Bash(~/.claude/skills/skill-retrospective/scripts/*)
---

# dev-flow-doctor

Diagnose dev-flow pipeline health by reading `skill-retrospective` journal entries
(`~/.claude/journal/*.json`). Surfaces dead phases, stuck skills, bottlenecks, and
disconnected skills across the dev-flow family — then generates actionable
improvement recommendations.

## Key shift: journal-driven (not static scan)

本 skill は **journal 駆動**である。静的な skill file scan ではなく、
`skill-retrospective` が蓄積している `~/.claude/journal/*.json` を読み込み、
dev-flow family 8 skill（`dev-kickoff`, `dev-implement`, `dev-validate`,
`dev-integrate`, `dev-evaluate`, `pr-iterate`, `pr-fix`, `night-patrol`）に絞って
**連携健全性**（connector 不成立、phase 停滞、failure 集中、実行時間肥大）を判定する。

汎用的な failure パターン検出や proposal 生成は `skill-retrospective` の責務である。
詳しくは [responsibility-split.md](references/responsibility-split.md) を参照。

## Usage

```
/dev-flow-doctor [--scope full|journal|worktrees|config|family|feedback]
                 [--window 7d|30d] [--fix]
                 [--compare <baseline-path>] [--update-baseline <path>]
```

| Arg | Default | Description |
|-----|---------|-------------|
| `--scope` | `full` | Diagnosis scope |
| `--window` | `30d` | Lookback window for journal-based checks (7d/14d/30d/2w/1m) |
| `--fix` | false | Auto-apply safe fixes (worktree cleanup only) |
| `--compare` | - | Path to baseline snapshot to compare against (AC4). Adds `baseline_compare` to checks + max -15 penalty |
| `--update-baseline` | - | Regenerate baseline snapshot at the given path (AC2). Delegates to `baseline-snapshot.sh`; emits warning if journal is empty |

## Diagnostic Scopes

| Scope | What It Checks |
|-------|----------------|
| `full` | All checks below |
| `journal` | Legacy journal-based execution analysis (Check 1–7, dev-flow skill only) |
| `worktrees` | Worktree state and cleanup |
| `config` | Skill configuration validation |
| `family` | **Dev-flow family connector health** (Check 8: dead / stuck / bottleneck / disconnected) + termination loops (Check 9) |
| `feedback` | **Removed in v2** (parallel-mode infrastructure deleted); returns explicit error |

## Workflow

```
1. COLLECT  → Gather data from journal, worktrees, state files
2. DIAGNOSE → Run diagnostic checks (see references/diagnostic-checks.md)
3. SCORE    → Rate overall health 0-100 (see references/health-scoring.md)
4. REPORT   → Generate findings with recommendations
5. FIX      → Apply safe fixes if --fix specified
```

## Key Context

- dev-flow v2 uses explicit mode flags: `--force-single` (default) or `--child-split`
- Auto-detect (`dev-decompose --dry-run`) was removed in v2 — passing `--force-parallel` / `--parallel` is an error
- Journal `context.mode` tracks resolved mode
- Family scope reads the same journal via direct jq (see `scripts/analyze-dev-flow-family.sh`)
- Family skills / thresholds / default window are configured in `skill-config.json` under `"dev-flow-doctor"`

## Output Format

```markdown
## Dev Flow Health Report

**Health Score**: 85/100 (Healthy)
**Period**: 2026-02-12 ~ 2026-03-13 (window: 30d)
**Total Executions**: 90 (success: 88, failure: 0, partial: 2)

### Dev-Flow Family (Check 8)

**Dead Phases** (no success in 30d):
- `dev-integrate`: 呼び出し経路を確認。child-split mode が発火していない可能性
  （`dev-flow --child-split` で parent issue が分割されているか、または
  `verify-children-merged.sh` が呼ばれているか）

**Stuck Skills** (failure rate > 30% OR blocked_rate > 30%):
- `pr-fix`: 42% failure rate (12 entries) — lint/test errors が主要原因
- `dev-implement`: blocked_rate 35% (3 BLOCKED + 1 NEEDS_CONTEXT / 11 entries) — approach mismatch suspect

### Status Distribution (Check 8 — dev-implement worker, issue #92)

dev-implement の 4 値 status enum を集計する。`--scope feedback` 指定時に詳細表示。

| Skill | DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT | total_with_status |
|---|---:|---:|---:|---:|---:|
| dev-implement | 12 | 3 | 1 | 0 | 16 |

- `BLOCKED` 高比率 → approach mismatch、Plan 段階の見直しが必要
- `NEEDS_CONTEXT` 高比率 → issue body / plan が不足、orchestrator から渡す context が不十分

**Bottlenecks** (top avg duration):
1. `dev-kickoff` — avg 18.3 turns
2. `dev-implement` — avg 7.2 turns

**Disconnected Skills** (no parent invocation in 30d):
- `night-patrol`: orchestrator 経路が不明

### Integration Feedback (Check 9)

**Recurring Conflict Files** (>= 3 occurrences in last 100 events):
- `src/types/user.ts` (4x) — 「同じ types/ 配下は 1 subtask にまとめるべき」

**Recurring Conflict Directories**:
- `src/types/` (5x)

→ 次回 `dev-decompose --dry-run` は自動的にこの hint を subtask grouping に
  反映する。再発が収束しない場合は decomposition 戦略自体の見直しを検討。

### Other Findings

1. **[INFO]** 80% of executions use single mode via auto-detect
2. **[WARN]** 3 stale worktree directories found

### Recommended Actions

- [ ] Run `/skill-retrospective` for pr-fix failure patterns
- [ ] Investigate dev-integrate call path (Check 8)
- [ ] Clean orphaned worktree directories

### Safe Auto-Fixes Available (--fix)

- Remove orphaned worktree directories
```

## Scripts

### `scripts/run-diagnostics.sh`

Deterministic diagnostic data collection and health score calculation.

```bash
# Full diagnostics (includes family check)
./scripts/run-diagnostics.sh --window 30d

# Dev-flow family connector only
./scripts/run-diagnostics.sh --scope family --window 7d

# Legacy scopes
./scripts/run-diagnostics.sh --scope journal
./scripts/run-diagnostics.sh --scope worktrees
./scripts/run-diagnostics.sh --scope config

# Baseline comparison (AC4) — adds baseline_compare check + regression penalty
./scripts/run-diagnostics.sh --scope family --compare .claude/dev-flow-doctor-baseline-pre-79.json

# Regenerate baseline (AC2) — delegates to baseline-snapshot.sh
./scripts/run-diagnostics.sh --update-baseline .claude/dev-flow-doctor-baseline-pre-79.json --window 30d
```

Output: JSON with `score`, `rating`, `checks` (including `dev_flow_family` and `baseline_compare` when `--compare` is used), and `issues` fields.

### `scripts/baseline-snapshot.sh`

Aggregate journal entries into a snapshot JSON (issue #83 AC2). Single-purpose:
generate snapshot, write to stdout or `--out <path>`. Does NOT accept
`--update-baseline` (ownership belongs to `run-diagnostics.sh`).

```bash
./scripts/baseline-snapshot.sh --window 30d [--out <path>] [--include-non-family]
```

### `scripts/compare-baseline.sh`

Deterministic baseline vs current comparison (issue #83 AC3). Exit codes:
0 = no regression, 1 = regression detected, 2 = corrupt baseline / window mismatch / IO.

```bash
./scripts/compare-baseline.sh --baseline <path> [--current <path>]   # stdin if --current omitted
```

Detail: [`references/baseline-comparison.md`](references/baseline-comparison.md).

### `scripts/analyze-termination-loops.sh`

Cross-worktree Generator-Verifier loop analysis (Check 9, issue #53). Reads
`phases.3b_plan_review.termination` / `phases.6_evaluate.termination` from each
worktree's `.claude/kickoff.json` to detect:

- `repeated_feedback_target` — same Phase 6 `feedback_target` in 2+ consecutive iterations
- `max_iterations` — loop exhausted iteration budget
- `stuck` — Phase 3b plan-review findings unresolved across iterations
- `fork_failure` — verifier fork failed

```bash
./scripts/analyze-termination-loops.sh [--worktree-base <dir>]
```

Called by `run-diagnostics.sh --scope full|family`; can also be invoked directly.

### `scripts/analyze-dev-flow-family.sh`

Dev-flow family connector analysis (Check 8). Called by `run-diagnostics.sh --scope full|family`,
but can also be invoked directly for standalone family diagnosis.

```bash
./scripts/analyze-dev-flow-family.sh --window 30d
./scripts/analyze-dev-flow-family.sh --window 7d --config /path/to/skill-config.json
```

Output JSON schema:

```json
{
  "window": "30d",
  "since": "2026-03-12T...",
  "family_skills": ["dev-kickoff", "..."],
  "per_skill": [
    {"skill": "dev-kickoff", "total": 3, "success": 3, "failure": 0,
     "partial": 0, "failure_rate": 0, "avg_duration_turns": 20, ...}
  ],
  "findings": {
    "dead_phases": [...],
    "stuck_skills": [...],
    "bottlenecks": [...],
    "disconnected_skills": [...]
  }
}
```

## Tests

```bash
./tests/test-analyze-dev-flow-family.sh
./tests/test-analyze-termination-loops.sh
```

Fixture-based unit tests validate family filtering, 4 detection categories, per-skill
statistics, and window filtering. `test-analyze-termination-loops.sh` covers Check 9
(termination-loop health): repeated_feedback_target, max_iterations, stuck, fork_failure,
and converged cases.

## References

- [Diagnostic Checks](references/diagnostic-checks.md) -- Check 1–9 (family connector in Check 8, termination loops in Check 9)
- [Health Scoring](references/health-scoring.md) -- Scoring formula including family penalty + baseline regression penalty (max -15)
- [Baseline Comparison](references/baseline-comparison.md) -- AC4/AC5 snapshot schema, compare semantics, CI 運用パターン
- [Responsibility Split](references/responsibility-split.md) -- Boundary vs skill-retrospective

## Examples

```bash
# Full health check (includes Check 8)
/dev-flow-doctor

# Focused family connector check, last 7 days
/dev-flow-doctor --scope family --window 7d

# Journal-only legacy analysis
/dev-flow-doctor --scope journal

# Auto-fix safe issues (worktree cleanup only)
/dev-flow-doctor --fix
```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-flow-doctor success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-flow-doctor failure \
  --error-category <category> --error-msg "<message>"
```
