# Dev Flow - Workflow Details

Detailed documentation for the dev-flow skill workflow (v2).

## Architecture

```
dev-flow (main context - lightweight)
    │
    ├─→ Step 1: dev-issue-analyze --depth $DEPTH (always)
    │
    ├─→ Step 2: Mode Decision (explicit flag)
    │       ├── (default / --force-single) → Single Mode
    │       └── --child-split              → Child-Split Mode
    │
    ├─→ [Single Mode]
    │   ├─→ Step 2: Task subagent → dev-kickoff (independent context)
    │   │       ├─→ Phase 1: worktree
    │   │       ├─→ Phase 2: dev-issue-analyze
    │   │       ├─→ Phase 3-3b: plan + review
    │   │       ├─→ Phase 4-6: implement / validate / evaluate
    │   │       ├─→ Phase 7: git-commit
    │   │       └─→ Phase 8: git-pr → {worktree, pr_url, pr_number}
    │   │
    │   ├─→ Step 3: PR URL から (main context)
    │   │       └─→ gh pr view --json url --jq .url
    │   │
    │   └─→ Step 4: Task subagent → pr-iterate (independent context)
    │           ├─→ Review → Fix → Push → Repeat
    │           └─→ {status: lgtm | max_reached, iterations}
    │
    └─→ [Child-Split Mode]
        ├─→ Step 2: dev-decompose --child-split
        │       ├─→ Read parent analysis
        │       ├─→ Propose children + batches
        │       ├─→ Create integration branch (integration-branch.sh create)
        │       ├─→ Create child issues (gh issue create × N)
        │       └─→ Write flow.json v2
        │
        ├─→ Step 3: run-batch-loop.sh
        │       For each batch:
        │       ├─→ serial:   children を順次 dev-flow --force-single → draft child PR
        │       │              → auto-merge-child.sh で integration branch に merge
        │       └─→ parallel: 同じことを並列起動
        │
        ├─→ Step 4: dev-integrate (v2)
        │       ├─→ Verify all children completed
        │       ├─→ Run type check on integration branch
        │       └─→ Run dev-validate
        │
        ├─→ Step 5: git-pr (final, non-draft)
        │       └─→ integration branch → dev/main PR
        │
        └─→ Step 6: pr-iterate
                └─→ LGTM or max iterations
```

## Context Optimization

Subagents (dev-kickoff, pr-iterate) run via Task with `mode: "auto"` to keep
the main dev-flow context lean. The main context only holds:

- Mode selection state
- Subagent return values (JSON snippets)
- Optional flow.json read (for child-split state recovery)

## Error Handling Matrix

| Step | Failure Mode | Action |
|------|--------------|--------|
| 1 (analyze) | gh / network error | retry once, then abort |
| 2 single (kickoff) | Subagent returns `failed` | journal failure, abort |
| 2 child-split (decompose) | gh issue create rate limit / network | abort with manual recovery hint |
| 3 child-split (batch loop) | child dev-flow returns failed | record in batch-state.json, continue or fail-fast per `--on-failure` |
| 4 child-split (integrate) | type check / validate fail | abort, surface integration branch state |
| 5 (git-pr) | gh failure | retry once, manual PR command on second failure |
| 6 (pr-iterate) | max iterations | report status, do not error |

## Mode Selection Logic

```
if --force-single and --child-split:
    error("Cannot specify both --force-single and --child-split")
elif --force-parallel or --parallel:
    error("--force-parallel / --parallel is removed in v2; use --child-split")
elif --child-split:
    mode = "child-split"
else:
    mode = "single"  # default
```

## Recovery

### Single Mode

```bash
$SKILLS_DIR/dev-flow/scripts/flow-status.sh --worktree $WORKTREE
```

Reads `$WORKTREE/.claude/kickoff.json` to determine which dev-kickoff phase
completed last.

### Child-Split Mode

```bash
$SKILLS_DIR/_lib/scripts/flow-read.sh --flow-state $FLOW_STATE
```

Then resume the batch loop with `--batch-from N`:

```bash
$SKILLS_DIR/_shared/scripts/run-batch-loop.sh \
  --batches-json $BATCHES_JSON \
  --issue-runner "..." \
  --batch-from $LAST_COMPLETED_BATCH+1 \
  --state-file ...
```

## Why two modes instead of auto-detect

v1 had `dev-decompose --dry-run` deciding between single and parallel. This
caused:

- 30%+ wasted dev-decompose runs that ultimately fell back to single
- Subtle false-positives where dry-run said "ready for parallel" but the
  actual decomposition was 1 subtask (= single anyway)
- User confusion about what mode would actually run

v2 makes the choice explicit. If you're unsure, default to `--force-single`
(it's the safe default for ~80% of issues). Switch to `--child-split` only
when the parent has explicit ordered decomposition.

See parent issue #93 for the full rationale.
