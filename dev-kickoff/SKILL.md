---
name: dev-kickoff
description: |
  End-to-end feature development orchestrator using git worktree. Coordinates git-prepare, issue-analyze, implement, validate, commit, and create-pr skills.
  Use when: starting new feature development from GitHub issue, full development cycle automation with isolated worktree.
  Accepts args: <issue-number> [--testing tdd|bdd] [--design ddd] [--depth minimal|standard|comprehensive] [--base <branch>] [--lang ja|en] [--env-mode hardlink|symlink|copy|none] [--worktree <path>] [--task-id <id>] [--flow-state <path>]
allowed-tools:
  - Bash
  - TodoWrite
  - Skill
  - Task
---

# Kickoff

Orchestrate complete feature development cycle from issue to PR.

## 言語ルール

**`--lang ja`（デフォルト）の場合、PR本文・GitHubコメントは必ず日本語で記述すること。**
- Phase 8（git-pr）で作成するPR body は日本語
- 技術用語・コード識別子・ファイルパスはそのまま

## CRITICAL: Complete All 8 Phases

**DO NOT EXIT until Phase 8 (PR creation) completes and pr-iterate is called.**

**CRITICAL: Phase 1 (Worktree) is MANDATORY unless `--task-id` is specified.**
When `--task-id` is NOT set (= single mode), Phase 1 MUST be executed FIRST. Implementation in the main repository directory is NEVER allowed.

| Phase | Action | Complete When | Single Mode | Parallel Mode (--task-id) |
|-------|--------|---------------|-------------|---------------------------|
| 1 | Worktree creation | Path exists, .env verified | **REQUIRED** | SKIP |
| 2 | Issue analysis | Requirements understood | **REQUIRED** | SKIP |
| 3 | Implementation plan | impl-plan.md created | Execute | Execute |
| 3b | Plan review | Plan approved or revised | Execute | Execute |
| 4 | Implementation | Code written | Execute | Execute |
| 5 | Validation | Tests pass | Execute | Execute |
| 6 | Evaluation | Quality gate passed | Execute | Execute |
| 7 | Commit | Changes committed | Execute | Execute |
| 8 | PR creation | PR URL available | Execute | SKIP |

After Phase 8: Call `Skill: pr-iterate $PR_URL` to complete the workflow.

## Phase Checklist

```
[ ] Phase 1: git-prepare.sh → init-kickoff.sh          (REQUIRED unless --task-id)
[ ] Phase 2: Skill: dev-issue-analyze                   (REQUIRED unless --task-id)
[ ] Phase 3: Skill: dev-plan-impl                       (NEW - Opus planner)
[ ] Phase 3b: Skill: dev-plan-review                    (NEW - Opus reviewer, context:fork)
  → fail → back to Phase 3 (with feedback)
  → pass or max rounds (3) → Phase 4
[ ] Phase 4: Skill: dev-implement                       (Sonnet generator)
[ ] Phase 5: Skill: dev-validate --fix
[ ] Phase 6: Skill: dev-evaluate                        (NEW - Opus evaluator, context:fork)
  → fail + design feedback → back to Phase 3
  → fail + implementation feedback → back to Phase 4
  → pass or max iterations (5) → Phase 7
[ ] Phase 7: Skill: git-commit --all
[ ] Phase 8: Skill: git-pr → pr-iterate                 (REQUIRED unless --task-id)
```

## State Management

State persisted in `$WORKTREE/.claude/kickoff.json`. Use `init-kickoff.sh` after Phase 1, `update-phase.sh` for status updates.

Details: [State Management](references/state-management.md)

## Phase Execution

| Phase | Command | Subagent | Parallel Mode |
|-------|---------|----------|---------------|
| 1 | `$SKILLS_DIR/git-prepare/scripts/git-prepare.sh $ISSUE --base $BASE --env-mode $ENV_MODE` | - | SKIP |
| 1b | `$SKILLS_DIR/dev-kickoff/scripts/init-kickoff.sh ...` | - | SKIP |
| 2 | `Skill: dev-issue-analyze $ISSUE --depth $DEPTH` | Task(Explore) | SKIP |
| 3 | `Skill: dev-plan-impl $ISSUE --worktree $PATH` | - | Execute |
| 3b | `Skill: dev-plan-review $ISSUE --worktree $PATH` | context:fork | Execute |
| 4 | `Skill: dev-implement --testing $TESTING [--design $DESIGN] --worktree $PATH` | - | Execute |
| 5 | `Skill: dev-validate --fix --worktree $PATH` | Task(quality-engineer) | Execute |
| 6 | `Skill: dev-evaluate $ISSUE --worktree $PATH` | context:fork | Execute |
| 7 | `Skill: git-commit --all --worktree $PATH` | - | Execute |
| 8 | `Skill: git-pr $ISSUE --base $BASE --lang $LANG --worktree $PATH` | - | SKIP |

Phase 1: Must execute script. Direct `git worktree add` is prohibited.

## Evaluate-Retry Loop

Phase 6 verdict determines next step: `pass` -> Phase 7, `fail` -> retry from Phase 3 (design feedback) or Phase 4 (implementation feedback). Max 5 iterations. Fork failure -> retry once, then skip with warning.

Details: [Evaluate-Retry Loop](references/evaluate-retry.md)

## Plan-Review Loop (Evaluator-Optimizer Pattern)

Phase 3 → Phase 3b は **evaluator-optimizer ループ**として最大 **3 iteration** 回る（Anthropic: Building effective agents 推奨パターン）。

### ループ遷移（verdict ベース）

Phase 3b（dev-plan-review）の Output JSON schema は `{score, verdict, findings, pass_threshold, summary}` に統一されており、dev-kickoff は `verdict` を読んで分岐する:

| verdict | 条件 | 次の動作 |
|---------|------|---------|
| `pass`  | critical/major なし & `score >= pass_threshold(80)` | Phase 4 (dev-implement) へ進行 |
| `revise` | major あり、または `60 <= score < 80` | iteration++ で Phase 3 に戻り、feedback を反映して revise |
| `block`  | critical あり、または `score < 60` | iteration++ で Phase 3 に戻り、方針を再設計 |

### Max Iterations & Escalation

- **`max_iterations = 3`**（既定、`config.plan_review.max_iterations` で override 可）
- 3 iteration で pass に達しない場合、**user escalate**:
  - `kickoff.json` に `phases.3b_plan_review.escalated = true` と `escalation_reason = "max_iterations"` を記録
  - Skill 出力に `⚠️ Plan did not converge after 3 iterations. Proceeding with last plan; please review manually.` を明示
  - 既定は warning 付きで Phase 4 に進行（ユーザー中断を妨げない）

### Stuck Detection（同一 finding 連続）

各 iteration の findings を `$WORKTREE/.claude/plan-review-history.json` に追記し、**同じ `{dimension, topic}` の finding が 2 iteration 連続で残っていたら stuck 判定**。

- Stuck 時は iter 3 を待たず即 escalate
  - `kickoff.json` に `phases.3b_plan_review.escalated = true`, `escalation_reason = "stuck"`, `stuck_findings: [{dimension, topic}, ...]` を記録
  - Skill 出力に `⚠️ Plan-review loop stuck on: <topic>. Same finding persisted across iterations N-1 and N. Escalating to user.`
- `topic` が fingerprint として働くため、dev-plan-review は**同じ問題には同じ topic 文字列**を使う運用（dev-plan-review SKILL.md に明記済み）

### Feedback 受け渡し

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

### Config

`kickoff.json` の `config.plan_review` で override 可能（省略時は既定値）:

```json
{
  "config": {
    "plan_review": {
      "max_iterations": 3,
      "pass_threshold": 80,
      "escalate_on_stuck": true
    }
  }
}
```

### 後方互換

旧 schema（`verdict: "fail"`, `severity: "blocking" | "non-blocking"`）を返す古い dev-plan-review 実装がある場合は次のように読み替える:

- `fail` → `revise`（critical 相当の finding がある場合は `block`）
- `blocking` → `major`（critical 級は `critical` に昇格）
- `non-blocking` → `minor`

### Fork failure

dev-plan-review の `context:fork` 起動自体が失敗した場合は 1 回 retry、さらに失敗したら warning 付きで Phase 4 に進む（既存挙動を維持）。

Details: [Plan-Review Loop](references/evaluate-retry.md#plan-review-loop-phase-3b)

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | GitHub issue number |
| `--testing` | `tdd` | Implementation approach: tdd (test-first), bdd (behavior-first) |
| `--design` | - | Design approach: ddd (domain modeling) |
| `--depth` | `standard` | Analysis depth |
| `--base` | `dev` | PR base branch |
| `--lang` | `ja` | PR language |
| `--env-mode` | `hardlink` | Env file handling |
| `--worktree` | - | Pre-created worktree path (skips Phase 1) |
| `--task-id` | - | Subtask ID from flow.json (enables parallel mode) |
| `--flow-state` | - | Path to flow.json (read-only reference) |

## Parallel Subtask Mode

When `--task-id` is specified, phases 1-2 and 8 are skipped. Subtask scope read from flow.json. Returns minimal `{"task_id", "status"}` JSON.

Details: [Parallel Mode](references/parallel-mode.md)

## Error Handling

Phases 1-2: abort. Phases 3-5: analyze error, retry with context (max 2), then pause. Phase 6: retry once, skip with warning. Phases 7-8: retry once, report manual command.

Details: [Error Handling](references/error-handling.md)

## Journal Logging

On workflow completion or failure, log execution to skill-retrospective journal:

```bash
# On success (after Phase 8)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

# On failure (at any phase)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" \
  --error-phase <phase> --worktree $WORKTREE

# On partial (completed with manual intervention)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff partial \
  --issue $ISSUE --error-category <category> --error-msg "<message>" \
  --recovery "<what was done>" --recovery-turns $N --worktree $WORKTREE
```

## References

- [State Management](references/state-management.md) - Init scripts, update commands, state schema, recovery
- [Evaluate-Retry Loop](references/evaluate-retry.md) - Detailed evaluate-retry flow with reset commands
- [Error Handling](references/error-handling.md) - Per-phase error handling, auto-retry protocol
- [Parallel Mode](references/parallel-mode.md) - Subtask scope reading, phase 7 enhancement, return value
- [Phase Details](references/phase-detail.md) - Detailed phase documentation
