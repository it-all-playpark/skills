# Integration Guide (v2)

Reference documentation for the dev-integrate skill (v2 / child-split mode).

## Design summary

In v2 (child-split mode), child PRs are merged into the integration branch
**incrementally** by `dev-flow` child execution. Each child PR auto-merges
via `auto-merge-child.sh` (which goes through `auto-merge-guard.sh` and
allows `gh pr merge --admin` only against `integration/issue-*` /
`nightly/*` bases).

So by the time `dev-integrate` runs, all children are already on the
integration branch. dev-integrate's job is just **verify and validate**:

1. Verify all `children[].status == "completed"` in `flow.json`
2. Run type check (best-effort) on the integration branch
3. Run `dev-validate`
4. Mark `flow.json.status = integrated`

This is a **massive simplification** over v1, which used Kahn's algorithm
to topologically merge N subtask branches into a merge branch (and had to
deal with cross-branch conflicts at that final N-way merge point).

## Why no Kahn-sort topological merge

v1 design:

```
[contract] ─┬─→ task1 ─→ merge worktree (Kahn order: task1, task2, ..., taskN)
            ├─→ task2 ─┘
            └─→ task3 ─┘
```

v2 design:

```
[dev] ─→ integration/issue-N-slug ─┬─→ child-PR1 (draft, auto-merge)
                                    ├─→ child-PR2 (draft, auto-merge)
                                    └─→ child-PRn (draft, auto-merge)
                                            │
                                            └─→ (verify + validate) ─→ final PR → dev/main
```

Key wins:

- **Incremental conflict resolution**: each child PR resolves its own conflicts
  at merge time, not all-at-once at integration
- **Auditable history**: each child has its own merge commit on the integration
  branch in chronological order
- **CI-friendly**: child PRs are draft → CI suppressed; final integration PR
  runs CI once
- **No special merge worktree**: integration branch IS the worktree

## When to use dev-integrate

Only invoked by `dev-flow --child-split` Step 4. Standalone invocation is
valid for recovery (e.g., after manual completion of a stuck child).

```bash
# Standalone recovery
Skill: dev-integrate --flow-state /path/to/flow.json
```

## Failure modes

| Failure | Cause | Recovery |
|---------|-------|----------|
| `incomplete: [...]` | Some children not yet completed | Run `dev-flow` for incomplete children, retry |
| `flow.json v1` | Old schema in caller | Migrate to v2 — no auto-conversion |
| Type check fails | Cross-cutting type drift | Fix on integration branch, re-run dev-integrate |
| dev-validate fails | Integration test break | Fix on integration branch, re-run dev-integrate |

## Output JSON

```json
{
  "status": "integrated|failed",
  "issue": 93,
  "integration_branch": "integration/issue-93-slug",
  "children": {"total": 9, "completed": 9, "incomplete": 0},
  "type_check": "passed|failed|skipped",
  "validation": "passed|failed"
}
```

## State Updates

```bash
$SKILLS_DIR/_lib/scripts/flow-update.sh \
  --flow-state "$FLOW_STATE" status integrated
```

## See also

- [`dev-flow`](../../dev-flow/SKILL.md) — child-split mode invokes dev-integrate
- [`auto-merge-guard.sh`](../../_lib/scripts/auto-merge-guard.sh) — admin merge guard
- [`integration-branch.sh`](../../_lib/scripts/integration-branch.sh) — branch helper
- [`flow.schema.json`](../../_lib/schemas/flow.schema.json) — v2 schema
