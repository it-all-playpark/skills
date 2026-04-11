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
  - Skill
---

# Dev Integrate

Merge parallel subtask branches, resolve conflicts, run type checks and integration tests.

## Responsibilities

- Read flow.json and verify all subtasks completed
- Detect planned vs actual file changes (actual_files_changed vs files)
- Create merge worktree (git-prepare --suffix merge)
- Merge each subtask branch in dependency order (leaves first)
- Detect and attempt auto-resolution of conflicts
- Run type checking (tsc --noEmit, mypy, etc.)
- Run integration tests via dev-validate
- Update flow.json integration section

## Workflow

```
1. Read flow.json, verify all subtasks status == "completed"
1b. Check shared_findings for unacked entries (warning only, non-blocking)
2. Warn if actual_files_changed differs from planned files
3. Determine merge order from depends_on (topological sort, leaves first)
4. Create merge worktree via git-prepare --suffix merge --base $CONTRACT_BRANCH
4b. Sync .env files to merge worktree via sync-env
5. For each subtask in order:
   a. git merge --no-ff $TASK_BRANCH
   b. If conflict: attempt auto-resolution, record in flow.json
   c. If unresolvable: stop and request user intervention
6. Run type check (detect project type: tsc for TS, mypy for Python, etc.)
7. Run Skill: dev-validate --worktree $MERGE_WORKTREE
8. Update flow.json integration section with results
```

### Step 1b: Unacked Shared Findings Check

```bash
UNACKED=$($SKILLS_DIR/dev-integrate/scripts/check-unacked-findings.sh \
  --flow-state "$FLOW_STATE")
COUNT=$(echo "$UNACKED" | jq -r '.unacked_count')
if [[ "$COUNT" -gt 0 ]]; then
  echo "⚠️  $COUNT shared finding(s) not acknowledged by all subtasks:"
  echo "$UNACKED" | jq -r '.unacked[] | "  - \(.id) [\(.category)] \(.title) (missing: \(.missing_ack | join(",")))"'
fi
```

The check is **non-blocking**: integration continues even with unacked findings. It only surfaces potential cross-worker coordination gaps for human awareness. See [`_shared/references/shared-findings.md`](../_shared/references/shared-findings.md) for the pattern.

## Execution

See [Integration Guide](references/integration-guide.md#execution-steps) for detailed step-by-step commands.

## Error Handling

| Scenario | Action |
|----------|--------|
| Subtask not completed | Abort, report |
| Merge conflict | Auto-resolve → manual attempt → abort |
| Type check / test fails | Fix attempt (max 2x) → report |

Details: [Integration Guide](references/integration-guide.md#conflict-auto-resolution)

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `--flow-state` | auto | Path to flow.json |
| `--base` | from flow.json | Base branch for merge worktree |

## Output

Updates flow.json integration section.

Returns:
```json
{"status": "integrated|failed", "merge_worktree": "/path", "type_check": "passed|failed", "validation": "passed|failed"}
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
