# Diagnostic Checks

## Check 2: Failure & Partial Distribution

Analyze journal entries for both `failure` AND `partial` outcomes:

```bash
# Include both failure and partial outcomes
$SKILLS_DIR/skill-retrospective/scripts/journal.sh query --skill dev-flow --limit 200 | \
  jq '[.[] | select(.outcome == "failure" or .outcome == "partial")] |
    group_by(.error.phase // "unknown") |
    map({phase: .[0].error.phase // "unknown", count: length, outcomes: (group_by(.outcome) | map({outcome: .[0].outcome, count: length}))}) |
    sort_by(-.count)'
```

`error.phase` は dev-flow workflow の phase 名（`Setup` / `Analyze` / `Plan` / `Implement` /
`Validate` / `Security floor` / `Evaluate` / `PR` / `Merge tier`）を取る。

| Pattern | Recommendation |
|---------|----------------|
| `Implement` phase > 30% | Plan の粒度・自明性判定を見直す（plan-reviewer loop の収束状況を確認） |
| `Validate` phase > 40% | test green 化のリトライ設計を見直す、静的解析を implement 前段に前倒し |
| `Setup` phase > 10% | worktree isolation / env bootstrap（`_shared/scripts/ensure-worktree-deps.sh`）を確認 |
| `Analyze` / `Plan` phase issues | shape classification（`classifyShape`）と要件抽出の精度を確認 |

## Check 3: Error Category Distribution

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh stats | jq '.by_category'
```

| Category Dominance | Recommendation |
|--------------------|----------------|
| `env` > 30% | Wire `_shared/scripts/ensure-worktree-deps.sh` into dev-flow.js Setup phase |
| `lint` > 40% | Add auto-fix to the Validate phase, configure stricter editor settings |
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
        map({issue: .context.issue, turns: .duration_turns, shape: (.telemetry.shape // "unknown"), args: .args})
    }'
```

| Finding | Recommendation |
|---------|----------------|
| Outliers correlate with `complex` shape runs | Expected — complex issue の plan-review / evaluate ループが turn 数を押し上げる |
| Outliers in `micro` / `standard` shape runs | Investigate: likely validation failures or unexpectedly complex implementations |
| Average > 8 turns | Overall pipeline may need optimization |
| Average < 5 turns | Pipeline is efficient |

## Check 8: Dev-Flow Telemetry Distribution & Anomaly Detection (Journal-Driven)

dev-flow / pr-iterate が journal に書き出す telemetry（`shape` / `merge_tier` /
`eval_iter` / `plan_iter` / `gate_policy` / `iterate_status`）を集計し、分布と
3 種の anomaly を検出する。旧 v1 の family skill 集計（8 skill 固定リスト前提の
dead phase / stuck skill / bottleneck / disconnected skill）は廃止され、
workflow 化された dev-flow が実際に記録する telemetry 値のみを対象にする。

```bash
# Full (既定 window 30d, skill-config.json で上書き可能)
$SKILLS_DIR/dev-flow-doctor/scripts/analyze-dev-flow-telemetry.sh --window 30d

# run-diagnostics 経由
$SKILLS_DIR/dev-flow-doctor/scripts/run-diagnostics.sh --scope telemetry --window 7d
```

### 分布集計

| 分布 | 分母 | 説明 |
|------|------|------|
| `shape` | `skill == "dev-flow"` の entry | micro / standard / complex / unknown |
| `merge_tier` | `skill == "dev-flow"` の entry | AUTO / REVIEW / HOLD / unknown（pr-iterate standalone entry は `merge_tier == "PR_ITERATE"` かつ `skill == "pr-iterate"` のため自然に対象外） |
| `eval_iter` / `plan_iter` | `skill == "dev-flow"` の entry | max 値・cap（`eval_iter_cap` / `plan_iter_cap`）・cap 到達件数 |
| `gate_policy` | `skill == "dev-flow"` の entry | deterministic-only / llm-major-advisory / llm-major-blocking / llm-autonomous / unknown |
| `iterate_status` | `.telemetry.iterate_status != null` の全 entry（dev-flow + pr-iterate 両方） | lgtm / stuck / fix_failed / max_reached / ci_error / ci_pending / review_contract_error / unknown |

欠落フィールドは `unknown` バケットへ計上する（fail-safe。die しない）。

### 検出カテゴリ（anomaly 3 種）

| anomaly | severity | 条件 | 推奨アクション |
|---------|----------|------|---------------|
| **cap_pinned** | `warn` | dev-flow entry の `eval_iter >= eval_iter_cap`（既定 10）または `plan_iter >= plan_iter_cap`（既定 8）が 1 件以上 | 収束しない run が cap で打ち切られている。該当 issue の plan/evaluate の差し戻し内容（frozen target・topic-stuck 判定）を確認 |
| **iterate_unhealthy** | `warn` | 非 lgtm（stuck / fix_failed / max_reached / ci_error / review_contract_error）の割合が `iterate_unhealthy_rate`（既定 0.30）を超え（分母は ci_pending を除外した effective_total）、かつ effective_total が `iterate_min_runs`（既定 3）以上 | pr-iterate の review ⇄ fix ループが健全に収束していない。pr-reviewer の finding 傾向・critical/major-always-blocks の影響、review decision と blocking findings の矛盾再発によるエスカレーション、または CI 未設定/pending が多い場合は CI 整備状況を確認 |
| **micro_nonfiring** | `warn`（`skipped` は insufficient_data） | dev-flow の総 run 数が `micro_min_runs`（既定 10）以上あるにもかかわらず `shape: micro` の run が 0 件。run 数が `micro_min_runs` 未満のときは `severity: "skipped"`, `reason: "insufficient_data"` を明示出力し判定しない | classifyShape の micro floor 判定が過剰に安全側へ寄っていないか確認（`estimated_change_file_count` / `acceptance_criteria` 欠落・breaking 検出の誤爆有無） |

### window オプション

- `--window 7d`: 直近の異常を捕まえたいとき
- `--window 30d`（既定）: 傾向把握
- `--window 14d` / `--window 2w`: 週次レビュー用
- 任意の `Nd` / `Nw` / `Nm` フォーマットを受け付ける（`parse_since` と同じ）

### 閾値の設定

すべての閾値は `skill-config.json` の `dev-flow-doctor.thresholds` から読み込む
（`eval_iter_cap` / `plan_iter_cap` / `iterate_unhealthy_rate` / `iterate_min_runs` /
`micro_min_runs`）。`--config <path>` で config ファイルを明示指定できる。

### 責務分離

Check 8 は **dev-flow pipeline の telemetry 健全性** に特化している。全 skill を対象にした
汎用的な failure pattern detection や proposal 生成は `skill-retrospective` 側で
行うこと。詳しくは [responsibility-split.md](responsibility-split.md) を参照。
