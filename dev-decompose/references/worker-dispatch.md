# Step 8: Worker Subagent Dispatch (parallel mode)

各 subtask に対し `dev-kickoff-worker` を `mode: parallel` で spawn し、contract branch をベースに subtask 用 worktree を作成する。

共通規約 (Agent テンプレート、共通 Output schema、共通制約、5要素のうち共通部、Routing) は [`_shared/references/worker-dispatch.md`](../../_shared/references/worker-dispatch.md) を参照。本書は parallel mode 固有の差分のみ記載する。

## Prompt パラメータ (parallel mode 差分)

| Field | Value |
|---|---|
| `branch_name` | `feature/issue-${ISSUE}-task${INDEX}` |
| `base_ref` | `feature/issue-${ISSUE}-contract` |
| `mode` | `parallel` |
| `task_id` | `task${INDEX}` |
| `flow_state` | `$FLOW_STATE` (path) |

返却値は共通 Output schema (拡張フィールドなし)。worker は parallel mode で `git push` をスキップする。

## 5要素 (parallel mode 固有)

- **Objective** — 「contract branch をベースに `feature/issue-${ISSUE}-task${INDEX}` を isolated worktree で作成し、共通 schema を返す」(Phase 1 のみ。Phase 2-7 は dev-kickoff から `--task-id` で再呼び出し)
- **Token cap (caller 上限)** — Step 8 全体で subtask 数 ≤ 5 を推奨
