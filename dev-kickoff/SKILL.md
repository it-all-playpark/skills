---
name: dev-kickoff
description: |
  End-to-end feature development orchestrator. Spawns dev-kickoff-worker (isolation:worktree) and coordinates issue-analyze, plan, implement, validate, evaluate, commit, and create-pr skills.
  Use when: starting new feature development from GitHub issue, full development cycle automation with isolated worktree.
  Accepts args: <issue-number> [--testing tdd|bdd] [--design ddd] [--depth minimal|standard|comprehensive] [--base <branch>] [--lang ja|en] [--env-mode hardlink|symlink|copy|none] [--worktree <path>]
allowed-tools:
  - Bash
  - TodoWrite
  - Skill
  - Task
---

# Kickoff

Orchestrate complete feature development cycle from issue to PR (single mode only).

## 言語ルール

**`--lang ja`（デフォルト）の場合、PR本文・GitHubコメントは必ず日本語で記述すること。**
- Phase 8（git-pr）で作成するPR body は日本語
- 技術用語・コード識別子・ファイルパスはそのまま

## CRITICAL: Complete All 8 Phases

**DO NOT EXIT until Phase 8 (PR creation) completes and pr-iterate is called.**

**CRITICAL: Phase 1 (Worktree) is MANDATORY.**
Implementation in the main repository directory is NEVER allowed.

**Requires**: Claude Code >= 2.1.63 (`isolation: worktree` field support) and `.claude/agents/dev-kickoff-worker.md` present. If missing, dev-kickoff aborts with a clear error.

issue #93 で `--task-id` / `--flow-state` / parallel mode を完全撤廃。複数 issue を並列実行
したい場合は `dev-flow <parent-issue> --child-split` で parent issue を child issue に分解し、
各 child を独立の single-mode dev-kickoff として `run-batch-loop.sh` が消化する。

| Phase | Action | Complete When |
|-------|--------|---------------|
| 1 | Worktree creation via `dev-kickoff-worker` subagent (`isolation: worktree`) | Path exists, .env verified |
| 2 | Issue analysis | Requirements understood |
| 3 | Implementation plan | impl-plan.md created |
| 3b | Plan review | Plan approved or revised |
| 4 | Implementation | Code written |
| 5 | Validation | Tests pass |
| 6 | Evaluation | Quality gate passed |
| 7 | Commit | Changes committed |
| 8 | PR creation | PR URL available |

After Phase 8: Call `Skill: pr-iterate $PR_URL` to complete the workflow.

## Phase Checklist

```
[ ] Phase 1: Agent(dev-kickoff-worker, isolation: worktree)
[ ] Phase 2: Skill: dev-issue-analyze
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
[ ] Phase 8: Skill: git-pr → pr-iterate
```

## State Management

State persisted in `$WORKTREE/.claude/kickoff.json`. Use `init-kickoff.sh` after Phase 1, `update-phase.sh` for status updates.

**feature_list immutability**: `kickoff.json.feature_list` の `id` と `desc` は書き換え禁止。Phase 3 で一度だけ初期化、以降は `status` のみ更新可能。`status` 更新は `scripts/update-feature.sh`、`progress_log` への追加は `scripts/append-progress.sh` を使用（`Edit` で JSON を直接書き換えない）。

Details: [State Management](references/state-management.md), [kickoff.json Schema](references/kickoff-schema.md)

## Phase Execution

| Phase | Command | Subagent |
|-------|---------|----------|
| 1 | `Agent(subagent_type: "dev-kickoff-worker", isolation: "worktree", prompt: <issue/branch/base/mode>)` | `dev-kickoff-worker` |
| 1b | Worker initializes `kickoff.json` itself inside the isolated worktree | - |
| 2 | `Skill: dev-issue-analyze $ISSUE --depth $DEPTH` | Task(Explore) |
| 3 | `Skill: dev-plan-impl $ISSUE --worktree $PATH` | - |
| 3b | `Skill: dev-plan-review $ISSUE --worktree $PATH` | context:fork |
| 4 | `Skill: dev-implement --testing $TESTING [--design $DESIGN] --worktree $PATH` | - |
| 5 | `Skill: dev-validate --fix --worktree $PATH` | Task(quality-engineer) |
| 6 | `Skill: dev-evaluate $ISSUE --worktree $PATH` | context:fork |
| 7 | `Skill: git-commit --all --worktree $PATH` | - |
| 8 | `Skill: git-pr $ISSUE --base $BASE --lang $LANG --worktree $PATH` | - |

Phase 1: Spawn `dev-kickoff-worker` via Agent tool. Direct `git worktree add` is prohibited.

## Phase 1 dispatch

Phase 1 spawns the `dev-kickoff-worker` subagent through the Agent tool with `isolation: worktree`:

```text
Agent(
  subagent_type: "dev-kickoff-worker",
  isolation: "worktree",
  prompt: "issue_number=$ISSUE branch_name=$BRANCH base_ref=$BASE_REF mode=single"
)
```

`mode` は `single` 固定。`parallel` / `merge` は issue #93 で撤廃済み（worker 側でも schema error として即時 reject される）。

The worker runs Phase 1b-8 inside its isolated worktree and returns `{status, branch, worktree_path, commit_sha, pr_url?, phase_failed?, error?}`. On `status: completed`, dev-kickoff records branch + sha and calls `pr-iterate` with the returned `pr_url`.

If the worker definition (`.claude/agents/dev-kickoff-worker.md`) is missing or claude CLI is < 2.1.63, dev-kickoff aborts with an explicit error — there is no fallback path.

See [Phase 1 detail](references/phase-detail.md#phase-1-worktree-creation) for the full worker contract.

## Loops

- **Plan-Review Loop (Phase 3 ↔ 3b)**: verdict ベース分岐（pass/revise/block）、max 3 iterations、stuck detection、fork failure retry。詳細: [Plan-Review Loop](references/plan-review-loop.md)
- **Evaluate-Retry Loop (Phase 6 → 3 or 4)**: Phase 6 verdict が `fail` なら design/implementation feedback に応じて Phase 3 or 4 へ戻る。max 5 iterations。詳細: [Evaluate-Retry Loop](references/evaluate-retry.md)

## Generator Status Branching (issue #92)

Phase 4 (`dev-implement`) は **4 値 status enum** (`DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` / `NEEDS_CONTEXT`)
を含む JSON を返す。dev-kickoff の Phase 5/6 orchestrator はこの status を最初に消費し、以降を分岐する。

| status | 必須追加フィールド | dev-kickoff の挙動 |
|---|---|---|
| `DONE` | (なし) | Phase 6 (dev-evaluate) へ進む |
| `DONE_WITH_CONCERNS` | `concerns: string[]` | Phase 6 に `focus_areas = concerns[]` を渡して重点監査 |
| `BLOCKED` | `blocking_reason: string` | **同アプローチ retry 禁止**。Phase 3 に reset、`blocking_reason` を **findings[] 形式 (`dimension: approach_mismatch`) に正規化**して `plan-review-feedback.json` に書き込み dev-plan-impl に渡す（整形ルール: [evaluate-retry.md](references/evaluate-retry.md#blocked-feedback-の整形)） |
| `NEEDS_CONTEXT` | `missing_context: string[]` | Phase 4 に再 dispatch、`missing_context[]` を補足 paste。連続 2 回で human escalate |

## Phase 4 dispatch: Paste, Don't Link

Phase 4 で `dev-implement` を呼び出す際は、対応する task の本文を prompt 内に **verbatim paste**
する。`impl-plan.md` 全体を Read させてはならない。

```text
## task_body (verbatim from parent orchestrator)

<<<TASK_BODY_BEGIN>>>
[該当 task のフル本文 — File Changes / Test Plan / Acceptance / Notes すべて含む]
<<<TASK_BODY_END>>>
```

`dev-implement` は `task_body` paste を受け取った場合、`impl-plan.md` を Read せずに paste された
本文を真実の source として扱う。`task_body` 不在時のみ `impl-plan.md` を fallback として読む。

詳細規約: [`_shared/references/subagent-dispatch.md`](../_shared/references/subagent-dispatch.md#paste-dont-link)

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

`--task-id` / `--flow-state` は issue #93 で撤廃。指定すると flag 解析時に `die_json` で
即時 error。複数 issue 並列実行は `dev-flow --child-split` を使うこと。

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
- [Phase Details](references/phase-detail.md) - Detailed phase documentation
- [Journal Logging](references/journal-logging.md) - skill-retrospective 呼び出しパターン
- [Subagent Dispatch Rules](references/subagent-dispatch.md) - Phase 2/3b/5/6 の 5要素と routing
- [Shared Subagent Dispatch](../_shared/references/subagent-dispatch.md) - リポジトリ共通規約
