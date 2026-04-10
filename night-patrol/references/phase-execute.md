# Phase 3: Execute - Detailed Steps

Update state: `phase: 3, status: "executing"`

Read `.claude/triage-results.json`.

Apply `--max-issues` limit if set (take first N issues from execution plan).

## Mandatory rule: 1 issue = 1 commit = 1 progress 更新

night-patrol の execute phase は以下の不変条件を守る:

1. 各 issue の実装成果は **dev-flow が作る 1 つの PR = 1 つのマージコミット** に閉じる。巨大な差分を無理に 1 コミットに詰めるのではなく、dev-flow 側が受け入れ条件を満たす最小単位でコミットしていることを前提に、外部から見える粒度を「1 issue = 1 マージコミット」に揃える。
2. auto-merge 成功 **直後** に `update_progress_log(issue, "done")` を呼び、progress ログと commit を atomic に対応させる。merge と progress 更新の間に失敗しうる処理を挟んではならない。
3. 失敗で PR がマージできない場合は progress ログを更新しない。代わりに `failures.sh incr` で失敗を記録し、`failures.json` を唯一の信頼源とする。

この制約は Anthropic *Effective Harnesses for Long-Running Agents* の「1 feature = 1 commit、git history を rollback 面として使う」原則に直結しており、night-patrol の巡回 run が失敗しても `nightly/$DATE` ブランチを安全に巻き戻せることを保証する。

## Batch Loop

For each batch in `execution_plan.batches` (ordered by batch number):

### 1. Pre-execute guard check

```bash
$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-execute \
  --cumulative-lines $CUMULATIVE
```

If `pass: false` -> skip all remaining batches, proceed to Phase 4.

### 2. Execute batch

**Parallel batch** (`mode: "parallel"`):
Launch each issue as a Task subagent:

```
Task: dev-flow <issue-number> --base nightly/$DATE
```

Wait for all to complete.

**Serial batch** (`mode: "serial"`):
Execute each issue sequentially:

```
Skill(skill: "dev-flow", args: "<issue-number> --base nightly/$DATE")
```

### 3. Process results (per issue)

For each completed issue:

**Success path (LGTM PR)**

1. Auto-merge into `nightly/$DATE` (確認不要):
   ```bash
   gh pr merge <PR_NUMBER> --merge --admin --delete-branch
   ```
   **Note:** `--admin` bypasses confirmation. Safe because nightly branch is for autonomous patrol only.
2. Reset failure counter (成功で連続失敗カウントを 0 に戻す):
   ```bash
   $SKILLS_DIR/night-patrol/scripts/failures.sh reset <ISSUE_NUMBER>
   ```
3. Update progress log: `update_progress_log(issue, "done")`
   (1 commit = 1 progress 更新の atomic 対応を守る)

**Failure path (dev-flow returned error / max_reached / PR not LGTM)**

1. Record failure and check escalation threshold:
   ```bash
   $SKILLS_DIR/night-patrol/scripts/failures.sh incr <ISSUE_NUMBER> \
     --reason "<short error message>"
   ```
   Output: `{"count": N, "escalated": bool, "max_failures": 2, ...}`
2. If `escalated: true`, label the issue and post a notification comment:
   ```bash
   $SKILLS_DIR/night-patrol/scripts/escalate-stuck.sh <ISSUE_NUMBER> \
     --reason "<short error message>" --count <N>
   ```
   Then continue with the next issue; do **not** retry the same issue within the current run.
3. If `escalated: false`, simply record the failure in `results[]` with `status: "failed"` and move on. Re-running night-patrol will pick up the issue again and the counter will persist across runs.

Update `cumulative_lines_changed` in state in both paths.

### 4. Post-issue guard check

After each individual issue completes, check cumulative lines:

```bash
$SKILLS_DIR/night-patrol/scripts/guard-check.sh --mode pre-execute \
  --cumulative-lines $CUMULATIVE
```

If `pass: false` -> skip all remaining issues in current batch AND remaining batches, proceed to Phase 4.

### 5. Update state

Add result to `results[]`, update counters in `.claude/night-patrol.json`.

## After all batches

Update state: `status: "completed"`

If subcommand is `execute`, stop here.
