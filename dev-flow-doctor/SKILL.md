---
name: dev-flow-doctor
description: |
  Diagnose dev-flow pipeline health from skill-retrospective journal telemetry.
  Detects anomalies in dev-flow/pr-iterate distributions: cap張り付き
  (eval_iter/plan_iter pinned at loop cap), iterate不調率 (pr-iterate
  stuck/fix_failed/max_reached rate), micro不発火 (micro shape never selected
  despite sufficient run volume).
  Use when: (1) dev-flow issues or underperformance,
  (2) shape / merge_tier / gate_policy distribution review, (3) weekly dev-flow health review,
  (4) keywords: doctor, diagnose, health check, dev-flow問題, 診断, telemetry, anomaly, 分布, cap張り付き, iterate不調率, micro不発火
  Accepts args: [--scope full|journal|worktrees|config|telemetry|feedback] [--window 7d|30d] [--fix] [--compare <path>] [--update-baseline <path>]
allowed-tools:
  - Bash(~/.claude/skills/dev-flow-doctor/scripts/*)
  - Bash(~/.claude/skills/skill-retrospective/scripts/*)
---

# dev-flow-doctor

Diagnose dev-flow pipeline health by reading `skill-retrospective` journal entries
(`~/.claude/journal/*.json`). Surfaces `dev-flow` / `pr-iterate` telemetry
distributions (shape, merge_tier, eval_iter, plan_iter, gate_policy, iterate_status)
and anomaly detections (cap張り付き, iterate不調率, micro不発火) — then generates
actionable improvement recommendations.

## Key shift: journal-driven (not static scan)

本 skill は **journal 駆動**である。静的な skill file scan ではなく、
`skill-retrospective` が蓄積している `~/.claude/journal/*.json` を読み込み、
`dev-flow` / `pr-iterate` が書き出す telemetry フィールド（`shape`, `merge_tier`,
`eval_iter`, `plan_iter`, `gate_policy`, `danger_hits`, `iterate_status`）を
分布集計し、**anomaly 3 種**（cap張り付き / iterate不調率 / micro不発火）を判定する。

汎用的な failure パターン検出や proposal 生成は `skill-retrospective` の責務である。
詳しくは [responsibility-split.md](references/responsibility-split.md) を参照。

## Usage

```
/dev-flow-doctor [--scope full|journal|worktrees|config|telemetry|feedback]
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
| `telemetry` | **Dev-flow telemetry health**: dev-flow/pr-iterate journal telemetry の分布集計（shape / merge_tier / eval_iter / plan_iter / gate_policy / iterate_status）+ anomaly 3 種（cap張り付き / iterate不調率 / micro不発火） |
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

- Telemetry scope は `dev-flow` / `pr-iterate` の journal entry を直接 jq で集計する
  (see `scripts/analyze-dev-flow-telemetry.sh`)
- 分布（shape / merge_tier / eval_iter / plan_iter / gate_policy）の分母は
  `.skill == "dev-flow"` の entry のみ。`iterate_status` の分母のみ
  `.telemetry.iterate_status` を持つ全 entry（dev-flow + pr-iterate 両方）
- 閾値・default window は `skill-config.json` の `"dev-flow-doctor"` 配下
  (`thresholds.eval_iter_cap` / `plan_iter_cap` / `iterate_unhealthy_rate` /
  `iterate_min_runs` / `micro_min_runs`) で設定する

## Output Format

```markdown
## Dev Flow Health Report

**Health Score**: 85/100 (Healthy)
**Period**: 2026-02-12 ~ 2026-03-13 (window: 30d)
**Total Executions**: 90 (success: 88, failure: 0, partial: 2)

### Dev-Flow Telemetry (dev_flow_telemetry)

**Distributions** (denominator: dev-flow runs, total 42):

| shape | count | | merge_tier | count | | gate_policy | count |
|---|---:|-|---|---:|-|---|---:|
| micro | 12 | | AUTO | 5 | | llm-major-advisory | 40 |
| standard | 24 | | REVIEW | 30 | | llm-major-blocking | 2 |
| complex | 6 | | HOLD | 7 | | unknown | 0 |
| unknown | 0 | | unknown | 0 | | | |

eval_iter: max 10, cap 10, at_cap_count 3
plan_iter: max 7, cap 8, at_cap_count 0

**iterate_status** distribution (denominator: dev-flow + pr-iterate runs with
iterate_status set, total 38): lgtm 30, stuck 4, fix_failed 3, max_reached 1, unknown 0

### Anomalies

| type | severity | detail |
|---|---|---|
| `cap_pinned` | warn | 3 件が eval_iter/plan_iter cap に到達 |
| `iterate_unhealthy` | warn | 非lgtm rate 21% (8/38) |
| `micro_nonfiring` | skipped | insufficient_data (total_dev_flow_runs < micro_min_runs) |

- `cap_pinned` → 該当 issue の plan/evaluate loop が収束していない。issue サイズ見直しを検討
- `iterate_unhealthy` (rate > 閾値 かつ run数 >= min_runs) → pr-reviewer feedback の質、または PR スコープの見直しが必要
- `micro_nonfiring` (severity: warn, run数 >= min_runs だが micro 0件) → shape 判定ロジックの見直し。
  `severity: skipped` は run 数不足を意味し、閾値未達の間は判定を保留する

### Other Findings

1. **[INFO]** No journal entries found for dev-flow (journal scope)
2. **[WARN]** 3 stale worktree directories found

### Recommended Actions

- [ ] Investigate cap_pinned issues (eval_iter/plan_iter loop convergence)
- [ ] Review pr-iterate feedback quality (iterate_unhealthy)
- [ ] Clean orphaned worktree directories

### Safe Auto-Fixes Available (--fix)

- Remove orphaned worktree directories
```

## Scripts

### `scripts/run-diagnostics.sh`

Deterministic diagnostic data collection and health score calculation.

```bash
# Full diagnostics (includes telemetry check)
./scripts/run-diagnostics.sh --window 30d

# Dev-flow telemetry only
./scripts/run-diagnostics.sh --scope telemetry --window 7d

# Legacy scopes
./scripts/run-diagnostics.sh --scope journal
./scripts/run-diagnostics.sh --scope worktrees
./scripts/run-diagnostics.sh --scope config

# Baseline comparison (AC4) — adds baseline_compare check + regression penalty
./scripts/run-diagnostics.sh --scope telemetry --compare .claude/dev-flow-doctor-baseline-pre-79.json

# Regenerate baseline (AC2) — delegates to baseline-snapshot.sh
./scripts/run-diagnostics.sh --update-baseline .claude/dev-flow-doctor-baseline-pre-79.json --window 30d
```

Output: JSON with `score`, `rating`, `checks` (including `dev_flow_telemetry` and
`baseline_compare` when `--compare` is used), and `issues` fields.

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

### `scripts/analyze-dev-flow-telemetry.sh`

Dev-flow telemetry distribution + anomaly analysis. Called by
`run-diagnostics.sh --scope full|telemetry`, but can also be invoked directly
for standalone diagnosis.

```bash
./scripts/analyze-dev-flow-telemetry.sh --window 30d
./scripts/analyze-dev-flow-telemetry.sh --window 7d --config /path/to/skill-config.json
```

Output JSON schema:

```json
{
  "window": "30d",
  "since": "2026-03-12T...",
  "total_dev_flow_runs": 42,
  "distributions": {
    "shape": {"micro": 12, "standard": 24, "complex": 6, "unknown": 0},
    "merge_tier": {"AUTO": 5, "REVIEW": 30, "HOLD": 7, "unknown": 0},
    "eval_iter": {"max": 10, "cap": 10, "at_cap_count": 3},
    "plan_iter": {"max": 7, "cap": 8, "at_cap_count": 0},
    "gate_policy": {"deterministic-only": 0, "llm-major-advisory": 40, "llm-major-blocking": 2, "llm-autonomous": 0, "unknown": 0},
    "iterate_status": {"lgtm": 30, "stuck": 4, "fix_failed": 3, "max_reached": 1, "unknown": 0, "total": 38}
  },
  "anomalies": [
    {"type": "cap_pinned", "severity": "warn", "count": 3, "detail": {"...": "..."}},
    {"type": "iterate_unhealthy", "severity": "warn", "rate": 0.21, "detail": {"...": "..."}},
    {"type": "micro_nonfiring", "severity": "skipped", "reason": "insufficient_data", "detail": {"...": "..."}}
  ]
}
```

## Tests

```bash
bats dev-flow-doctor/scripts/analyze-dev-flow-telemetry.bats
bats dev-flow-doctor/scripts/run-diagnostics.bats
```

Fixture-based unit tests (相対日付生成、日付経過によるテスト崩壊なし) validate the
shape/merge_tier/gate_policy/eval_iter/plan_iter/iterate_status distributions,
the `.skill == "dev-flow"` vs `iterate_status`-only denominator split
(pr-iterate standalone entries must not appear in `merge_tier`), and the 3
anomaly detections (cap_pinned / iterate_unhealthy / micro_nonfiring including
the insufficient-data skip path).

## References

- [Diagnostic Checks](references/diagnostic-checks.md) -- journal-based checks (Check 1–7) + dev-flow telemetry health
- [Health Scoring](references/health-scoring.md) -- Scoring formula including telemetry anomaly penalty + baseline regression penalty (max -15)
- [Baseline Comparison](references/baseline-comparison.md) -- AC4/AC5 snapshot schema, compare semantics, CI 運用パターン
- [Responsibility Split](references/responsibility-split.md) -- Boundary vs skill-retrospective

## Examples

```bash
# Full health check (includes telemetry anomalies)
/dev-flow-doctor

# Focused telemetry check, last 7 days
/dev-flow-doctor --scope telemetry --window 7d

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
