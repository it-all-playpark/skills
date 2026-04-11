# kickoff.json Schema

`$WORKTREE/.claude/kickoff.json` のスキーマ定義。`dev-kickoff` ワークフロー全体の state を保持する。

## 全体構造

```jsonc
{
  "version": "3.0.0",
  "issue": 42,
  "branch": "feature/issue-42-m",
  "worktree": "/path/to/worktree",
  "base_branch": "dev",
  "started_at": "2026-04-11T10:00:00Z",
  "updated_at": "2026-04-11T11:30:00Z",
  "current_phase": "4_implement",

  "phases": { /* phase ごとの status・結果 */ },
  "next_actions": ["..."],
  "config": { /* testing / design / depth / lang / env_mode */ },

  // --- Narrative & immutability フィールド (v3.1.0〜) ---
  "feature_list": [
    { "id": "F1", "desc": "...", "status": "todo" }
  ],
  "progress_log": [
    { "ts": "2026-04-11T10:00:00Z", "phase": "3", "note": "plan 完了" }
  ],
  "decisions": [
    { "ts": "2026-04-11T10:30:00Z", "topic": "cache strategy", "decision": "Redis 採用" }
  ]
}
```

## 新規フィールド (v3.1.0〜)

### `feature_list` — immutable feature list

**目的**: Anthropic 公式「Effective harnesses for long-running agents」の feature list immutability パターンを実現する。`dev-plan-impl` が一度だけ書き込み、以降は `status` のみ更新する。

| Field | Type | Required | Mutable | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | **NO** | `F1`, `F2`, ... のような一意識別子 |
| `desc` | string | yes | **NO** | 機能の簡潔な説明（impl-plan.md と対応） |
| `status` | string | yes | **YES** | `todo` / `in_progress` / `done` / `skipped` |

**書き込みルール**:

1. **初期化**: `dev-plan-impl` の Step 5 完了後に `impl-plan.md` から抽出して一度だけ書き込む。
2. **immutability**: `id` と `desc` は以降 **書き換え禁止**。`dev-validate` が警告を出す。
3. **status 更新**: `dev-implement` が各 feature 完了時に `update-feature.sh` 経由で変更する。
4. **LLM による直接編集禁止**: `Edit` ツールで feature_list を直接書き換えない。必ず `update-feature.sh` を使用する。

### `progress_log` — append-only narrative

**目的**: phase 遷移や重要決定を時系列で記録し、SessionStart hook から Claude が context に取り込む。

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ts` | string (ISO8601 UTC) | yes | タイムスタンプ |
| `phase` | string | yes | 記録時点の phase (`1`, `2`, `3`, `3b`, `4`, `5`, `6`, `7`, `8`) |
| `note` | string | yes | 短い narrative (1-2 行) |

**書き込みルール**:

1. **append-only**: 既存エントリの書き換え・削除禁止。
2. **追加手段**: `dev-kickoff/scripts/append-progress.sh` のみを使用する。
3. **頻度**: phase 遷移時 + feature 完了時 + 重要な設計判断時。ログ過多を避ける。

### `decisions` — 設計判断の記録

**目的**: 設計判断を後から参照できるようにする。`progress_log` より詳細な「なぜ」を記録する。

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ts` | string (ISO8601 UTC) | yes | タイムスタンプ |
| `topic` | string | yes | 判断対象トピック (例: "cache strategy") |
| `decision` | string | yes | 判断内容と理由 |

**書き込みルール**: append-only。`decisions` フィールドは `init-kickoff.sh` で `[]` 初期化される。

## 後方互換

- 既存の kickoff.json に `feature_list` / `progress_log` が無い場合は **空配列扱い**。
- 読み取り側は必ず `// []` フォールバックを使う:
  ```bash
  jq '.feature_list // []' kickoff.json
  jq '.progress_log // []' kickoff.json
  ```
- `append-progress.sh` / `update-feature.sh` は、フィールド未定義の kickoff.json に対して自動的にフィールドを作成する。

## SessionStart hook 連携

`dotfiles` 側の SessionStart hook が `$WORKTREE/.claude/kickoff.json` を検知した場合、以下を context に注入する想定（別 issue で実装）:

- `feature_list` の `status == "todo"` のエントリのみ
- `progress_log` の末尾 5 件
- `decisions` 全件

## 関連スクリプト

- `dev-kickoff/scripts/init-kickoff.sh` — 初期化
- `dev-kickoff/scripts/append-progress.sh` — `progress_log.append`
- `dev-kickoff/scripts/update-feature.sh` — `feature_list[i].status` 更新
- `dev-validate/scripts/validate-kickoff.sh` — immutability warning

## 参考

- Anthropic: [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
