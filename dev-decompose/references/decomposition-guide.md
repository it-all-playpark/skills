# Decomposition Guide (v2 / child-split)

How to decide whether to use `--child-split` mode and how to compose child
issues + batches.

## When to use --child-split

Use child-split when **any** of these apply:

1. Parent issue body has an explicit ordered list of commits / files / steps
   (e.g. "実装順序" table) — convert each row into a child issue
2. Parent touches > 3 logical components that can land in independent PRs
3. Estimated diff is > 500 lines and breaks naturally at module boundaries
4. Cross-cutting refactor needs intermediate review checkpoints

Use **`--force-single`** instead when:

- Diff is small (< 200 lines)
- All changes are tightly coupled (shared imports / mutual modifications)
- Single component / file is touched
- Acceptance is one logical unit

## Batch design heuristics

Batches express **layered linear DAG** dependencies. Each batch runs all its
children to completion before the next batch starts. Within a batch:

- `serial` — execute one child at a time (use for foundational changes that
  affect later children, e.g. schema migration before API)
- `parallel` — fan out children concurrently (use for independent API
  endpoints sharing a foundation)

### Typical patterns

```
Layered (most common):
  Batch 1: serial   → [foundation/schema]
  Batch 2: parallel → [api-user, api-post, api-comment]
  Batch 3: serial   → [E2E tests]

Linear (when each step depends on previous):
  Batch 1: serial → [step1]
  Batch 2: serial → [step2]
  Batch 3: serial → [step3]

Wide parallel (rare):
  Batch 1: parallel → [a, b, c, d]  (all independent, one batch is fine)
```

## Size limits

`skill-config.json`:

| Key | Default | Behavior |
|-----|---------|----------|
| `max_child_issues_soft` | 8 | Warning emitted if child count > soft |
| `max_child_issues_hard` | 12 | **Abort** if child count > hard |

If you need more than 12 children, **split the parent issue itself** — multi-parent
coordination is out of scope.

## Examples

### Example 1: Direct mapping from "実装順序" table

Parent issue body:

```
| Commit | 内容 |
|--------|------|
| 1 | feat(_shared): foo.sh を新設 |
| 2 | feat(_lib): bar.sh を新設 |
| 3 | refactor: A 系列を rewrite |
```

→ 3 children, each commit becomes one child issue. Default to **all serial**
unless the parent body explicitly says certain commits are independent.

### Example 2: API expansion

Parent: "Add user / post / comment endpoints with schema migration"

```
Batch 1 (serial):   [schema-migration]
Batch 2 (parallel): [api-user, api-post, api-comment]
Batch 3 (serial):   [e2e-tests]
```

### Example 3: Cross-package refactor

Parent: "Rename FooClient → FooSDK across 5 packages, with shared types update"

```
Batch 1 (serial):   [shared-types-rename]
Batch 2 (parallel): [pkg-a, pkg-b, pkg-c, pkg-d, pkg-e]
```

## Anti-patterns

| Anti-pattern | Fix |
|--------------|-----|
| Single batch with 1 serial child | Use `--force-single` |
| Mixing `mode` within "same dependency layer" | Group them into one parallel batch |
| Children that share the same file across batches | Merge into one child or sequence as serial |
| `max_child_issues > 12` | Split the parent issue first |

## Why no DAG / depends_on

v1 expressed dependencies as `subtasks[].depends_on[]` (arbitrary DAG).
We dropped this because:

- ~90% of real workflows are layered linear DAGs (= batch array)
- DAG sort (Kahn's algorithm) added complexity for the 10% case
- The 10% case is better handled by splitting the parent issue
- Single PR conflict resolution across N subtask branches is fragile
  (contract branch hack), child-PR-into-integration-branch is robust

See parent issue #93 for the full rationale.
