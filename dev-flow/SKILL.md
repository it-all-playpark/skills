---
name: dev-flow
description: |
  End-to-end development flow automation - from issue to LGTM.
  Note: Merge is performed manually by the user after review approval.
  Two explicit modes: single (1 issue = 1 PR) or child-split (parent → child issues + integration branch + batch loop).
  Use when: (1) complete development cycle needed, (2) issue to PR automation,
  (3) keywords: full flow, development cycle, issue to PR, child-split
  Accepts args: <issue-number> [--testing tdd|bdd] [--design ddd] [--depth minimal|standard|comprehensive] [--base <branch>] [--max-iterations N] [--force-single|--child-split]
allowed-tools:
  - Skill
  - Bash
  - Task
---

<SUPERPOWERS-SKIP>
dev-flow は独自のステップ管理ワークフロー。superpowers スキル（brainstorming, verification-before-completion, writing-plans, executing-plans, test-driven-development 等）は一切呼び出さないこと。dev-flow が内部で呼ぶサブスキル（dev-kickoff, dev-decompose, pr-iterate 等）のみ使用する。
</SUPERPOWERS-SKIP>

# Dev Flow

End-to-end development automation from issue to LGTM (merge manually).

## 言語ルール

**PR本文・レビューコメント・PRコメントは必ず日本語で記述すること。**
- サブエージェントへのプロンプトでも日本語出力を明示指定する
- 技術用語・コード識別子・ファイルパスはそのまま

## Agent Mode

サブエージェント（Agent tool）は `mode: "auto"` で起動すること。
安全なコマンドは自動許可され、ワークフローが中断されない。

## CRITICAL: Complete All Steps

**DO NOT EXIT until pr-iterate completes.**

## Mode Selection (Explicit)

**v2 では auto-detect dry-run を廃止し、フラグで明示的にモードを選択する。**
(no-backcompat: `--force-parallel` / `--parallel` は error で reject)

```
dev-flow <issue> [--force-single]    → Single mode (default)
dev-flow <issue> --child-split        → Child-split mode (parent → child issues + integration branch)
```

| Flag | Behavior |
|------|----------|
| `--force-single` (default) | Single mode (dev-kickoff → 1 PR) |
| `--child-split` | Child-split mode (dev-decompose → batch loop → integration PR) |
| `--force-parallel` | **Error**: deprecated, removed in v2 |
| `--parallel` | **Error**: deprecated alias, removed in v2 |
| Both `--force-single` and `--child-split` | **Error** |

## Step Summary

### Single Mode (default)

| Step | Action | Complete When |
|------|--------|---------------|
| 1 | `Skill: dev-issue-analyze` | Requirements captured |
| 2 | `Task: dev-kickoff` (subagent) | PR URL available |
| 3 | `gh pr view --json url` | URL captured |
| 4 | `Task: pr-iterate` (subagent) | LGTM or max iterations |

Details: [Single Mode](references/single-mode.md)

### Child-Split Mode

| Step | Action | Complete When |
|------|--------|---------------|
| 1 | `Skill: dev-issue-analyze` | Parent requirements understood |
| 2 | `Skill: dev-decompose --child-split` | children + integration branch + flow.json (decompose phase done) |
| 3 | `bash dev-flow/scripts/orchestrate.sh` | batch_loop → integrate → final_pr → pr_iterate を flow-decide 駆動の decision loop で完走 |

Step 3 は Stage 3 (issue #112) で `orchestrate.sh` に集約された。`run-batch-loop` /
`dev-integrate` / `git-pr` / `pr-iterate` の各遷移は `flow-decide.sh` (decision engine) +
`build-envelope.sh` (skill 出力 → decision-input envelope の純変換) + `flow-update.sh`
(flow.json phase state 更新) の bash decision loop が制御する。

Details: [Child-Split Mode](references/child-split-mode.md)

## Step 1: Issue Analysis (Always)

```bash
Skill: dev-issue-analyze $ISSUE --depth standard
```

## Step 2 (Single): dev-kickoff

```
Task: dev-kickoff $ISSUE --testing $TESTING --depth $DEPTH --base $BASE --lang ja
```

## Step 2 (Child-Split): dev-decompose

```bash
Skill: dev-decompose $ISSUE --child-split --base $BASE \
  --flow-state $WORKTREE_BASE/.claude/flow.json
```

Output: integration branch + flow.json v2.1 (children[] + batches[] + phases[])。
dev-decompose は validate (Step 8) 成功直後に `flow-update phase decompose done` を呼ぶため、
orchestrate.sh は `decompose == done` の flow.json を前提に **batch_loop 起点**で開始する
(issue #112 Q3)。

## Step 3 (Child-Split): Orchestrate (decision loop)

batch_loop → integrate → final_pr → pr_iterate の遷移は **`orchestrate.sh` の bash decision
loop** に集約される。各 phase で skill を実行 → `build-envelope.sh` で決定論的ソース
(run-batch-loop JSON / dev-integrate JSON / git-pr JSON / iterate.json) を decision-input
envelope に純変換 → `flow-decide.sh` で next_action を決定 → `flow-update.sh` で phase state を
更新、を繰り返す。

```bash
$SKILLS_DIR/dev-flow/scripts/orchestrate.sh \
  --flow-state $WORKTREE_BASE/.claude/flow.json \
  --worktree $WORKTREE_BASE \
  --base $BASE --lang ja \
  [--allow-partial]
```

- **batch_loop**: 内部で `run-batch-loop.sh` を `--fail-fast` で回し、各 child PR を
  `auto-merge-child.sh` で integration branch に auto-merge する (従来 Step 3 と同等)。
  `build-envelope.sh batch_loop` が `issues_succeeded` → `completed_children`、
  `issues_failed + (results[]|skipped)` → `failed_children` に集約する。
- **integrate**: `dev-integrate` を実行し `{type_check, validation}` を tests_pass に変換。
  merge は batch_loop で完結済のため `merge_conflicts = []`。
- **final_pr**: `git-pr` で **non-draft** の integration → dev/main PR を作成。orchestrate が
  `gh pr checks` を最大 10 分 polling して ci_status を解決 (Q12)。
- **pr_iterate**: `pr-iterate` を実行し iterate.json `{status, current_iteration}` を
  `{decision, iterations}` に変換。`lgtm` / `max_reached` で完了、`failed` で abort。

`--allow-partial` は default off。明示時のみ batch_loop で `failed_children > 0` でも
integrate に進む (Q11)。retry が必要な phase は orchestrate が
`flow-update phase <t> running --attempts +1` を呼んでから再実行する (Q5、max 3 attempts)。

exit code: `0` = 完走 (next_action complete) / `2` = abort (手動介入要) / `3` = skill 起動エラー。

## Usage

```
/dev-flow <issue> [--testing tdd] [--design ddd] [--depth comprehensive] [--base dev] [--max-iterations 10] [--force-single|--child-split]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | GitHub issue number |
| `--testing` | `tdd` | Implementation approach: tdd / bdd |
| `--design` | - | Design approach: ddd |
| `--depth` | `standard` | Analysis depth |
| `--base` | `dev` | PR base branch |
| `--max-iterations` | `10` | Max pr-iterate iterations |
| `--force-single` | (default) | Single mode |
| `--child-split` | - | Child-split mode |

## Completion Conditions

| Condition | Action |
|-----------|--------|
| LGTM achieved | Workflow complete (merge manually) |
| Max iterations reached | Report status, user decides |
| Any step fails | Report error, do not proceed |

**This workflow does NOT merge the final PR.** After LGTM, merge manually.

## State Recovery

```bash
# Single mode
$SKILLS_DIR/dev-flow/scripts/flow-status.sh --worktree $WORKTREE

# Child-split mode
$SKILLS_DIR/_lib/scripts/flow-read.sh --flow-state $FLOW_STATE
```

## Journal Logging

```bash
# On success (LGTM achieved)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-flow success \
  --issue $ISSUE --duration-turns $TURNS --args "$ORIGINAL_ARGS" --mode "$MODE"

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-flow failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" --args "$ORIGINAL_ARGS" --mode "$MODE"
```

Details: [Journal Logging](references/journal-logging.md)

## References

- [Single Mode](references/single-mode.md) - dev-kickoff + pr-iterate
- [Child-Split Mode](references/child-split-mode.md) - dev-decompose + batch loop + integration PR
- [Journal Logging](references/journal-logging.md) - Logging commands
- [dev-kickoff](../dev-kickoff/SKILL.md) - Single-mode worker
- [dev-decompose](../dev-decompose/SKILL.md) - Child-split planner
- [dev-integrate](../dev-integrate/SKILL.md) - Integration verifier
- [pr-iterate](../pr-iterate/SKILL.md) - PR iteration skill
- [orchestrate.sh](scripts/orchestrate.sh) - Child-split decision loop (Stage 3)
- [build-envelope.sh](scripts/build-envelope.sh) - skill 出力 → decision-input envelope 純変換
- [flow-decide.sh](../_lib/scripts/flow-decide.sh) - Decision engine (read-only)
- [run-batch-loop.sh](../_shared/scripts/run-batch-loop.sh) - Batch dispatcher
- [auto-merge-guard.sh](../_lib/scripts/auto-merge-guard.sh) - --admin merge guard
- [integration-branch.sh](../_lib/scripts/integration-branch.sh) - Integration branch helper
