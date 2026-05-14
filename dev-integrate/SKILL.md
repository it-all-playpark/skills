---
name: dev-integrate
description: |
  Merge parallel subtask branches, resolve conflicts, run type checks and integration tests.
  Use when: (1) merging parallel subtask results, (2) post-implementation integration,
  (3) keywords: integrate, merge subtasks, consolidate branches
  Accepts args: [--flow-state <path>] [--base <branch>]
allowed-tools:
  - Bash
  - Task
  - Agent
  - Skill
---

# Dev Integrate

Merge parallel subtask branches, resolve conflicts, run type checks and integration tests.

## Responsibilities

- Read flow.json and verify all subtasks completed
- Detect planned vs actual file changes (actual_files_changed vs files)
- Spawn `dev-kickoff-worker` subagent (`isolation: worktree`, `mode: merge`) for the merge worktree
- The worker merges each subtask branch in dependency order (leaves first) via `merge-subtasks.sh`
- Detect and attempt auto-resolution of conflicts (delegated to the worker / `merge-subtasks.sh`)
- **Record conflicts / integration failures to `_shared/integration-feedback.json`**
  so that future `dev-decompose --dry-run` runs can learn from recurring patterns
  (pub/sub event store — see
  [`_shared/references/integration-feedback.md`](../_shared/references/integration-feedback.md))
- The worker also runs type checking (tsc --noEmit, mypy, etc.) and integration tests via dev-validate
- Receive worker JSON `{status, branch, worktree_path, commit_sha, merge_results, conflicts}` and write the result back to `flow.json.integration` via `flow-update.sh`

## Workflow

```
1.  Read flow.json, verify all subtasks status == "completed"
1b. Check shared_findings (non-blocking warning)
2.  Warn if actual_files_changed differs from planned files
3.  Determine merge order from depends_on (topological)
4.  Spawn dev-kickoff-worker (isolation: worktree, mode: merge)
5.  Transcribe worker JSON to flow.json.integration via flow-update.sh
6.  On merge failure: re-spawn worker with -merge-retry suffix (max 1)
```

### Step 1b: Unacked Shared Findings Check

```bash
$SKILLS_DIR/dev-integrate/scripts/check-unacked-findings.sh --flow-state "$FLOW_STATE"
```

Non-blocking. Surfaces cross-worker coordination gaps. See [`_shared/references/shared-findings.md`](../_shared/references/shared-findings.md).

### Step 4: Worker Dispatch

Spawn `dev-kickoff-worker` (`isolation: worktree`, `mode: merge`) with prompt fields `issue_number` / `branch_name` (`feature/issue-${ISSUE}-merge`) / `base_ref` (contract branch) / `mode: merge` / `flow_state`. Worker internally runs `merge-subtasks.sh` → type check → `dev-validate` and returns `{status, branch, worktree_path, commit_sha, merge_results, conflicts}`.

Agent call shape, retry pattern (`-merge-retry`), and full return JSON: [Worker Dispatch](references/worker-dispatch.md).

## Subagent Dispatch Rules

dev-integrate spawns `dev-kickoff-worker` (`Agent(isolation: worktree, mode: merge)`) at Step 4. Common rules ([`_shared/references/subagent-dispatch.md`](../_shared/references/subagent-dispatch.md)) require the 5 elements:

- **Objective** — contract branch ベースに merge 用 isolated worktree を作成し `merge-subtasks.sh` → 型チェック → `dev-validate` を実行
- **Output format** — `{status, branch, worktree_path, commit_sha, merge_results, conflicts, phase_failed?, error?}` JSON (worker last-line contract)
- **Tools** — worker frontmatter で許可 (Bash, Read, Write, Edit, Skill, TodoWrite, Glob, Grep)。追加制約は付けない
- **Boundary** — worker は自身の isolated worktree 内のみで作業、`git push` 禁止 (merge branch も含む)、subtask / contract branch を rewrite しない、`git worktree add` / `git-prepare.sh --suffix merge` 直接実行禁止
- **Token cap** — worker 1 回あたり 2000 turn 以内、merge mode は通常 1 spawn (失敗時のみ `-merge-retry` で 1 回 re-spawn)

詳細・Routing: [Worker Dispatch](references/worker-dispatch.md)。

## Error Handling

| Scenario | Action |
|----------|--------|
| Subtask not completed | Abort, report |
| Worker returns `status: failed` with `phase_failed: "merge"` | Re-spawn worker with `branch_name: feature/issue-${ISSUE}-merge-retry` (max 1 retry), then escalate |
| Worker returns conflicts > 0 but `status: completed` | Auto-resolved (lock/config). Pass-through, record in flow.json |
| Type check / test fails (worker reports inside merge_results) | Worker returns `phase_failed: "merge"`. Fix attempt (max 2x) via retry → report |

Details: [Integration Guide](references/integration-guide.md#conflict-auto-resolution), [Worker Dispatch](references/worker-dispatch.md)

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `--flow-state` | auto | Path to flow.json |
| `--base` | from flow.json | Contract branch (passed to worker as `base_ref`) |

## Output

Updates flow.json integration section using the worker's return JSON.

```json
{"status": "integrated|failed", "merge_worktree": "/path", "type_check": "passed|failed", "validation": "passed|failed", "merge_results": {...}, "conflicts": <n>}
```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success (integrated)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-integrate success \
  --issue $ISSUE --duration-turns $TURNS

# On failure (merge conflict, type check, test failure)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-integrate failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>"
```
