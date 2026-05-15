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
| 2 | `Skill: dev-decompose --child-split` | children + integration branch + flow.json |
| 3 | `run-batch-loop.sh` | All batches consumed, child PRs merged into integration branch |
| 4 | `Skill: dev-integrate` | type check + dev-validate on integration branch |
| 5 | `Skill: git-pr` | Final integration → dev/main PR created |
| 6 | `Skill: pr-iterate` | LGTM or max iterations |

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

Output: integration branch + flow.json v2 (children[] + batches[]).

## Step 3 (Child-Split): Run Batch Loop

Each child issue is run through `dev-flow <child> --force-single --base $INTEGRATION_BRANCH`.
Child PRs are auto-merged into the integration branch (auto-merge-guard permits it).

```bash
INTEGRATION_BRANCH=$(jq -r '.integration_branch.name' $FLOW_STATE)
BATCHES_JSON=$(mktemp)
jq '.batches' $FLOW_STATE > $BATCHES_JSON

$SKILLS_DIR/_shared/scripts/run-batch-loop.sh \
  --batches-json $BATCHES_JSON \
  --issue-runner "Skill: dev-flow {issue} --force-single --base $INTEGRATION_BRANCH --lang ja" \
  --on-success "$SKILLS_DIR/dev-flow/scripts/auto-merge-child.sh {issue} --base $INTEGRATION_BRANCH" \
  --state-file $WORKTREE_BASE/.claude/batch-state.json
```

`auto-merge-child.sh` runs `auto-merge-guard.sh` first; since base is
`integration/issue-*`, the guard allows `gh pr merge --admin`.

## Step 4 (Child-Split): Integration

```bash
Skill: dev-integrate --flow-state $FLOW_STATE --base $INTEGRATION_BRANCH
```

`dev-integrate` (v2) verifies all children merged successfully and runs
type check + dev-validate on the integration branch (linear, no Kahn sort).

## Step 5 (Child-Split): Final PR

```bash
Skill: git-pr $ISSUE --base $BASE --lang ja --worktree $INTEGRATION_WORKTREE
```

This creates the **non-draft** integration → dev/main PR (final review).

## Step 6 (Child-Split): pr-iterate

```bash
Task: pr-iterate $FINAL_PR_URL --max-iterations $MAX
```

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
- [run-batch-loop.sh](../_shared/scripts/run-batch-loop.sh) - Batch dispatcher
- [auto-merge-guard.sh](../_lib/scripts/auto-merge-guard.sh) - --admin merge guard
- [integration-branch.sh](../_lib/scripts/integration-branch.sh) - Integration branch helper
