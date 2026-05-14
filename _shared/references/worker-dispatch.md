# dev-kickoff-worker Dispatch (Common)

dev-flow family が `dev-kickoff-worker` subagent を `isolation: worktree` で spawn する際の共通規約。caller skill (`dev-decompose`, `dev-integrate`, 将来 `dev-kickoff` single mode) は本書を参照し、mode 固有の差分のみを自 refs に残す。

## 適用 caller / mode

| Caller skill | Mode | Refs (mode 固有) |
|---|---|---|
| `dev-decompose` | `parallel` | [`dev-decompose/references/worker-dispatch.md`](../../dev-decompose/references/worker-dispatch.md) |
| `dev-integrate` | `merge` | [`dev-integrate/references/worker-dispatch.md`](../../dev-integrate/references/worker-dispatch.md) |
| `dev-kickoff` | `single` / `parallel` | (SKILL.md 内に inline) |

## Agent 呼び出しテンプレート

```text
Agent(
  subagent_type: "dev-kickoff-worker",
  isolation: "worktree",
  prompt: "
    issue_number: $ISSUE
    branch_name: <mode-specific>
    base_ref: <mode-specific>
    mode: <single|parallel|merge>
    task_id: <parallel mode only>
    flow_state: <parallel/merge mode only>
  "
)
```

`branch_name` / `base_ref` / 追加パラメータの実値は mode 固有 refs を参照。

## 共通 Output schema (last-line JSON)

```json
{
  "status": "completed" | "failed",
  "branch": "<branch name>",
  "worktree_path": "<absolute path>",
  "commit_sha": "<HEAD sha>",
  "phase_failed": "<phase id, on failure>",
  "error": "<message, on failure>"
}
```

mode 別の拡張フィールド (例: `merge_results`, `conflicts`, `pr_url`) は mode 固有 refs に記載。

## 共通制約

- `git worktree add` の直接実行は **禁止**。worktree は worker 経由でのみ作成
- worker は自身の isolated worktree 内のみで作業し、subtask / contract / merge branch を相互に書き換えない
- subtask / contract / merge branch は **リモートに push しない**。push は PR 作成ステップで親が行う
- worker は `flow.json` を **read-only** で扱う。書き込みは必ず親 skill が `_lib/scripts/flow-update.sh` 経由で行う

## 前提

- Claude Code >= 2.1.63 (`isolation: worktree` フィールド対応)
- `.claude/agents/dev-kickoff-worker.md` がリポジトリに存在し、対象 mode 分岐が実装されていること

## Subagent Dispatch 5要素 (共通部)

基底規約は [`subagent-dispatch.md`](subagent-dispatch.md) を参照。worker dispatch では以下を全 caller で固定:

| 要素 | 共通値 |
|---|---|
| Tools | worker frontmatter で許可: `Bash, Read, Write, Edit, Skill, TodoWrite, Glob, Grep`。caller 側から追加 tool 制約は付けない |
| Token cap (worker 単位) | 1 spawn あたり 2000 turn 以内 (`dev-kickoff-worker.md` 既定) |
| Boundary (共通) | worker は自 worktree 内のみ作業 / `git push` 禁止 / `git worktree add` 直接実行禁止 / `flow.json` read-only |

`Objective` / `Output format` 詳細 / 追加 `Boundary` / `Token cap` の caller 単位上限 (例: subtask 数、retry 回数) は mode 固有 refs に記載。

## Routing

- worktree 作成 + worker 内ワークフロー → `dev-kickoff-worker` (sonnet, `isolation: worktree`)
- 結果集約 / `flow.json` 書き込み / retry 判断 → caller skill 親
- 探索 heavy / planning は worker ではなく caller 親 or 別 subagent (Explore/Plan)
