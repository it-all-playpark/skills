# Worker Subagent Dispatch (issue #93 以降)

issue #93 で `dev-kickoff-worker` の `mode: merge` および dev-integrate の Kahn 法
topological merge は撤廃された。dev-integrate は **independent worker を spawn しない**:

- merge worktree 作成は不要（child PR は直接 `integration/issue-{N}-{slug}` に merge される）
- `merge-subtasks.sh` / `topo-sort.sh` / `merge-subagent-result.sh` / `check-unacked-findings.sh`
  は全て削除済み
- dev-integrate に残る役割は `verify-children-merged.sh` のみ：integration branch 上で全 child の
  merge commit が揃っているかを最終 PR 作成前に検証する

## 移行先

| 旧 (廃止) | 新 (issue #93) |
|-----------|---------------|
| `dev-kickoff-worker mode: merge` | (廃止) child PR は `auto-merge-child.sh` が `integration/issue-*` base に対して `--admin` merge |
| `merge-subtasks.sh` | (廃止) child PR の標準 merge で代替 |
| `topo-sort.sh` | (廃止) batch 配列 (`flow.json.batches[]`) が順序を表現 |
| `check-unacked-findings.sh` | (廃止) `shared_findings` 廃止に伴い不要 |
| dev-integrate Step 4 (worker spawn) | `verify-children-merged.sh` |

共通の subagent dispatch 規約は [`_shared/references/worker-dispatch.md`](../../_shared/references/worker-dispatch.md) を参照。

## References

- Issue #93: child-split mode 統一、parallel/merge 撤廃、Kahn 法 merge 廃止
- `_lib/scripts/auto-merge-guard.sh` / `dev-flow/scripts/auto-merge-child.sh`
- `_shared/scripts/run-batch-loop.sh`
