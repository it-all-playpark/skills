# Plan-Review Loop (Evaluator-Optimizer Pattern)

Phase 3 → Phase 3b は **evaluator-optimizer ループ**として最大 **3 iteration** 回る（Anthropic: Building effective agents 推奨パターン）。

詳細フロー・Output JSON schema・reset コマンドは [`evaluate-retry.md`](evaluate-retry.md#plan-review-loop-phase-3b--evaluator-optimizer) を参照。本ドキュメントは dev-kickoff 側の運用ルール（ループ遷移・escalation・stuck detection・config・後方互換）をまとめる。

## ループ遷移（verdict ベース）

Phase 3b（dev-plan-review）の Output JSON schema は `{score, verdict, findings, pass_threshold, summary}` に統一されており、dev-kickoff は `verdict` を読んで分岐する:

| verdict | 条件 | 次の動作 |
|---------|------|---------|
| `pass`  | critical/major なし & `score >= pass_threshold(80)` | Phase 4 (dev-implement) へ進行 |
| `revise` | major あり、または `60 <= score < 80` | iteration++ で Phase 3 に戻り、feedback を反映して revise |
| `block`  | critical あり、または `score < 60` | iteration++ で Phase 3 に戻り、方針を再設計 |

## Max Iterations & Escalation

- **`max_iterations = 3`**（既定、`config.plan_review.max_iterations` で override 可）
- 3 iteration で pass に達しない場合、**user escalate**:
  - `kickoff.json` の `phases.3b_plan_review.termination.reason = "max_iterations"` を記録（issue #53 の統一 termination schema）
  - 同時に legacy フィールド `escalated = true` / `escalation_reason = "max_iterations"` も書き込む（1 リリース backward-compat）
  - Skill 出力に `⚠️ Plan did not converge after 3 iterations. Proceeding with last plan; please review manually.` を明示
  - 既定は warning 付きで Phase 4 に進行（ユーザー中断を妨げない）

> `termination` block の schema は [kickoff-schema.md `termination` block](kickoff-schema.md#termination-block-v320-%E3%80%9C-generator-verifier-loop-%E7%B5%82%E4%BA%86%E7%8A%B6%E6%85%8B) を参照。
> Phase 3b と Phase 6 で共通の schema を持ち、`dev-flow-doctor` の Check 9 が verdict_history を横断分析する。

## Stuck Detection（同一 finding 連続）

各 iteration の findings を `$WORKTREE/.claude/plan-review-history.json` に追記し、**同じ `{dimension, topic}` の finding が 2 iteration 連続で残っていたら stuck 判定**。この判定は LLM ではなく `$SKILLS_DIR/_shared/scripts/detect-stuck-findings.py` が mechanical に行う（#48 で決定論化）。

**呼び出し例**:

```bash
STUCK_RESULT=$($SKILLS_DIR/_shared/scripts/detect-stuck-findings.py \
  --history "$WORKTREE/.claude/plan-review-history.json")
ESCALATE=$(echo "$STUCK_RESULT" | jq -r '.escalate')
STUCK_FINDINGS=$(echo "$STUCK_RESULT" | jq -c '.stuck_findings')

if [[ "$ESCALATE" == "true" ]]; then
  # iter 3 を待たず即 escalate — 統一 termination schema (issue #53) 経由で記録
  $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 3b_plan_review done \
    --worktree "$WORKTREE" \
    --termination-reason stuck \
    --stuck-findings "$STUCK_FINDINGS"
  echo "⚠️ Plan-review loop stuck. Same finding persisted across iterations. Escalating to user."
  echo "Stuck findings: $STUCK_FINDINGS"
  # proceed to Phase 4 with warning
fi
```

**仕様**:
- 入力: `plan-review-history.json`（canonical schema。不在・空・破損いずれも `escalate: false` で exit 0）
- 出力: `{escalate, current_iteration, stuck_findings, checked_severities}`
- severity threshold: default `major` 以上（`--min-severity` で override 可能）
- 後方互換: 旧 severity `blocking` は `major` に読み替え
- `topic` が fingerprint として働くため、dev-plan-review は**同じ問題には同じ topic 文字列**を使う運用（dev-plan-review SKILL.md に明記済み）

## Feedback 受け渡し

- Phase 3b の Output JSON 全体を `$WORKTREE/.claude/plan-review-feedback.json` に書き出す（dev-plan-impl が retry 時に読む）
- 並行して `$WORKTREE/.claude/plan-review-history.json` に iteration ごとの結果を追記（stuck 検出用）。canonical schema は以下:
  ```jsonc
  [
    {
      "iteration": 1,                     // integer, 1-indexed
      "score": 72,                        // integer 0–100
      "verdict": "revise",                // "pass" | "revise" | "block"
      "findings": [                       // dev-plan-review Output JSON の findings をそのまま保存
        { "severity": "major", "dimension": "edge_cases", "topic": "Empty-input handling unspecified",
          "description": "...", "suggestion": "..." }
      ]
    }
  ]
  ```

## Config

`kickoff.json` の `config.plan_review` で override 可能（省略時は既定値）:

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

- `max_diff_ratio`: iteration > 1 の `dev-plan-impl` で前回 plan と今回 plan の行差分比が超えたら warning（`check-diff-scale.sh`）。default 0.5。

## 後方互換

旧 schema（`verdict: "fail"`, `severity: "blocking" | "non-blocking"`）を返す古い dev-plan-review 実装がある場合は次のように読み替える:

- `fail` → `revise`（critical 相当の finding がある場合は `block`）
- `blocking` → `major`（critical 級は `critical` に昇格）
- `non-blocking` → `minor`

## Fork failure

dev-plan-review の `context:fork` 起動自体が失敗した場合は 1 回 retry、さらに失敗したら warning 付きで Phase 4 に進む（既存挙動を維持）。
