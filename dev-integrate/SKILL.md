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
1. Read flow.json, verify all subtasks status == "completed"
1b. Check shared_findings for unacked entries (warning only, non-blocking)
2. Warn if actual_files_changed differs from planned files
3. Determine merge order from depends_on (topological sort, leaves first)
4. Spawn worker: Agent(subagent_type: "dev-kickoff-worker", isolation: "worktree", mode: "merge")
   prompt:
     issue_number: $ISSUE
     branch_name: feature/issue-${ISSUE}-merge   (or ...-merge-retry on retry)
     base_ref: $CONTRACT_BRANCH
     mode: merge
     flow_state: $FLOW_STATE
   worker internally runs:
     a. git checkout -b $branch_name $base_ref
     b. merge-subtasks.sh --flow-state $FLOW_STATE --worktree $(pwd)
        (auto-resolves lock/config conflicts, appends integration-feedback events)
     c. type check (tsc/mypy/go vet)
     d. Skill: dev-validate --worktree $(pwd)
   worker returns:
     {status, branch, worktree_path, commit_sha, merge_results, conflicts, phase_failed?, error?}
5. Parent writes worker result back to flow.json.integration via flow-update.sh
   (status / merge_worktree / merge_order / type_check / validation / merge_results / conflicts)
6. On merge failure: re-spawn worker with branch_name=feature/issue-${ISSUE}-merge-retry
```

### Step 1b: Unacked Shared Findings Check

```bash
UNACKED=$($SKILLS_DIR/dev-integrate/scripts/check-unacked-findings.sh \
  --flow-state "$FLOW_STATE")
COUNT=$(echo "$UNACKED" | jq -r '.unacked_count')
if [[ "$COUNT" -gt 0 ]]; then
  echo "$COUNT shared finding(s) not acknowledged by all subtasks:"
  echo "$UNACKED" | jq -r '.unacked[] | "  - \(.id) [\(.category)] \(.title) (missing: \(.missing_ack | join(",")))"'
fi
```

The check is **non-blocking**: integration continues even with unacked findings. It only surfaces potential cross-worker coordination gaps for human awareness. See [`_shared/references/shared-findings.md`](../_shared/references/shared-findings.md) for the pattern.

## Execution

See [Integration Guide](references/integration-guide.md#execution-steps) for detailed step-by-step commands, and [Worker Dispatch](references/worker-dispatch.md) for the `dev-kickoff-worker` (`mode: merge`) contract.

## Subagent Dispatch Rules

dev-integrate spawns `dev-kickoff-worker` with `isolation: worktree` for the merge worktree (Step 4). Per `docs/skill-creation-guide.md`, the dispatch must satisfy the required 5 elements. Full prompt template and routing live in [`references/worker-dispatch.md`](references/worker-dispatch.md) (progressive disclosure); the binding values are summarised here.

1. **Objective** — 「contract branch `feature/issue-${ISSUE}-contract` をベースに merge 用 branch `feature/issue-${ISSUE}-merge` (or `-merge-retry`) を isolated worktree で作成し、`merge-subtasks.sh` → 型チェック → `dev-validate` を実行して `{status, branch, worktree_path, commit_sha, merge_results, conflicts}` を返す」
2. **Output format** — `{ status: "completed"|"failed", branch: string, worktree_path: string, commit_sha: string, merge_results: object, conflicts: number, phase_failed?: string, error?: string }` (last-line JSON contract)
3. **Tools** — worker frontmatter 既定: `Bash, Read, Write, Edit, Skill, TodoWrite, Glob, Grep`。dev-integrate 側から追加制約は付けない
4. **Boundary** — worker は自身の isolated worktree 内のみで作業、`git push` 禁止 (merge branch も含む)、subtask / contract branch を rewrite しない、`git worktree add` を直接実行しない、`git-prepare.sh --suffix merge` も呼ばない
5. **Token cap** — worker 1 回あたり 2000 turn 以内 (`dev-kickoff-worker.md` 既定)、merge mode は通常 1 spawn で完結 (失敗時のみ `-merge-retry` で 1 回 re-spawn)

Routing: merge worktree 作成 + merge 実行 → `dev-kickoff-worker` (sonnet, `isolation: worktree`, `mode: merge`)。dev-integrate 自身は探索 / 集約 / `flow.json` 書き込みのみを担う。

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
