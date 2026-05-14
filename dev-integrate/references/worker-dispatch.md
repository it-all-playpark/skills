# Step 4: Worker Subagent Dispatch (merge mode)

dev-integrate の merge worktree 作成は、`dev-kickoff-worker` を `isolation: worktree` + `mode: merge` で spawn することで行う。

## Agent 呼び出し

```text
Agent(
  subagent_type: "dev-kickoff-worker",
  isolation: "worktree",
  prompt: "
    issue_number: $ISSUE
    branch_name: feature/issue-${ISSUE}-merge
    base_ref: feature/issue-${ISSUE}-contract
    mode: merge
    flow_state: $FLOW_STATE
  "
)
```

retry 時は `branch_name` に `-merge-retry` suffix を付ける:

```text
Agent(
  subagent_type: "dev-kickoff-worker",
  isolation: "worktree",
  prompt: "
    issue_number: $ISSUE
    branch_name: feature/issue-${ISSUE}-merge-retry
    base_ref: feature/issue-${ISSUE}-contract
    mode: merge
    flow_state: $FLOW_STATE
  "
)
```

worker が返す値 (last-line JSON):

```json
{
  "status": "completed",
  "branch": "feature/issue-${ISSUE}-merge",
  "worktree_path": "/abs/path/to/isolated/worktree",
  "commit_sha": "<HEAD sha>",
  "merge_results": {
    "status": "success",
    "total_subtasks": 3,
    "merged": 3,
    "conflicts": 0,
    "results": [
      {"task_id": "task1", "branch": "feature/issue-79-task1", "status": "merged"}
    ]
  },
  "conflicts": 0
}
```

失敗時 (unresolvable conflict / type check fail / validation fail):

```json
{
  "status": "failed",
  "phase_failed": "merge",
  "branch": "feature/issue-${ISSUE}-merge",
  "worktree_path": "/abs/path",
  "commit_sha": "<best-effort sha>",
  "merge_results": {"status": "failed", "results": [...]},
  "conflicts": 1,
  "error": "unresolvable conflict in src/foo.ts"
}
```

## Parent (dev-integrate) の責務

worker から返った JSON をそのまま `flow.json.integration` に転記する。dev-integrate 親は worktree を直接操作せず、状態管理に専念する:

```bash
$SKILLS_DIR/_lib/scripts/flow-update.sh --flow-state "$FLOW_STATE" \
    integration --field status --value "integrated"
$SKILLS_DIR/_lib/scripts/flow-update.sh --flow-state "$FLOW_STATE" \
    integration --field merge_worktree --value "$WORKTREE_PATH"
$SKILLS_DIR/_lib/scripts/flow-update.sh --flow-state "$FLOW_STATE" \
    integration --field merge_results --value "$MERGE_RESULTS_JSON"
$SKILLS_DIR/_lib/scripts/flow-update.sh --flow-state "$FLOW_STATE" \
    integration --field conflicts --value "$CONFLICTS_COUNT"
```

## 制約

- 直接 `git worktree add` の実行は **禁止** (merge worktree は worker 経由のみ)
- merge branch は **リモートに push しない**。push は後続の PR 作成ステップ (parent 側) で行う
- worker は flow.json を read-only で扱い、書き込みは必ず parent (dev-integrate) が行う

## 前提

- Claude Code >= 2.1.63 (`isolation: worktree` フィールド対応)
- `.claude/agents/dev-kickoff-worker.md` がリポジトリに存在し、`mode: merge` 分岐が実装されていること

## Subagent Dispatch 5要素

共通規約 ([`_shared/references/subagent-dispatch.md`](../../_shared/references/subagent-dispatch.md)) に沿って以下を遵守する。

1. **Objective** — 「contract branch `feature/issue-${ISSUE}-contract` をベースに merge 用 branch `feature/issue-${ISSUE}-merge` (or `-merge-retry`) を isolated worktree で作成し、`merge-subtasks.sh` → 型チェック → `dev-validate` を実行して `{status, branch, worktree_path, commit_sha, merge_results, conflicts}` を返す」
2. **Output format** — `{ status: "completed"|"failed", branch: string, worktree_path: string, commit_sha: string, merge_results: object, conflicts: number, phase_failed?: string, error?: string }` JSON。`merge_results` は `merge-subtasks.sh` の出力をそのまま埋め込む。
3. **Tools** — worker frontmatter で許可: `Bash, Read, Write, Edit, Skill, TodoWrite, Glob, Grep`。dev-integrate 側から追加 tool 制約は付けない
4. **Boundary** — worker は自身の isolated worktree 内のみで作業、`git push` 禁止 (merge branch も含む)、subtask / contract branch を rewrite しない、`git worktree add` を直接実行しない、flow.json を書き込まない (read-only)
5. **Token cap** — worker 1 回あたり 2000 turn 以内 (`dev-kickoff-worker.md` 既定)、merge mode は通常 1 spawn で完結。失敗時のみ `-merge-retry` で最大 1 回 re-spawn する

## Routing

- merge worktree 作成 + merge 実行 → `dev-kickoff-worker` (sonnet, `isolation: worktree`, `mode: merge`)
- merge 結果集約 / flow.json 書き込み → dev-integrate 親 (sonnet)
- type check / validation 詳細は worker 内で完結 (dev-validate が委譲する)
