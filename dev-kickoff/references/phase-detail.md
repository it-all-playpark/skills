# Dev Kickoff - Phase Details

Detailed documentation for each phase in the dev-kickoff workflow.

## Phase Overview

```
Phase 1: Worktree Creation (dev-kickoff-worker subagent)
    ↓
Phase 1b: State Initialization (init-kickoff.sh)
    ↓
Phase 2: Issue Analysis (dev-issue-analyze)
    ↓
Phase 3: Implementation (dev-implement)
    ↓
Phase 3b: Plan Review (dev-plan-review) ←→ Phase 3 (retry on fail)
    ↓
Phase 4: Validation (dev-validate)
    ↓
Phase 5: Commit (git-commit)
    ↓
Phase 6: PR Creation (git-pr)
    ↓
Handoff: pr-iterate
```

## Phase 1: Worktree Creation

dev-kickoff spawns the `dev-kickoff-worker` subagent via the Agent tool. The subagent runs in `isolation: worktree` (Claude Code feature), giving it an isolated worktree managed by Claude Code itself.

**Requirements**:
- Claude Code >= 2.1.63 (`isolation: worktree` field support)
- `.claude/agents/dev-kickoff-worker.md` present in the repo

If either requirement is missing, dev-kickoff aborts with an explicit error — there is no fallback.

**Spawn**:

```text
Agent(
  subagent_type: "dev-kickoff-worker",
  isolation: "worktree",
  prompt: "
    issue_number: $ISSUE
    branch_name: feature/issue-$ISSUE-m   # single mode
    base_ref: origin/$BASE
    mode: single
  "
)
```

The worker returns JSON containing the branch name, the worktree path it ran in, and the resulting commit SHA. Phase 1b (state init) is handled by the worker itself — it initializes `kickoff.json` inside the isolated worktree.

## Phase 2: Issue Analysis

**Command:**
```
Skill: dev-issue-analyze $ISSUE --depth $DEPTH
```

**Subagent:** Task(Explore) - for large file reads and codebase exploration

**Purpose:** Understand issue requirements and affected code.

**Completion Criteria:**
- Requirements documented
- Affected files identified
- Implementation approach determined

**State Update:**
```bash
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 2_analyze done \
  --result "Identified N files to modify" \
  --worktree $PATH
```

## Phase 3: Implementation

**Command:**
```
Skill: dev-implement --strategy $STRATEGY --worktree $PATH
```

**Purpose:** Write the actual code changes.

**Strategies:**
- `tdd`: Test-driven development (write tests first)
- `bdd`: Behavior-driven development
- `ddd`: Domain-driven design

**Completion Criteria:**
- All code changes written
- Tests added (if TDD)
- No syntax errors

**State Update:**
```bash
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 3_implement done \
  --result "Implemented feature X" \
  --worktree $PATH
```

## Phase 3b: Plan Review

**Command:**
```
Skill: dev-plan-review $ISSUE --worktree $PATH
```

**Subagent:** context:fork (Opus, general-purpose) - independent review context

**Purpose:** 実装計画を批判的にレビューし、実装前に問題を発見する。

**Input:**
- `$WORKTREE/.claude/impl-plan.md` (from Phase 3)
- `$WORKTREE/.claude/kickoff.json` → `phases.2_analyze.result`

**Output JSON Schema:**

dev-plan-review は stdout に以下を出力する（evaluator-optimizer ループの I/F）:

```jsonc
{
  "score": 0-100,
  "verdict": "pass" | "revise" | "block",
  "pass_threshold": 80,
  "findings": [
    { "severity": "critical" | "major" | "minor",
      "dimension": "...", "topic": "...",
      "description": "...", "suggestion": "..." }
  ],
  "summary": "..."
}
```

**Completion Criteria:**
- `verdict == "pass"`（critical/major なし かつ `score >= pass_threshold` 既定 80）
- または `max_iterations` (既定 3) に到達 → warning 付きで Phase 4 に進行
- または stuck 判定（同一 `{dimension, topic}` の major 以上が 2 iteration 連続で残存） → 即 escalate

**On Revise / Block:**
1. Output JSON 全体を `$WORKTREE/.claude/plan-review-feedback.json` に保存
2. `$WORKTREE/.claude/plan-review-history.json` に iteration 結果を追記（stuck 検出用）
3. `iteration++` して Phase 3 (dev-plan-impl) に戻り、feedback を反映した revise を作成

詳細は [Plan-Review Loop](evaluate-retry.md#plan-review-loop-phase-3b--evaluator-optimizer) を参照。

**State Update:**
```bash
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 3b_plan_review done \
  --result "Plan approved" \
  --worktree $PATH
```

## Phase 4: Validation

**Command:**
```
Skill: dev-validate --fix --worktree $PATH
```

**Subagent:** Task(quality-engineer) - for test execution and log analysis

**Purpose:** Verify implementation works correctly.

**Checks:**
- Unit tests pass
- Lint checks pass
- Type checks pass (if applicable)
- Integration tests pass

**On Failure:**
1. `--fix` attempts automatic fixes
2. If still failing, pause for intervention
3. Report specific failures

**Completion Criteria:**
- All tests pass
- No lint errors
- No type errors

**State Update:**
```bash
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 4_validate done \
  --result "All tests pass" \
  --worktree $PATH
```

## Phase 5: Commit

**Command:**
```
Skill: git-commit --all --worktree $PATH
```

**Purpose:** Create git commit with changes.

**Commit Message:**
- Generated based on changes
- Follows conventional commits format
- References issue number

**Completion Criteria:**
- All changes staged
- Commit created
- No uncommitted changes

**State Update:**
```bash
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 5_commit done \
  --result "Committed: <commit message>" \
  --worktree $PATH
```

## Phase 6: PR Creation

**Command:**
```
Skill: git-pr $ISSUE --base $BASE --lang $LANG --worktree $PATH
```

**Purpose:** Create GitHub Pull Request.

**Output:**
- PR created on GitHub
- PR number and URL available

**State Update (with PR info):**
```bash
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 6_pr done \
  --result "PR created" \
  --pr-number 123 \
  --pr-url "https://github.com/org/repo/pull/123" \
  --worktree $PATH
```

This sets `next_action: "pr-iterate"` in kickoff.json.

## Handoff to pr-iterate

After Phase 6 completes:

1. kickoff.json contains:
   - `pr.number`: PR number
   - `pr.url`: PR URL
   - `next_action`: "pr-iterate"
   - `current_phase`: "completed"

2. Next action:
   ```
   Skill: pr-iterate $PR_URL
   ```

## State Schema

### kickoff.json

```json
{
  "version": "1.0.0",
  "issue": 123,
  "branch": "feature/issue-123-m",
  "worktree": "/path/to/worktree",
  "base_branch": "main",
  "started_at": "2026-01-28T10:00:00Z",
  "updated_at": "2026-01-28T12:00:00Z",
  "current_phase": "3_implement",
  "phases": {
    "1_prepare": {
      "status": "done",
      "started_at": "2026-01-28T10:00:00Z",
      "completed_at": "2026-01-28T10:01:00Z",
      "result": "Worktree created"
    },
    "2_analyze": {
      "status": "done",
      "started_at": "2026-01-28T10:01:00Z",
      "completed_at": "2026-01-28T10:15:00Z",
      "result": "Identified 5 files"
    },
    "3_implement": {
      "status": "in_progress",
      "started_at": "2026-01-28T10:15:00Z"
    },
    "4_validate": { "status": "pending" },
    "5_commit": { "status": "pending" },
    "6_pr": { "status": "pending" }
  },
  "next_actions": ["Continue implementation"],
  "decisions": [],
  "config": {
    "strategy": "tdd",
    "depth": "standard",
    "lang": "ja",
    "env_mode": "hardlink"
  }
}
```

### After PR Creation

```json
{
  "current_phase": "completed",
  "pr": {
    "number": 456,
    "url": "https://github.com/org/repo/pull/456",
    "created_at": "2026-01-28T12:00:00Z"
  },
  "next_action": "pr-iterate"
}
```

## Subagent Delegation

| Phase | Subagent | Why |
|-------|----------|-----|
| 2 | Task(Explore) | Large codebase reads, file discovery |
| 4 | Task(quality-engineer) | Test execution, failure analysis |

Other phases run directly without subagent delegation.

## Error Handling

### Phase 1-2 Failures

```bash
$SKILLS_DIR/dev-kickoff/scripts/update-phase.sh $PHASE failed \
  --error "Error message" \
  --worktree $PATH
```

Action: Abort workflow, report error.

### Phase 3 Failures (Implementation Plan)

1. エラー出力を分析し、原因を特定（issue 要件の曖昧さ、コードベース理解不足等）
2. エラーコンテキストを付与して dev-plan-impl を再実行（max 2回）
3. 2回失敗後 → journal に partial 記録 → pause for intervention

### Phase 4 Failures (Implementation)

1. エラー出力を分析し、原因を特定（型エラー、ロジックエラー、依存関係不足等）
2. エラーコンテキストと修正方針を付与して dev-implement を再実行（max 2回）
3. 2回失敗後 → journal に partial 記録 → pause for intervention

### Phase 5 Failures (Validation)

1. `--fix` で自動修正を試行
2. 失敗した場合、エラー出力を分析し原因別に対処:
   - lint エラー → 該当箇所を直接修正して再度 `--fix`
   - テスト失敗 → テストまたは実装を修正して再度 `--fix`
   - 型エラー → 型定義を修正して再度 `--fix`
3. max 2回リトライ後も失敗 → journal に partial 記録 → pause for intervention

### Phase 7-8 Failures (Commit / PR)

1. 自動リトライ1回（Phase 7: re-stage して再コミット、Phase 8: 再実行）
2. それでも失敗 → manual command を報告、state 保存

Manual recovery:
```bash
# Phase 7
git add -A && git commit -m "feat: ..."

# Phase 8
gh pr create --title "..." --body "..."
```

## Recovery Commands

Check current state:
```bash
$SKILLS_DIR/dev-kickoff/scripts/next-action.sh --worktree $PATH
```

Resume from current phase:
```bash
# Read next_action from output and execute
```
