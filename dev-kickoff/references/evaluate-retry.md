# Evaluate-Retry Loop

After Phase 6 (dev-evaluate) returns evaluation JSON:

## Generator status branching (issue #92)

Phase 5 (dev-validate) と Phase 6 (dev-evaluate) の合間に、`dev-implement` worker が返した
**4 値 status enum** (`DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` / `NEEDS_CONTEXT`) を読み取り、
以降の挙動を分岐する。本ループは status を最初に消費し、その後の評価結果と組み合わせる。

| Generator status | Phase 5/6 挙動 |
|---|---|
| `DONE` | 通常通り Phase 6 (dev-evaluate) を実行（既存挙動） |
| `DONE_WITH_CONCERNS` | Phase 6 に `focus_areas = concerns[]` を渡す。dev-evaluate は `focus_areas` を受け取った場合、その領域を重点監査する |
| `BLOCKED` | **同アプローチでの retry を禁止**する。`update-phase.sh 6_evaluate done --reset-to 3_plan_impl --worktree $PATH` で Phase 3 に戻し、`plan-review-feedback.json` に `blocking_reason` を **dev-plan-review schema 互換の findings[] 形式**（`severity: critical`, `dimension: approach_mismatch`）に正規化して書き込み、dev-plan-impl に渡す（下記 "BLOCKED feedback の整形" を参照） |
| `NEEDS_CONTEXT` | Phase 4 に再 dispatch、`missing_context[]` を補足情報として paste する。連続 2 回 `NEEDS_CONTEXT` を観測したら human escalate (warning) して Phase 6 を skip。3 回目以降は dispatch しない |

### BLOCKED feedback の整形

dev-plan-impl は `plan-review-feedback.json` を `findings[]` schema で読むため、BLOCKED 時に
`blocking_reason` 文字列を生で書き込むと dev-plan-impl が見落とす（schema mismatch）。orchestrator は以下の形に正規化してから書き込む:

```jsonc
{
  "score": 0,
  "verdict": "block",
  "pass_threshold": 80,
  "generator_status": "BLOCKED",
  "findings": [
    {
      "severity": "critical",
      "dimension": "approach_mismatch",
      "topic": "<blocking_reason の先頭 60 文字>",
      "description": "<blocking_reason 全文>",
      "suggestion": "同アプローチでは進行不可。代替設計を立案すること（現アプローチの再試行は禁止）。"
    }
  ],
  "summary": "Generator returned BLOCKED. Plan must be redesigned with a different approach."
}
```

詳細消費規約: [`../../dev-plan-impl/SKILL.md`](../../dev-plan-impl/SKILL.md#blocked-hand-off-phase-6--3-reset-issue-92)。
ベース必須フィールド一覧は
[`_shared/references/subagent-dispatch.md`](../../_shared/references/subagent-dispatch.md#4-値-status-enum)
を参照。

## Flow

1. **Record iteration**: `update-phase.sh 6_evaluate in_progress --eval-result '$JSON' --worktree $PATH`

   `--eval-result` は `phases.6_evaluate.iterations[]` に eval_result 全体を append すると同時に、
   **`phases.6_evaluate.termination.verdict_history`** にも
   `{iteration, verdict, feedback_target}` を同期的に append する（issue #53）。

2. **If `verdict == "pass"`**: Record termination and proceed to Phase 7 (git-commit).

   ```bash
   $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 6_evaluate done \
     --worktree $PATH \
     --termination-reason converged \
     --termination-final-verdict pass
   ```

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

4. **If max_iterations reached**: Record termination with reason `max_iterations` and proceed to Phase 7 with warning log.

   ```bash
   $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 6_evaluate done \
     --worktree $PATH \
     --termination-reason max_iterations \
     --termination-final-verdict fail
   ```

5. **If evaluate fork fails**: Retry once. If still fails, skip evaluation and proceed to Phase 7 with warning.

   ```bash
   $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 6_evaluate done \
     --worktree $PATH \
     --termination-reason fork_failure
   ```

> `termination` block の schema は [kickoff-schema.md](kickoff-schema.md#termination-block-v320-%E3%80%9C-generator-verifier-loop-%E7%B5%82%E4%BA%86%E7%8A%B6%E6%85%8B) を参照。
> Phase 3b / Phase 6 で共通の schema を持ち、`dev-flow-doctor` が `verdict_history` を横断分析する。

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
   - `verdict == "pass"` → `--termination-reason converged` で termination 記録 → **Phase 4 (dev-implement)** に進行
     ```bash
     $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 3b_plan_review done \
       --worktree $PATH \
       --termination-reason converged \
       --termination-final-verdict pass \
       --append-verdict "$(jq -c '{iteration:'$ITER',verdict:.verdict,score:.score}' review.json)"
     ```
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
3. For the last two iterations, build fingerprint sets `{(dimension, topic)}` from findings whose severity is `>= min_severity` (default `major`).
4. `stuck = prev_keys & curr_keys`
5. `escalate = bool(stuck)`

**Call example from dev-kickoff**:

```bash
STUCK_RESULT=$($SKILLS_DIR/_shared/scripts/detect-stuck-findings.py \
  --history "$WORKTREE/.claude/plan-review-history.json")
if [[ "$(echo "$STUCK_RESULT" | jq -r .escalate)" == "true" ]]; then
  # Unified termination schema (issue #53)
  $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 3b_plan_review done \
    --worktree "$WORKTREE" \
    --termination-reason stuck
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
