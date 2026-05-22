# Dev Flow - Child-Split Mode

Parent issue → child issues + integration branch + batch loop + integration PR.

Use when the parent issue is decomposable into multiple PRs that can land
independently (typically driven by an explicit "実装順序" table or layered
linear DAG dependencies).

## Step Overview

| Step | Action | Complete When |
|------|--------|---------------|
| 1 | `Skill: dev-issue-analyze` | parent requirements captured |
| 2 | `Skill: dev-decompose --child-split` | flow.json v2.1 + integration branch + child issues (decompose phase done) |
| 3 | `bash orchestrate.sh` | batch_loop → integrate → final_pr → pr_iterate decision loop 完走 |

**Stage 3 (issue #112) 以降**、旧 Step 3-6 (run-batch-loop / dev-integrate / git-pr /
pr-iterate) は `dev-flow/scripts/orchestrate.sh` の **bash decision loop** に集約された。
orchestrate は `flow-decide.sh` (decision engine, read-only) を駆動し、各 phase の決定論的
ソースを `build-envelope.sh` で decision-input envelope に純変換し、`flow-update.sh` で
flow.json の phase state を更新する。下記 § orchestrate decision loop を参照。

decompose phase の done 化責務は **dev-decompose が内包する** (Step 8 validate 成功直後に
`flow-update phase decompose done` を呼ぶ)。そのため orchestrate は **batch_loop 起点**で開始する。

## Step 1: Issue Analysis

```bash
Skill: dev-issue-analyze $PARENT --depth $DEPTH
```

## Step 2: Decompose

```bash
WORKTREE_BASE="$HOME/ghq/.../skills-worktrees/feature-issue-${PARENT}"
mkdir -p "$WORKTREE_BASE/.claude"
FLOW_STATE="$WORKTREE_BASE/.claude/flow.json"

Skill: dev-decompose $PARENT --child-split \
  --base $BASE \
  --flow-state $FLOW_STATE
```

Output checks:
- `integration_branch.name` exists in `git branch --list`
- `children[]` count <= `max_child_issues_hard` (12)
- All children are real GitHub issues (`gh issue view`)

## Step 3: Orchestrate decision loop

```bash
$SKILLS_DIR/dev-flow/scripts/orchestrate.sh \
  --flow-state $FLOW_STATE \
  --worktree $WORKTREE_BASE \
  --base $BASE --lang ja \
  [--allow-partial]
```

orchestrate は次の decision loop を回す (batch_loop 起点):

```
phase ∈ {batch_loop, integrate, final_pr, pr_iterate}:
  1. flow-update phase <p> running
  2. <p> の決定論的ソースを取得 (skill 実行 or run-batch-loop)
  3. build-envelope.sh <p> ... → decision-input envelope
  4. flow-decide.sh --phase <p> --result <envelope> → {next_action}
  5. next_action:
       skill    → flow-update phase <p> done; 次 phase へ
       retry    → flow-update phase <target> running --attempts +1; 再実行 (Q5)
       complete → flow-update phase <p> done; status integrated; exit 0
       abort    → flow-update phase <p> failed; status failed; exit 2
```

各 phase の envelope 変換規則 (issue #112 Q2):

| phase | 入力ソース | envelope |
|---|---|---|
| batch_loop | run-batch-loop.sh JSON + flow.json children[] | `completed_children = issues_succeeded`、`failed_children = issues_failed + (results[]\|skipped\|length)` (skipped は results[] から集約、`completed+failed == children\|length` 保証) |
| integrate | dev-integrate `{type_check, validation}` | `tests_pass = (type_check ∈ {passed,skipped}) && (validation==passed)`、`merge_conflicts = []` |
| final_pr | git-pr `{pr_url}` + orchestrate の `gh pr checks` polling | `{pr_url, ci_status}` (ci_status は polling 解決、最大 30×20s=10 分、timeout→failed) |
| pr_iterate | iterate.json `{status, current_iteration}` | `decision = status` (in_progress は abort)、`iterations = current_iteration` |

`--allow-partial` は default off。明示時のみ batch_loop で `failed_children > 0` でも
integrate へ進む (Q11)。

### Per-child execution flow (orchestrate batch_loop phase 内部)

orchestrate の **batch_loop** phase は内部で `run-batch-loop.sh` を `--fail-fast` で実行し、
各 child の `--on-success` で `auto-merge-child.sh` を呼ぶ。フローは従来と同じ:

For each child issue:

1. `Skill: dev-flow <child> --force-single --base integration/issue-N-slug --lang ja`
   - This spawns dev-kickoff which creates a worktree, implements, and opens a **draft** child PR
   - The child PR base is the integration branch (NOT main/dev)
2. `auto-merge-child.sh <child>` resolves the PR deterministically (no fuzzy search):
   - First trusts `flow.json.children[].pr_number` if set
   - Else queries GitHub's authoritative Issue→PR link (`closedByPullRequestsReferences`) — only OPEN PRs targeting the integration base
   - Re-verifies state, base, and `closingIssuesReferences` matches the child issue before merging
   - Then runs `auto-merge-guard.sh --pr <child-pr>` → confirms base is `integration/issue-*`
   - `gh pr merge <child-pr> --merge --admin --delete-branch`
   - `flow-update.sh child <child> --status completed --merged-at $NOW`

### Failure handling

If a child fails:

- **Default**: `run-batch-loop.sh` logs the failure and **continues with remaining batches**. The final result aggregates per-issue status. Operator reviews `batch-state.json` after the run.
- **`--fail-fast`**: pass `--fail-fast` to `run-batch-loop.sh`. Once any batch has at least one failed issue, all subsequent batches are skipped. In-flight parallel issues within the failing batch still complete (no mid-batch cancellation). Result includes `fail_fast_triggered: true`, `batches_skipped: N`, and per-skipped-issue entries with `status: "skipped"`.

For child-split mode with strict layered dependencies (e.g. schema migration → API → E2E), **`--fail-fast` is recommended**: running API children after schema migration fails wastes time. Example:

```bash
$SKILLS_DIR/_shared/scripts/run-batch-loop.sh \
  --batches-json $BATCHES_JSON \
  --issue-runner "Skill: dev-flow {issue} --force-single --base $INTEGRATION_BRANCH --lang ja" \
  --on-success "$SKILLS_DIR/dev-flow/scripts/auto-merge-child.sh {issue} --base $INTEGRATION_BRANCH --flow-state $FLOW_STATE" \
  --state-file $WORKTREE_BASE/.claude/batch-state.json \
  --fail-fast
```

For loose-coupled batches (independent endpoints all in one parallel batch), omit `--fail-fast` so that one bad endpoint doesn't block the rest.

## orchestrate integrate phase (旧 Step 4): Integration Validation

batch_loop で全 children が integration branch に merge された後、orchestrate は
`dev-integrate` を実行する (手動相当コマンド):

```bash
Skill: dev-integrate --flow-state $FLOW_STATE
```

dev-integrate (v2) does:
- Verify all `flow.json.children[].status == "completed"`
- Check out the integration branch
- Run type check (tsc / mypy / go vet by stack detection)
- Run `dev-validate --worktree $INTEGRATION_WORKTREE`
- Update `flow.json.status = integrated`

No Kahn-sort, no merge-subtask logic — children are already merged.

## orchestrate final_pr phase (旧 Step 5): Final Integration PR

```bash
Skill: git-pr $PARENT --base $BASE --lang ja --worktree $INTEGRATION_WORKTREE
```

This is a **non-draft** PR (final review by humans). All the child PR
diffs are already on the integration branch, so this final PR's diff
equals the cumulative child changes. orchestrate はこの後 `gh pr checks` を polling して
ci_status を解決し、`passed` のときのみ pr_iterate へ進む (Q12)。

## orchestrate pr_iterate phase (旧 Step 6): pr-iterate

```bash
Skill: pr-iterate $FINAL_PR_URL
```

orchestrate は pr-iterate 完了後に iterate.json `{status, current_iteration}` を読み、
`decision = status` (lgtm / max_reached で完了、failed で abort) に変換する。

## Child PR draft flag

Child PRs are created with `--draft` to suppress CI on the
`integration/issue-*` base. The final integration PR (Step 5) is
non-draft to trigger full CI on the `dev` / `main` base.

Configure your CI to skip `draft: true` PRs or `base: integration/**`
PRs — see [`docs/ci-skip-recipe.md`](../../docs/ci-skip-recipe.md).

## Recovery

If interrupted mid-loop:

```bash
# Resume from batch N
$SKILLS_DIR/_shared/scripts/run-batch-loop.sh \
  --batches-json $BATCHES_JSON \
  --issue-runner "..." \
  --batch-from $N \
  --state-file $WORKTREE_BASE/.claude/batch-state.json
```

`flow-update.sh child <issue> --status running` is set per-child, so
re-runs see which children are already completed.

## Why this design

- DAG (depends_on) was replaced by linear batches; ~90% of workflows fit
- Integration branch absorbs cross-PR conflicts incrementally (vs N-way
  merge at the end with subtask DAG)
- Child PRs against integration branch are draft, suppressing N×CI runs
- Final integration PR triggers full CI exactly once

See parent issue #93 for the full rationale.
