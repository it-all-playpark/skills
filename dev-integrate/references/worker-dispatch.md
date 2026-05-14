# Step 4: Worker Subagent Dispatch (merge mode)

dev-integrate の merge worktree 作成は、`dev-kickoff-worker` を `mode: merge` で spawn することで行う。

共通規約 (Agent テンプレート、共通 Output schema、共通制約、5要素のうち共通部、Routing) は [`_shared/references/worker-dispatch.md`](../../_shared/references/worker-dispatch.md) を参照。本書は merge mode 固有の差分のみ記載する。

## Prompt パラメータ (merge mode 差分)

| Field | Value (初回) | Value (retry) |
|---|---|---|
| `branch_name` | `feature/issue-${ISSUE}-merge` | `feature/issue-${ISSUE}-merge-retry` |
| `base_ref` | `feature/issue-${ISSUE}-contract` | (同左) |
| `mode` | `merge` | (同左) |
| `flow_state` | `$FLOW_STATE` (path) | (同左) |

`task_id` は使用しない。

## Output schema (merge mode 拡張)

共通 schema に以下を追加:

```json
{
  "merge_results": {
    "status": "success" | "failed",
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

失敗時は共通 schema の `status: "failed"` / `phase_failed: "merge"` / `error` に加え、`merge_results.status: "failed"` と `conflicts: <count>` が入る。

## Parent (dev-integrate) の責務

worker から返った JSON をそのまま `flow.json.integration` に転記する。parent は worktree を直接操作せず、状態管理に専念する:

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

## 5要素 (merge mode 固有)

- **Objective** — 「contract branch をベースに `feature/issue-${ISSUE}-merge` (or `-merge-retry`) を isolated worktree で作成し、`merge-subtasks.sh` → 型チェック → `dev-validate` を実行して `{..., merge_results, conflicts}` を返す」
- **Boundary (追加)** — subtask / contract branch を rewrite しない
- **Token cap (caller 上限)** — 通常 1 spawn で完結。失敗時のみ `-merge-retry` で最大 1 回 re-spawn

## Routing 追記

- type check / validation 詳細は worker 内で完結 (`dev-validate` が委譲する)
