---
name: dev-decompose
description: |
  Decompose large issues into parallel subtasks with file-boundary isolation.
  Creates contract branch, worktrees, and flow.json for parallel dev-kickoff execution.
  Use when: (1) large issues need parallel implementation, (2) file-boundary decomposition,
  (3) keywords: decompose, split, parallel, subtasks
  Accepts args: <issue-number> [--base <branch>] [--env-mode hardlink|symlink|copy|none] [--flow-state <path>] [--dry-run]
allowed-tools:
  - Bash
  - Task
  - Agent
model: opus
effort: max
---

# Dev Decompose

Decompose large issues into parallel subtasks with file-boundary isolation. Creates a contract branch, per-task worktrees, and a flow.json manifest for parallel dev-kickoff execution.

## Responsibilities

- Receive issue analysis results (from dev-issue-analyze or issue body)
- Identify affected files and build a file dependency graph
- Split work into non-conflicting subtasks at file boundaries
- Define `depends_on` relationships between subtasks
- Generate shared contract (types/interfaces) committed to a contract branch
- Dispatch `dev-kickoff-worker` subagent (`isolation: worktree`) for each subtask to create its worktree from the contract branch
- Generate flow.json with subtask definitions (including `branch` field), checklists, and contract info

## Workflow (Full Execution, default)

```
1. Read issue analysis (from dev-issue-analyze output or issue body)
2. Identify affected files and dependencies
3. Group files into subtasks (no file overlap)
4. Define checklist for each subtask
5. Generate shared contract (interfaces/types if needed)
6. Create contract worktree from base (orchestrator-local, see Step 5-7)
7. Commit contract files to contract branch
8. Dispatch dev-kickoff-worker subagent (isolation: worktree) per subtask
   to create its branch (feature/issue-${N}-task${INDEX}) from the contract branch
9. Generate flow.json (populating subtask.branch returned by each worker)
10. Validate decomposition (validate-decomposition.sh)
```

Dry-run mode (`--dry-run`) executes Steps 1-4 only; see [Dry-Run Mode](references/dry-run.md).

### Step 1-4: Analysis & File Grouping

Analyze issue, build file dependency graph, partition into subtasks. See [Decomposition Guide](references/decomposition-guide.md) for strategy and edge cases.

### Step 5-7: Contract Generation

Generate contract per [Decomposition Guide](references/decomposition-guide.md). Branch: `feature/issue-{N}-contract`.

**IMPORTANT: Contract branch は worktree で作成すること。メインリポジトリで直接 checkout しない。**

```bash
# Step 6: contract worktree 作成（--local でリモート push を防止）
$SKILLS_DIR/git-prepare/scripts/git-prepare.sh $ISSUE \
  --suffix contract --base $BASE --env-mode $ENV_MODE --local

# Step 7: contract worktree 内でファイル作成・コミット
cd $CONTRACT_WORKTREE
# ... create contract files, git add, git commit ...
```

### Step 8: Subtask Worktree Creation (worker subagent dispatch)

For each subtask, spawn a `dev-kickoff-worker` subagent in `isolation: worktree` mode based on the contract branch. The worker creates its own branch (`feature/issue-${ISSUE}-task${INDEX}`) inside the isolated worktree and returns `{status, branch, worktree_path, commit_sha}`.

Direct `git worktree add` and direct `git-prepare.sh --suffix task...` calls are **prohibited** for subtask worktrees. Subtask/contract ブランチはリモートに push しない。

Details (Agent call shape, 5-element dispatch rules, constraints): [Worker Dispatch](references/worker-dispatch.md).

### Step 9: Flow State Generation

```bash
$SKILLS_DIR/dev-decompose/scripts/init-flow.sh $ISSUE \
  --flow-state $FLOW_STATE --base $BASE --env-mode $ENV_MODE
```

Populate each subtask entry with `id` / `scope` / `files` / **`branch` (required, v2 schema — populated from worker return)** / `status` / `checklist` / `depends_on` / `worktree_path`. See [flow.schema.json](../_lib/schemas/flow.schema.json) for the full schema.

### Step 10: Validation

```bash
$SKILLS_DIR/_lib/scripts/validate-decomposition.sh --flow-state $FLOW_STATE
```

Also verify manually: contract branch exists with commits, all worktree paths exist on disk.

## Decomposition Rules

See [Decomposition Guide](references/decomposition-guide.md) for file exclusivity, test co-location, contract isolation, coupling rules, edge cases, and examples.

## Contract Branch Pattern

```
main --> feature/issue-{N}-contract (dev-decompose commits shared types)
  |-- feature/issue-{N}-task1 (branched from contract)
  |-- feature/issue-{N}-task2 (branched from contract)
  |-- feature/issue-{N}-task3 (branched from contract)
  +-- feature/issue-{N}-merge (integration target)
```

## Fallback

If decomposition yields 1 subtask (see [Decomposition Guide](references/decomposition-guide.md) for criteria):

```json
{"status": "single_fallback", "subtask_count": 1, "reason": "All files are tightly coupled"}
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number>` | required | GitHub issue number |
| `--base` | `main` | Base branch for contract |
| `--env-mode` | `hardlink` | Env file handling for worktrees |
| `--flow-state` | auto | Path to flow.json output location |
| `--dry-run` | false | Run Steps 1-4 only (analysis + grouping), no side effects |
| `--resume` | - | Path to dry-run result JSON, skip Steps 1-4 and continue from Step 5 |

When `--flow-state` is `auto`, the path defaults to `$WORKTREE_BASE/.claude/flow.json` where `$WORKTREE_BASE` is the parent worktrees directory for the issue.

## Output

Full execution creates flow.json at `$WORKTREE_BASE/.claude/flow.json` and returns:

```json
{"status": "decomposed|single_fallback", "subtask_count": N, "flow_state": "/path/to/flow.json"}
```

Dry-run returns assessment JSON only (no files created); see [Dry-Run Mode](references/dry-run.md).

## Error Handling

| Condition | Action |
|-----------|--------|
| Issue not found | Abort with error JSON |
| No affected files identified | Abort with error JSON |
| Contract branch creation fails | Abort, clean up worktrees |
| Worktree creation fails | Abort, report which subtask failed |
| Validation fails | Report specific violations, do not proceed |

## Subagent Dispatch Rules

dev-decompose は Step 8 で **subtask 数ぶんの `dev-kickoff-worker` subagent** を `Agent(isolation: worktree)` で起動する。共通規約 ([`_shared/references/subagent-dispatch.md`](../_shared/references/subagent-dispatch.md)) の必須5要素を遵守する:

- **Objective** — contract branch をベースに subtask 用 isolated worktree を作成し `{status, branch, worktree_path, commit_sha}` を返す (Phase 1 のみ)
- **Output format** — `{status, branch, worktree_path, commit_sha, phase_failed?, error?}` JSON (worker last-line contract)
- **Tools** — worker frontmatter で許可 (Bash, Read, Write, Edit, Skill, TodoWrite, Glob, Grep)。追加制約は付けない
- **Boundary** — isolated worktree 内のみ作業、`git push` 禁止 (parallel mode)、subtask 外 branch 不可、`git worktree add` 直接実行禁止
- **Token cap** — worker 1 回あたり 2000 turn 以内、Step 8 全体で subtask 数 ≤ 5 推奨

詳細・チェックリストは [Worker Dispatch](references/worker-dispatch.md) を参照。

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success (flow.json created, or single_fallback)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-decompose success \
  --issue $ISSUE --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-decompose failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>"
```

## References

- [Decomposition Guide](references/decomposition-guide.md) - Detailed strategy and edge cases
- [Dry-Run Mode](references/dry-run.md) - --dry-run mode, past_conflict_hints, resume
- [Worker Dispatch](references/worker-dispatch.md) - Step 8 Agent call, 5-element dispatch rules
- [dev-kickoff-worker](../.claude/agents/dev-kickoff-worker.md) - Subagent that creates each subtask worktree (Step 8)
- [git-prepare](../git-prepare/SKILL.md) - Contract worktree creation (Step 6-7 only; subtask worktrees route through dev-kickoff-worker)
- [dev-issue-analyze](../dev-issue-analyze/SKILL.md) - Issue analysis input
- [dev-kickoff](../dev-kickoff/SKILL.md) - Per-subtask execution (parallel mode, `--task-id`)
