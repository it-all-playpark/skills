# Evaluate-Retry Loop

After Phase 6 (dev-evaluate) returns evaluation JSON:

## Flow

1. **Record result**: `update-phase.sh 6_evaluate done --eval-result '$JSON' --worktree $PATH`
2. **If `verdict == "pass"`**: Proceed to Phase 7 (git-commit)
3. **If `verdict == "fail"` AND iterations < max_iterations (default 5)**:
   - Read `feedback_level` from the evaluation result
   - If `"design"`: Reset to Phase 3
     ```bash
     $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 6_evaluate done --reset-to 3_plan_impl --worktree $PATH
     ```
     Pass feedback to dev-plan-impl for plan revision
   - If `"implementation"`: Reset to Phase 4
     ```bash
     $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 6_evaluate done --reset-to 4_implement --worktree $PATH
     ```
     Pass feedback to dev-implement for code revision
4. **If max_iterations reached**: Proceed to Phase 7 with warning log
5. **If evaluate fork fails**: Retry once. If still fails, skip evaluation and proceed to Phase 7 with warning. Record error in kickoff.json.

## Plan-Review Loop (Phase 3b — Evaluator-Optimizer)

本ループは Anthropic が [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) で推奨する **evaluator-optimizer** パターンを具体化したもの。最大 3 iteration で plan → review → revise を繰り返し、pass するか escalate するまで回る。

### Output JSON Schema（dev-plan-review → dev-kickoff I/F）

```jsonc
{
  "score": 85,
  "verdict": "pass",        // "pass" | "revise" | "block"
  "pass_threshold": 80,
  "findings": [
    {
      "severity": "major",  // "critical" | "major" | "minor"
      "dimension": "architecture",
      "topic": "Missing rollback strategy",   // stuck fingerprint
      "description": "...",
      "suggestion": "..."
    }
  ],
  "summary": "..."
}
```

### State Machine

```
          ┌──────────────────────────────┐
          ▼                              │
   ┌─────────────┐                       │
   │ Phase 3     │                       │
   │ plan-impl   │                       │
   └──────┬──────┘                       │
          │ impl-plan.md written         │
          ▼                              │
   ┌─────────────┐                       │
   │ Phase 3b    │                       │
   │ plan-review │                       │
   └──────┬──────┘                       │
          │ Output JSON                  │
          ▼                              │
   ┌─────────────┐                       │
   │ Parse       │                       │
   │ verdict     │                       │
   └──────┬──────┘                       │
          │                              │
    ┌─────┴──────┬──────────────┐        │
    ▼            ▼              ▼        │
 [pass]    [revise/block]   [stuck?]     │
    │            │              │        │
    │            ▼              ▼        │
    │       iter < 3?      [escalate]    │
    │         / \                        │
    │      yes   no                      │
    │       │    │                       │
    │       │    ▼                       │
    │       │ [escalate]                 │
    │       │                            │
    │       │ write feedback.json        │
    │       │ append history.json        │
    │       └────────────────────────────┘
    ▼
 Phase 4
```

### Flow

1. **Record result**: `update-phase.sh 3b_plan_review done --worktree $PATH`（記録時に Output JSON 全体を保存）
2. **Parse verdict**（`config.plan_review.pass_threshold` 既定 80）:
   - `verdict == "pass"` → **Phase 4 (dev-implement)** に進行
   - `verdict == "revise" | "block"` → 次ステップへ
3. **Append history**: `plan-review-history.json` に canonical schema `{"iteration": <int>, "score": <int>, "verdict": "pass"|"revise"|"block", "findings": [...]}` を追記（配列に push）。`findings` は dev-plan-review Output JSON の findings をそのまま保存
4. **Stuck detection**: iteration N と N-1 の findings を比較し、同じ `{dimension, topic}` が両方に存在すれば **stuck escalate** して iter 3 を待たずに終了
5. **Max iterations check**: `iteration >= max_iterations (既定 3)` なら **max_iterations escalate** して終了
6. **Revise**: 上記どちらでもなければ、
   - `plan-review-feedback.json` に Output JSON 全体を書き出す
   - `update-phase.sh 3b_plan_review done --reset-to 3_plan_impl --worktree $PATH`
   - Phase 3 に戻り、dev-plan-impl が feedback を読んで revise する
7. **Fork failure**: dev-plan-review の context:fork 起動自体が失敗 → 1 回 retry → 依然失敗なら warning 付きで Phase 4 に進行

### Stuck Detection Script

Stuck detection is delegated to `$SKILLS_DIR/_shared/scripts/detect-stuck-findings.py` to eliminate LLM judgement drift (#48). dev-kickoff reads the script's JSON output and branches on `.escalate`.

**CLI**:

```
detect-stuck-findings.py --history <plan-review-history.json> [--min-severity critical|major|minor]
```

**Input**: `plan-review-history.json` (canonical schema below). Missing file, empty array, or corrupt JSON all yield `escalate: false` (exit 0) so the loop never breaks on telemetry problems.

**Output JSON** (stdout):

```json
{
  "escalate": true,
  "current_iteration": 2,
  "stuck_findings": [
    {"dimension": "architecture", "topic": "Missing rollback strategy"}
  ],
  "checked_severities": ["critical", "major"]
}
```

**Algorithm** (equivalent to the legacy pseudo-code, now mechanically enforced):

1. `current_iteration = len(history)`
2. If `current_iteration < 2` -> `escalate: false`
3. For the last two iterations, build fingerprint sets `{(dimension, topic)}` from findings whose severity is `>= min_severity` (default `major`). Legacy `blocking` aliases to `major`; `non-blocking` aliases to `minor`.
4. `stuck = prev_keys & curr_keys`
5. `escalate = bool(stuck)`

**Call example from dev-kickoff**:

```bash
STUCK_RESULT=$($SKILLS_DIR/_shared/scripts/detect-stuck-findings.py \
  --history "$WORKTREE/.claude/plan-review-history.json")
if [[ "$(echo "$STUCK_RESULT" | jq -r .escalate)" == "true" ]]; then
  STUCK=$(echo "$STUCK_RESULT" | jq -c .stuck_findings)
  $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 3b_plan_review done \
    --worktree "$WORKTREE" --escalated true --escalation-reason stuck --stuck-findings "$STUCK"
fi
```

> 参考: 以前は `references/evaluate-retry.md` に下記の擬似 Python コードを載せていた。現在は上記スクリプトが同等ロジックを実装している。
>
> ```python
> def is_stuck(history, current_iteration):
>     if current_iteration < 2:
>         return False
>     prev = history[current_iteration - 2]["findings"]
>     curr = history[current_iteration - 1]["findings"]
>     prev_keys = {(f["dimension"], f["topic"]) for f in prev
>                  if f["severity"] in ("critical", "major")}
>     curr_keys = {(f["dimension"], f["topic"]) for f in curr
>                  if f["severity"] in ("critical", "major")}
>     return bool(prev_keys & curr_keys)
> ```

### Escalation Output Example

```
⚠️ Plan-review loop escalated
  reason: stuck
  iterations: 2
  stuck_findings:
    - architecture / "Missing rollback strategy"
  last_score: 68
  decision: proceeding to Phase 4 with warning (manual review recommended)
```

```
⚠️ Plan-review loop escalated
  reason: max_iterations
  iterations: 3
  last_score: 76
  last_verdict: revise
  decision: proceeding to Phase 4 with warning (manual review recommended)
```

### Config Override

```json
{
  "config": {
    "plan_review": {
      "max_iterations": 3,
      "pass_threshold": 80,
      "escalate_on_stuck": true,
      "max_diff_ratio": 0.5
    }
  }
}
```

- `max_diff_ratio`: iteration > 1 で dev-plan-impl が書き直した plan と前回 plan の差分比率が超えたら warning（`dev-plan-impl/scripts/check-diff-scale.sh`）。default 0.5。非数値を入れると起動時にエラーで fail する。

### 後方互換

旧 schema を返す古い dev-plan-review 実装が混じる場合の読み替え:

- `verdict: "fail"` → `revise`（critical 級 finding があれば `block` に昇格）
- `severity: "blocking"` → `major`（致命度に応じて `critical`）
- `severity: "non-blocking"` → `minor`
