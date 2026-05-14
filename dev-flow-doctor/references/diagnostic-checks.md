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
| Phase 1 (prepare) > 10% | Check worktree creation (dev-kickoff-worker / dev-contract-worker), env-mode settings |
| Phase 2 (analyze) issues | Check dev-issue-analyze / dev-decompose flow control |

## Check 3: Error Category Distribution

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh stats | jq '.by_category'
```

| Category Dominance | Recommendation |
|--------------------|----------------|
| `env` > 30% | Ensure dev-env-setup runs within dev-kickoff-worker after worktree checkout |
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

## Check 8: Dev-Flow Family Connector Health (Journal-Driven)

dev-flow ファミリー 8 skill（既定: `dev-kickoff`, `dev-implement`, `dev-validate`,
`dev-integrate`, `dev-evaluate`, `pr-iterate`, `pr-fix`, `night-patrol`）に限定して、
journal から以下 4 カテゴリを検出する。

```bash
# Full (既定 window 30d, skill-config.json で上書き可能)
$SKILLS_DIR/dev-flow-doctor/scripts/analyze-dev-flow-family.sh --window 30d

# run-diagnostics 経由
$SKILLS_DIR/dev-flow-doctor/scripts/run-diagnostics.sh --scope family --window 7d
```

### 検出カテゴリ

| カテゴリ | 定義 | 推奨アクション |
|---------|------|---------------|
| **dead phase** | window 内で `success` が 0 件の family skill | 呼び出し経路を確認。parent orchestrator（例: dev-kickoff）から実際に呼ばれているか、phase 遷移が skip されていないかを検証 |
| **stuck skill** | `(failure + partial) / total > 30%` かつ `total >= 3` | `/skill-retrospective` を走らせ proposal を生成、頻出する error category（lint/test/env 等）を直近の failure で確認 |
| **bottleneck** | `avg(duration_turns)` 上位 3 skill | 実行時間が異常に長い skill を特定し、input 長 / tool 選定 / subagent fork コストを点検 |
| **disconnected skill** | window 内で自身の entry が 0 件かつ parent skill（hook-capture の Skill tool invocation）で一度も参照されていない | connector が成立していない。orchestrator の分岐条件を確認、または deprecated なら skill を整理 |

### window オプション

- `--window 7d`: 直近の異常を捕まえたいとき
- `--window 30d`（既定）: 傾向把握
- `--window 14d` / `--window 2w`: 週次レビュー用
- 任意の `Nd` / `Nw` / `Nm` フォーマットを受け付ける（`parse_since` と同じ）

### 責務分離

Check 8 は **dev-flow 系 skill の連携健全性** に特化している。全 skill を対象にした
汎用的な failure pattern detection や proposal 生成は `skill-retrospective` 側で
行うこと。詳しくは [responsibility-split.md](responsibility-split.md) を参照。

## Check 9: Integration Feedback（再発 conflict pattern）

`_shared/integration-feedback.json` を pub/sub 型の event store として読み、
`dev-integrate` が過去に記録した conflict / integration_failure から **再発している
file / directory prefix** を抽出する。

- 実装: `run-diagnostics.sh` の `run_feedback_checks` + `dev-decompose/scripts/analyze-past-conflicts.sh`
- 閾値: default `min_occurrences=3`、`limit=100` events
- 出力: `checks.integration_feedback = { status, total_events, recurring_files[], recurring_prefixes[] }`
- 減点: `recurring_files` あり -3、`recurring_prefixes` あり -2、合計 -5 まで

### 目的

- 同じ file が繰り返し conflict する場合、decomposition 戦略が file boundary を誤っている可能性が高い
- doctor は warning として surface し、次回 `dev-decompose --dry-run` への hint として
  `analyze-past-conflicts.sh` 経由で自動反映される
- event store が空 / 壊れている場合は `status: "no_data"` で減点なし

### 関連パターン

[`_shared/references/integration-feedback.md`](../../_shared/references/integration-feedback.md)
で event store のスキーマ・書き込みパス・学習ループ全体を解説している。

## Check 10: Termination Loop Health (kickoff.json-driven) — issue #53

dev-kickoff の 2 つの evaluator-optimizer ループ（Phase 3 ⇄ 3b / Phase 4-5 ⇄ 6）が
各 worktree の `kickoff.json` に書き出した `termination` block を横断分析する。
verdict_history 履歴から「loop が健全に収束したか」「同一 feedback_target が繰り返されていないか」を検出する。

```bash
# kickoff.json 横断分析 (既定 worktree-base: $REPO_ROOT/../$(basename $REPO_ROOT)-worktrees)
$SKILLS_DIR/dev-flow-doctor/scripts/analyze-termination-loops.sh

# worktree-base を明示
$SKILLS_DIR/dev-flow-doctor/scripts/analyze-termination-loops.sh --worktree-base /path/to/worktrees

# run-diagnostics 経由 (scope full / family)
$SKILLS_DIR/dev-flow-doctor/scripts/run-diagnostics.sh --scope family
```

### 検出パターン

| pattern | 定義 | 推奨アクション |
|---------|------|---------------|
| **repeated_feedback_target** | Phase 6 `verdict_history` で同一 `feedback_target` が **2 iteration 連続** | 同じ層（design/implementation）の feedback が繰り返されている → もう一段上のレイヤー（例: design 連続なら issue 自体の要件）を疑う |
| **max_iterations** | `termination.reason == "max_iterations"` | 最大 iteration で収束しなかった。issue のサイズ見直し・分解検討 |
| **stuck** (3b のみ) | `termination.reason == "stuck"` | Plan-Review で同一 finding が 2 iteration 残った → 計画の根本見直し |
| **fork_failure** | `termination.reason == "fork_failure"` | verifier (dev-plan-review / dev-evaluate) の fork 起動に失敗 → tooling issue 調査 |

### 出力 JSON schema

```jsonc
{
  "worktree_base": "/path/to/skills-worktrees",
  "checked_worktrees": 3,
  "findings": [
    {
      "worktree": "/path/to/skills-worktrees/feature-issue-53-m",
      "issue": 53,
      "phase": "6_evaluate",
      "pattern": "repeated_feedback_target",
      "feedback_target": "design",
      "occurrences": 2,
      "message": "同一 feedback_target (design) が 2 iteration 連続で発生 → 設計問題の可能性"
    }
  ]
}
```

### スコアリングへの影響

Check 10 の findings は現時点では **health score 計算に寄与しない**（informational のみ）。
スコア組み込みは別 issue で扱う。
