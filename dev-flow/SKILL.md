---
name: dev-flow
description: |
  End-to-end development flow automation - from issue to LGTM.
  Note: Merge is performed manually by the user after review approval.
  Auto-detects parallel vs single mode based on issue complexity.
  Use when: (1) complete development cycle needed, (2) issue to PR automation,
  (3) keywords: full flow, development cycle, issue to PR
  Accepts args: <issue-number> [--testing tdd|bdd] [--design ddd] [--depth minimal|standard|comprehensive] [--base <branch>] [--max-iterations N] [--force-single] [--force-parallel]
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

## CRITICAL: Complete All Steps

**DO NOT EXIT until pr-iterate completes.**

## Mode Selection (Auto-Detect)

```
dev-flow <issue>
│
├─→ Step 0: dev-issue-analyze --depth standard
│
├─→ Step 1: Mode Decision
│   ├── --force-single  → Single Mode (skip dry-run)
│   ├── --force-parallel → Parallel Mode (skip dry-run)
│   └── auto (default)  → dev-decompose --dry-run
│       ├── single_fallback → Single Mode
│       └── ready          → Parallel Mode
│
├─→ [Single]   Steps 2a-4a → details: references/single-mode.md
└─→ [Parallel] Steps 2b-8b → details: references/parallel-mode.md
```

## Step 0: Issue Analysis (Always)

```bash
Skill: dev-issue-analyze $ISSUE --depth standard
```

## Step 1: Mode Decision

Auto-detect uses `dev-decompose --dry-run` to assess complexity based on actual codebase file dependencies.
Criteria: [Decomposition Guide](../dev-decompose/references/decomposition-guide.md#when-to-fall-back-to-single-mode)

- `single_fallback`: < 4 affected files, single component, all files tightly coupled, or 1 subtask
- `ready`: Multiple independent subtask groups identified

| Flag | Behavior |
|------|----------|
| `--force-single` | Skip dry-run, go directly to Single Mode |
| `--force-parallel` | Skip dry-run, go directly to Parallel Mode (full dev-decompose) |
| `--parallel` | **Deprecated alias** for `--force-parallel`. Shows deprecation notice |
| Both specified | **Error**: "Cannot specify both --force-single and --force-parallel" |

## Step Summary (Both Modes)

### Single Mode

| Step | Action | Complete When |
|------|--------|---------------|
| 2a | `Task: dev-kickoff` (subagent) | PR URL available |
| 3a | `gh pr view --json url` | URL captured |
| 4a | `Task: pr-iterate` (subagent) | LGTM or max iterations |

Details: [Single Mode](references/single-mode.md) -- subagent prompts, result handling, checklist

### Parallel Mode

| Step | Action | Complete When |
|------|--------|---------------|
| 2b | `Skill: dev-decompose` (full) | flow.json + worktrees |
| 3b | Check decomposition | subtask count > 1 |
| 4b | `dev-kickoff x N` (parallel) | All subtasks completed |
| 5b | Aggregate results | flow.json updated |
| 6b | `Skill: dev-integrate` | Merge + tests pass |
| 7b | `Skill: git-pr` | PR URL available |
| 8b | `Skill: pr-iterate` | LGTM or max iterations |

Details: [Parallel Mode](references/parallel-mode.md) -- decomposition, batch scheduling, result aggregation

## Usage

```
/dev-flow <issue> [--testing tdd] [--design ddd] [--depth comprehensive] [--base dev] [--max-iterations 10] [--force-single] [--force-parallel]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | GitHub issue number |
| `--testing` | `tdd` | Implementation approach: tdd (test-first), bdd (behavior-first) |
| `--design` | - | Design approach: ddd (domain modeling) |

| `--depth` | `standard` | Analysis depth |
| `--base` | `dev` | PR base branch |
| `--max-iterations` | `10` | Max pr-iterate iterations |
| `--force-single` | - | Skip auto-detect, force single mode |
| `--force-parallel` | - | Skip auto-detect, force parallel mode |
| `--parallel` | - | **Deprecated**: alias for `--force-parallel` |

## Completion Conditions

| Condition | Action |
|-----------|--------|
| LGTM achieved | Workflow complete (merge manually) |
| Max iterations reached | Report status, user decides |
| Any step fails | Report error, do not proceed |

**This workflow does NOT merge the PR.** After LGTM, merge manually via `gh pr merge` or GitHub UI.

## State Recovery

```bash
# Single mode
$SKILLS_DIR/dev-flow/scripts/flow-status.sh --worktree $WORKTREE

# Parallel mode
$SKILLS_DIR/_lib/scripts/flow-read.sh --flow-state $FLOW_STATE
```

## Journal Logging

ワークフロー完了時に journal へログ記録。Details: [Journal Logging](references/journal-logging.md)

## References

- [Workflow Details](references/workflow-detail.md) - Full phase descriptions, error handling, debugging
- [Single Mode](references/single-mode.md) - Subagent prompts, result handling, checklist
- [Parallel Mode](references/parallel-mode.md) - Decomposition, batch scheduling, aggregation
- [Journal Logging](references/journal-logging.md) - Logging commands, mode tracking
- [dev-kickoff](../dev-kickoff/SKILL.md) - Phase orchestrator
- [dev-decompose](../dev-decompose/SKILL.md) - Subtask decomposition
- [dev-integrate](../dev-integrate/SKILL.md) - Branch integration
- [pr-iterate](../pr-iterate/SKILL.md) - PR iteration skill
