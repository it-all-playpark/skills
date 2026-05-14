---
name: dev-plan-impl
description: |
  Create implementation plan from issue analysis (Opus planner).
  Use when: (1) dev-kickoff Phase 3, (2) implementation planning before coding,
  (3) keywords: 実装計画, implementation plan, design plan
  Accepts args: <issue-number> --worktree <path>
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(~/.claude/skills/dev-plan-impl/scripts/*)
  - Bash(~/.claude/skills/dev-kickoff/scripts/*)
  - Bash(~/.claude/skills/_shared/scripts/*)
  - Bash(~/.claude/skills/skill-retrospective/scripts/*)
  - Bash(cp:*)
  - Bash(mv:*)
  - Bash(jq:*)
model: opus
effort: max
context: fork
---

# Plan Implementation

Create a concrete implementation plan that the Generator (dev-implement) will follow.

## Usage

```
/dev-plan-impl <issue-number> --worktree <path>
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | GitHub issue number |
| `--worktree` | required | Worktree path for implementation |

## Workflow

```
1. Read inputs → 2. Check feedback → 3. Analyze codebase → 4. Create plan → 5. Write plan
```

## Step 1: Read Inputs

1. **Issue requirements**: Read `$WORKTREE/.claude/kickoff.json` → `phases.2_analyze.result`
2. **Config**: Read `$WORKTREE/.claude/kickoff.json` → `config` (testing strategy, design approach)
3. **Shared findings** (parallel mode only): when `--task-id` is set, read unacked findings from other workers:

   ```bash
   FINDINGS=$($SKILLS_DIR/_shared/scripts/flow-read-findings.sh \
     --flow-state "$FLOW_STATE" --task-id "$TASK_ID" --unacked-only --ack)
   ```

   Each finding has `category`, `title`, `description`, `scope`, `action_required`. Include the applicable ones in the plan's "Architecture Decisions" or "Notes" section so the Generator respects other workers' decisions. `--ack` marks them as read. See [`_shared/references/shared-findings.md`](../_shared/references/shared-findings.md).

## Step 2: Check for Feedback (Retry)

### Evaluator Feedback (Phase 6)

If `$WORKTREE/.claude/kickoff.json` → `phases.6_evaluate.iterations[]` has entries:
- Read the latest iteration's `feedback` array
- These are specific issues the Evaluator found with the previous implementation
- The feedback_level should be `"design"` (otherwise dev-implement handles it directly)
- Address each feedback item in the new plan's Architecture Decisions and Notes for Retry sections

### Plan Review Feedback (Phase 3b — Evaluator-Optimizer Loop)

If `$WORKTREE/.claude/plan-review-feedback.json` exists, this is a **revise iteration** of the evaluator-optimizer loop (see dev-kickoff Plan-Review Loop).

feedback ファイルは dev-plan-review の Output JSON を丸ごと保持する。以下の schema を持つ:

```jsonc
{
  "score": 72,
  "verdict": "revise",           // "pass" | "revise" | "block"
  "pass_threshold": 80,
  "findings": [
    { "severity": "critical" | "major" | "minor",
      "dimension": "...",
      "topic": "...",
      "description": "...",
      "suggestion": "..." }
  ],
  "summary": "..."
}
```

1. **優先順位**: `critical` → `major` → `minor` の順に対応する。critical は**必ず**1 件残らず解消する。major は可能な限り解消する。minor は余裕があれば対応（無視しても可）。
2. **各 finding の反映**: `topic` を見出しに、`suggestion` を元に plan の該当箇所を修正する。「どう直したか」を Architecture Decisions または Notes for Retry に 1 行で残す（次回の stuck 検出に影響する）。
3. **Revise モード**: iteration > 1 の場合、前回 plan を土台に**差分 revise** すること。無関係な章をゼロから書き直して迷子にならないよう、指摘点のみ書き換える。この差分制約は Step 5b (`check-diff-scale.sh`) が mechanical に検証し、閾値超過で warning を記録する（non-blocking）。
4. **Iteration 履歴**: `$WORKTREE/.claude/plan-review-history.json` が存在する場合、過去 iteration の findings を確認し、同じ `{dimension, topic}` が繰り返し残っている場合は revise 戦略を変えること（同じ直し方では stuck に突入する）。
5. **後方互換**: 旧 schema（`verdict: "fail"` / `severity: "blocking" | "non-blocking"`）を持つ feedback も読み取り可能にする。`fail` は `revise` と同等、`blocking` は `major` と同等扱いにする。

### Evaluator Feedback 消費時との併存

Evaluator Feedback（Phase 6）と Plan Review Feedback（Phase 3b）が両方存在する場合、**Plan Review Feedback を優先**して先に反映し、残った範囲で Evaluator Feedback を重ねる。

どちらも存在しない場合（first run）、このステップはスキップ。

## Step 3: Analyze Codebase

1. Understand the existing code structure in the worktree
2. Identify files that need to be created or modified
3. Check for existing patterns, conventions, and dependencies
4. Consider the testing strategy (from config.testing)

## Step 4: Create Implementation Plan

Following [Plan Format](references/plan-format.md):
- Be specific about file paths and changes
- Include architecture decisions with rationale
- List edge cases with handling strategies
- Note dependencies

### Self-Contained Task Descriptions (issue #92)

各 task 本文 / File Changes 行 / Test Plan 行は**単独で読めるように書く**こと。これは
`dev-kickoff` orchestrator が "Paste, Don't Link" 規約のもとで task body を verbatim paste して
worker に渡すため、worker は周辺 context を持たない状態で paste 本文だけを読むからである。

**禁止表現** (dev-plan-review が `dimension: self_containment` の major finding として flag する):

- `上述の通り` / `上記(に|の)通り` / `前述(の通り|どおり)`
- `Task N と同様` / `Task N と同じ` / `Task N に倣う` / `Task N に準じる`
- `See Task N` / `See Section N` / `same as Task N`

**書き直しの指針**:
- 「Task 2 と同様に Repository パターンで」→ 「Repository パターン (Entity: `Order`, Repo: `OrderRepo`, location: `src/orders/`) で」
- 「上述のとおりエラーハンドリング」→ 「エラーハンドリングは `_lib/error-handler.ts` の `handleApiError` を使う」
- 必要なら同じ説明を **複数 task に重複して書いて構わない**（DRY < self-containment）

**許容例外**:
- コミットメッセージのプレフィックス参照（`feat(dev-...)` 等）
- "上述" を含まない section header（"上記内容について" 等の構造的見出し）

詳細: [Paste, Don't Link](../_shared/references/subagent-dispatch.md#paste-dont-link),
[Plan Review Checklist § 9](../dev-plan-review/references/review-checklist.md#9-plan-self-containment)

## Step 5: Write Plan File

Write the plan to `$WORKTREE/.claude/impl-plan.md`.

If a previous plan exists (retry), **first** copy it to `$WORKTREE/.claude/impl-plan.prev.md` so Step 5b can diff against it, **then** overwrite `impl-plan.md` with the revised plan:

```bash
if [[ -f "$WORKTREE/.claude/impl-plan.md" ]]; then
  cp "$WORKTREE/.claude/impl-plan.md" "$WORKTREE/.claude/impl-plan.prev.md"
fi
# ...write new impl-plan.md here...
```

## Step 5b: Validate Diff Scale (retry only)

If `$WORKTREE/.claude/impl-plan.prev.md` exists (= iteration > 1), run the mechanical diff-scale check to verify this is a **differential revise**, not a full rewrite:

```bash
DIFF_RESULT=$($SKILLS_DIR/dev-plan-impl/scripts/check-diff-scale.sh \
  --worktree "$WORKTREE" \
  --current "$WORKTREE/.claude/impl-plan.md" \
  --previous "$WORKTREE/.claude/impl-plan.prev.md")
DIFF_STATUS=$(echo "$DIFF_RESULT" | jq -r '.status')

if [[ "$DIFF_STATUS" == "warning" ]]; then
  RATIO=$(echo "$DIFF_RESULT" | jq -r '.ratio')
  MAX=$(echo "$DIFF_RESULT" | jq -r '.max_ratio')
  $SKILLS_DIR/dev-kickoff/scripts/append-progress.sh \
    --worktree "$WORKTREE" --phase "3" \
    --note "⚠️ diff-scale warning: ratio=${RATIO} exceeds max=${MAX} (possible full rewrite)"
fi
```

- `check-diff-scale.sh` は常に exit 0 を返すため **非ブロッキング**。
- `status: "skipped"` (first iteration) の場合は何もしない。
- 閾値は `kickoff.json.config.plan_review.max_diff_ratio`（default 0.5）で設定可能。
- 目的はあくまで警告であり、warning が出ても Phase 4 (dev-implement) に進んでよい。ただし次回の dev-plan-review レビュー時に「full rewrite 疑い」として人間レビュー対象になる。

## Step 6: Initialize feature_list (first run only)

Extract features from the plan and write them to `kickoff.json.feature_list` **once**.
This list is immutable — `dev-implement` may only update `status`, never `id` or `desc`.

**手順**:

1. `impl-plan.md` の "Feature List" / "File Changes" / 主要タスクから `F1`, `F2`, ... の単位で feature を抽出
2. `kickoff.json.feature_list` が空配列 (`[]`) の場合のみ書き込み (既に値があれば skip = immutability 尊重)
3. jq で一度だけ書き込む:

```bash
jq --argjson features "$FEATURES_JSON" \
   '.feature_list = (if (.feature_list // [] | length) == 0 then $features else .feature_list end)
    | .updated_at = (now | todate)' \
   "$WORKTREE/.claude/kickoff.json" > "$WORKTREE/.claude/kickoff.json.tmp" \
  && mv "$WORKTREE/.claude/kickoff.json.tmp" "$WORKTREE/.claude/kickoff.json"
```

ここで `$FEATURES_JSON` は `[{"id":"F1","desc":"...","status":"todo"}, ...]` の形式。

4. 初期化後、`append-progress.sh` で trace 記録:

```bash
$SKILLS_DIR/dev-kickoff/scripts/append-progress.sh \
  --worktree "$WORKTREE" --phase "3" --note "impl-plan.md 作成、feature_list (N 件) 初期化"
```

**Retry 時**: `feature_list` が既に存在する場合は touch しない。plan の revision でも feature の追加・削除・rename はしない（新しい plan が必要な場合は issue 側で対応）。

## Important

- **Be concrete, not abstract**: The Generator (Sonnet) needs specific instructions it can follow
- **Consider the testing strategy**: If config.testing is "tdd", include test files in File Changes
- **Address all feedback**: On retry, every feedback item from the Evaluator must be addressed
- **Don't over-plan**: Keep the plan focused on what's needed for the issue. YAGNI.

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success (impl-plan.md written)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-plan-impl success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-plan-impl failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" --worktree $WORKTREE
```

## References

- [Plan Format](references/plan-format.md) - Output format specification
