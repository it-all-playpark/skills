# Step 8: Worker Subagent Dispatch

各 subtask に対し `dev-kickoff-worker` subagent を `isolation: worktree` モードで起動し、contract branch をベースに subtask 用 worktree を作成する。

## Agent 呼び出し

```text
Agent(
  subagent_type: "dev-kickoff-worker",
  isolation: "worktree",
  prompt: "
    issue_number: $ISSUE
    branch_name: feature/issue-${ISSUE}-task${INDEX}
    base_ref: feature/issue-${ISSUE}-contract
    mode: parallel
    task_id: task${INDEX}
    flow_state: $FLOW_STATE
  "
)
```

worker が返す値: `{status, branch, worktree_path, commit_sha}`（last-line JSON contract）。

## 制約

- 直接 `git worktree add` の実行は **禁止**（subtask 用 worktree は worker 経由のみ）
- subtask / contract branch は **リモートに push しない**。push が必要なのは最終 merge ブランチのみ（PR 作成時）。worker は parallel mode で `git push` をスキップする

## 前提

- Claude Code >= 2.1.63（`isolation: worktree` フィールド対応）
- `.claude/agents/dev-kickoff-worker.md` がリポジトリに存在すること

## Subagent Dispatch 5要素

共通規約 ([`_shared/references/subagent-dispatch.md`](../../_shared/references/subagent-dispatch.md)) に沿って以下を遵守する。

1. **Objective** — 「contract branch `feature/issue-${ISSUE}-contract` をベースに subtask `task${INDEX}` 用の branch `feature/issue-${ISSUE}-task${INDEX}` を isolated worktree で作成し、`{status, branch, worktree_path, commit_sha}` を返す」（Phase 1 のみ。Phase 2-7 は dev-kickoff から `--task-id` で再呼び出し）
2. **Output format** — `{ status: "completed"|"failed", branch: string, worktree_path: string, commit_sha: string, phase_failed?: string, error?: string }` JSON
3. **Tools** — worker frontmatter で許可: `Bash, Read, Write, Edit, Skill, TodoWrite, Glob, Grep`。dev-decompose 側から追加 tool 制約は付けない
4. **Boundary** — worker は自身の isolated worktree 内のみで作業、`git push` 禁止（parallel mode）、subtask 外の branch を触らない、`git worktree add` を直接実行しない
5. **Token cap** — worker 1 回あたり 2000 turn 以内（`dev-kickoff-worker.md` 既定）、Step 8 全体で subtask 数 ≤ 5 を推奨

## Routing

- subtask worktree 作成 → `dev-kickoff-worker` (sonnet, isolation: worktree)
- 通常の探索 / planning → dev-decompose 自身 (opus, effort: max)
