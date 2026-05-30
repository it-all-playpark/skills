# Dev Flow - Single Mode

Default mode. One issue → one PR via `dev-kickoff` and `pr-iterate` subagents.

dev-kickoff and pr-iterate run as Task subagents with their own context to
keep the dev-flow context lean.

## Step Overview

| Step | Action | Complete When |
|------|--------|---------------|
| 1 | `Skill: dev-issue-analyze` | Requirements captured |
| 2 | `Task: dev-kickoff` (subagent) | PR URL available |
| 3 | `gh pr view --json url` | URL captured |
| 4 | `Task: pr-iterate` (subagent) | LGTM achieved or max iterations |

## Checklist

```
[ ] Step 1: Skill: dev-issue-analyze
[ ] Step 2: Task subagent → dev-kickoff (see prompt below)
[ ] Step 3: PR_URL=$(gh pr view --json url --jq .url)  (run in worktree)
[ ] Step 4: Task subagent → pr-iterate (see prompt below)
```

## Step 2: dev-kickoff Subagent

Launch dev-kickoff as a Task subagent with `mode: "auto"`. The subagent runs
in its own context and returns only the result.

**CRITICAL: Worktree is MANDATORY in single mode.** The subagent MUST create
a worktree via Phase 1 before any implementation. Implementation in the main
repository directory is NEVER allowed.

**Task prompt:**

```
Execute the dev-kickoff skill for issue #$ISSUE.
Run: Skill: dev-kickoff $ISSUE --testing $TESTING --depth $DEPTH --base $BASE --lang ja

CRITICAL REQUIREMENT: You MUST execute Phase 1 (worktree creation) FIRST.
- Phase 1 creates an isolated worktree. ALL implementation MUST happen inside this worktree.
- Do NOT skip Phase 1. Do NOT implement in the current directory.

LANGUAGE REQUIREMENT: All PR body content, commit messages, descriptions, and GitHub comments
MUST be written in Japanese (日本語). Technical terms, code identifiers, and file paths remain
in their original form.

After completion, return ONLY a JSON result:
- On success: {"status": "completed", "worktree": "<path>", "pr_url": "<url>", "pr_number": <number>}
- On failure: {"status": "failed", "error": "<message>", "phase": "<failed_phase>"}
```

**Result handling:**

| Result | Action |
|--------|--------|
| `status: "completed"` | Verify `worktree` path exists and is not the main repo → proceed to Step 3 |
| `status: "completed"` but no `worktree` or worktree is main repo | **ABORT** — worktree was not created |
| `status: "failed"` | Log failure via journal.sh → abort dev-flow |
| Task tool error | Log error → abort dev-flow |

## Step 3: Get PR URL

```bash
# Run from worktree returned by Step 2
cd $WORKTREE && gh pr view --json url --jq .url
```

## Step 4: pr-iterate Subagent

外側 Task subagent を `mode: "auto"` で起動し、その中で `Skill: pr-iterate` を
inline 実行する。`mode` は外側 Task subagent の起動オプションであり、
pr-iterate に渡る引数ではない（pr-iterate は `mode` 引数を持たない）。

pr-iterate は内部で pr-reviewer/pr-fixer subagent を自己駆動し、
approved + CI passed になるまで内蔵の Stop hook ループを繰り返す。
呼び出し側で iteration を手動管理しない。

**Task prompt:**

```
Execute the pr-iterate skill for PR $PR_URL.

LANGUAGE REQUIREMENT: All review comments, PR comments, and summaries MUST be written in
Japanese (日本語). Technical terms, code identifiers, and file paths remain in their original form.

Run: Skill: pr-iterate $PR_URL

pr-iterate は approved + CI passed になるまで内部ループで自己駆動する。
pr-iterate は iteration カウンタを持たないため、status は **最終 PR 状態から
決定論的に導出**すること（自己申告のループ回数に依存しない）:

1. CI status: `~/.claude/skills/pr-iterate/scripts/check-ci.sh $PR_URL` の status
2. review 状態: `gh pr view $PR_URL --json reviewDecision --jq .reviewDecision`

判定:
- approved 相当（reviewDecision=APPROVED）かつ CI passed → {"status": "lgtm"}
- 未 approved だが pr-iterate がエラーなく終了（=内部上限到達） → {"status": "max_reached"}
- pr-iterate 実行自体がエラー → {"status": "failed", "error": "<message>"}

完了後、上記いずれかの JSON のみを返すこと。`iterations` は返さなくてよい
（pr-iterate は iteration を追跡しない）。
```

**Result handling:**

status は subagent が check-ci.sh + `gh pr view` で決定論的に導出する（3値固定）。
`iterations` は契約に含めない（pr-iterate が iteration を追跡しないため省略可）。

| Result | Action |
|--------|--------|
| `status: "lgtm"` | Workflow complete (merge manually) |
| `status: "max_reached"` | Report status, user decides |
| `status: "failed"` | Log failure via journal.sh → report error |
| Task tool error | Log error → report error |
