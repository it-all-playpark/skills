---
name: dev-kickoff
description: |
  End-to-end feature development orchestrator using git worktree. Coordinates dev-kickoff-worker, issue-analyze, implement, validate, commit, and create-pr skills.
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
[ ] Phase 1: dev-kickoff-worker (isolation: worktree) → init-kickoff.sh  (REQUIRED unless --task-id)
[ ] Phase 2: Skill: dev-issue-analyze                   (REQUIRED unless --task-id)
[ ] Phase 3: Skill: dev-plan-impl                       (Opus planner)
[ ] Phase 3b: Skill: dev-plan-review                    (Opus reviewer, context:fork)
  → fail → back to Phase 3 (with feedback)
  → pass or max rounds (3) → Phase 4
[ ] Phase 4: Skill: dev-implement                       (Sonnet generator)
[ ] Phase 5: Skill: dev-validate --fix
[ ] Phase 6: Skill: dev-evaluate                        (Opus evaluator, context:fork)
  → fail + design feedback → back to Phase 3
  → fail + implementation feedback → back to Phase 4
  → pass or max iterations (5) → Phase 7
[ ] Phase 7: Skill: git-commit --all
[ ] Phase 8: Skill: git-pr → pr-iterate                 (REQUIRED unless --task-id)
```

## State Management

State persisted in `$WORKTREE/.claude/kickoff.json`. Use `init-kickoff.sh` after Phase 1, `update-phase.sh` for status updates.

**feature_list immutability**: `kickoff.json.feature_list` の `id` と `desc` は書き換え禁止。Phase 3 で一度だけ初期化、以降は `status` のみ更新可能。`status` 更新は `scripts/update-feature.sh`、`progress_log` への追加は `scripts/append-progress.sh` を使用（`Edit` で JSON を直接書き換えない）。

Details: [State Management](references/state-management.md), [kickoff.json Schema](references/kickoff-schema.md)

## Phase Execution

| Phase | Command | Subagent | Parallel Mode |
|-------|---------|----------|---------------|
| 1 | `Agent(subagent_type: dev-kickoff-worker, issue_number: $ISSUE, base_ref: $BASE, mode: single)` | dev-kickoff-worker | SKIP |
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

## Loops

- **Plan-Review Loop (Phase 3 ↔ 3b)**: verdict ベース分岐（pass/revise/block）、max 3 iterations、stuck detection、fork failure retry。詳細: [Plan-Review Loop](references/plan-review-loop.md)
- **Evaluate-Retry Loop (Phase 6 → 3 or 4)**: Phase 6 verdict が `fail` なら design/implementation feedback に応じて Phase 3 or 4 へ戻る。max 5 iterations。詳細: [Evaluate-Retry Loop](references/evaluate-retry.md)

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

When `--task-id` is specified, phases 1-2 and 8 are skipped. Subtask scope is read from flow.json, and workers exchange cross-cutting knowledge via `flow.json.shared_findings[]` (Phase 3 reads unacked, Phase 4/5 appends). Returns minimal `{"task_id", "status"}` JSON.

Details: [Parallel Mode](references/parallel-mode.md), [Shared Findings Pattern](../_shared/references/shared-findings.md)

## Error Handling

Phases 1-2: abort. Phases 3-5: analyze error, retry with context (max 2), then pause. Phase 6: retry once, skip with warning. Phases 7-8: retry once, report manual command.

Details: [Error Handling](references/error-handling.md)

## Journal Logging

ワークフロー完了・失敗時に `skill-retrospective` journal に記録する（success / failure / partial）:

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-kickoff success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE
```

Details: [Journal Logging](references/journal-logging.md)

## Subagent Dispatch Rules

dev-kickoff は Phase 2 / 3b / 5 / 6 で subagent を起動する。各 Task 呼び出しは必須5要素（**Objective** / **Output format** / **Tools** / **Boundary** / **Token cap**）を含むこと。phase 別 prompt 仕様・routing は [Subagent Dispatch Rules](references/subagent-dispatch.md)（共通規約は [`_shared/references/subagent-dispatch.md`](../_shared/references/subagent-dispatch.md)）を参照。

## References

- [kickoff.json Schema](references/kickoff-schema.md) - feature_list / progress_log / decisions 仕様
- [State Management](references/state-management.md) - Init scripts, update commands, state schema, recovery
- [Plan-Review Loop](references/plan-review-loop.md) - Phase 3 ↔ 3b ループ遷移・escalation・stuck detection・config
- [Evaluate-Retry Loop](references/evaluate-retry.md) - Phase 6 verdict に基づく retry フロー
- [Error Handling](references/error-handling.md) - Per-phase error handling, auto-retry protocol
- [Parallel Mode](references/parallel-mode.md) - Subtask scope reading, phase 7 enhancement, return value
- [Phase Details](references/phase-detail.md) - Detailed phase documentation
- [Journal Logging](references/journal-logging.md) - skill-retrospective 呼び出しパターン
- [Subagent Dispatch Rules](references/subagent-dispatch.md) - Phase 2/3b/5/6 の 5要素と routing
- [Shared Subagent Dispatch](../_shared/references/subagent-dispatch.md) - リポジトリ共通規約
