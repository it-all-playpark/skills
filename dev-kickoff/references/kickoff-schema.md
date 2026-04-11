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

## `termination` block (v3.2.0〜) — Generator-Verifier loop 終了状態

**目的**: dev-kickoff が内包する 2 つの evaluator-optimizer（Generator-Verifier）ループ
（Phase 3 ⇄ 3b, Phase 4-5 ⇄ 6）の終了理由と verdict 履歴を **統一 schema** で記録する。
これにより `dev-flow-doctor` が verdict_history を横断分析できる
（e.g.「同一 feedback_target が 2 回以上繰り返された → 設計問題の可能性」）。

### 位置

- `phases.3b_plan_review.termination` — Plan-Review loop の終了状態
- `phases.6_evaluate.termination` — Evaluate-Retry loop の終了状態

### Schema

```jsonc
{
  "termination": {
    "reason": "converged",          // 必須 enum: 下記参照
    "final_iteration": 2,            // 1-indexed、loop が実際に回った回数
    "final_verdict": "pass",         // loop 終了時の最終 verdict (phase 依存 vocabulary)
    "verdict_history": [             // append-only、iteration ごと
      { "iteration": 1, "verdict": "revise", "score": 72 },
      { "iteration": 2, "verdict": "pass",   "score": 85 }
    ],
    "recorded_at": "2026-04-11T11:45:00Z"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reason` | string (enum) | yes | `converged` / `max_iterations` / `stuck` / `fork_failure` |
| `final_iteration` | integer (≥ 0) | yes | 1-indexed。0 は loop 未実行（fork_failure 等） |
| `final_verdict` | string | no | phase 固有 vocabulary（Phase 3b: `pass`/`revise`/`block`、Phase 6: `pass`/`fail`） |
| `verdict_history` | array | yes | append-only。要素 schema は下記 |
| `recorded_at` | string (ISO8601 UTC) | yes | 記録タイムスタンプ |

### `reason` enum

| reason | 意味 |
|--------|------|
| `converged` | verdict `pass` に到達 → 正常終了 |
| `max_iterations` | 最大 iteration 回数に到達してもまだ pass していない |
| `stuck` | 同一 finding が連続 iteration に残った（Phase 3b のみ） |
| `fork_failure` | `context:fork` による generator / verifier 起動に失敗 |

### `verdict_history[]` 要素 schema

#### Phase 3b (`3b_plan_review`)

```jsonc
{
  "iteration": 1,
  "verdict": "revise",   // "pass" | "revise" | "block"
  "score": 72
}
```

#### Phase 6 (`6_evaluate`)

```jsonc
{
  "iteration": 1,
  "verdict": "fail",              // "pass" | "fail"
  "feedback_target": "design"     // "design" | "implementation"、pass 時は省略可
}
```

`feedback_target` は `dev-flow-doctor` の診断対象フィールド。同一 `feedback_target` が
**2 iteration 連続**で発生すると "repeated_feedback_target" として flag される
（[dev-flow-doctor diagnostic-checks.md Check 9](../../dev-flow-doctor/references/diagnostic-checks.md) 参照）。

### 書き込みルール

1. **共通呼び出し点**: `_shared/scripts/termination-record.sh` を使用する。
   両ループ（dev-kickoff Phase 3b / Phase 6）から同じインターフェースで呼び出す。
2. **dev-kickoff 互換**: `dev-kickoff/scripts/update-phase.sh` の
   `--termination-reason` オプション経由でも書き込める。
3. **verdict_history の append**: `--append-verdict '<JSON>'` で単一 verdict を追加する。
   `final_iteration` は自動的に配列長に同期する。
4. **原子性**: `mktemp + mv` による atomic write を必ず行う。
5. **冪等性**: 同じ reason を複数回書き込んでも state は崩れない。
   `verdict_history` は append-only なので、同じ iteration を再度 append しないよう
   呼び出し側が重複排除する責任を持つ。

### 後方互換（1 リリース間維持、v3.2.0 → v3.3.0 で削除予定）

既存の Phase 3b escalation フィールドは **deprecated** だが termination block と並行して
書き込まれる:

| 旧フィールド | 新しい位置 | deprecation |
|------------|-----------|-------------|
| `phases.3b_plan_review.escalated` (bool) | `termination.reason != "converged"` で true | deprecated、v3.3.0 で削除予定 |
| `phases.3b_plan_review.escalation_reason` | `termination.reason` | 同上 |
| `phases.3b_plan_review.stuck_findings` | `termination.reason == "stuck"` の補足情報 | 同上、termination block の `verdict_history` では表現しない |
| `phases.3b_plan_review.last_verdict` | `termination.final_verdict` | 同上 |
| `phases.3b_plan_review.last_score` | 最後の `verdict_history[].score` | 同上 |
| `phases.6_evaluate.iterations[]` | `termination.verdict_history` | `iterations[]` は eval_result 全文を残すため継続維持 |
| `phases.6_evaluate.current_iteration` | `termination.final_iteration` | 継続維持（状態機械の読み取りに使用） |

読み取り側は **termination block を優先** し、存在しなければ旧フィールドへフォールバックする。

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
- `dev-kickoff/scripts/update-phase.sh` — phase 状態 + termination block 書き込み
- `_shared/scripts/termination-record.sh` — 両ループ共通の termination block 書き込み
- `dev-flow-doctor/scripts/analyze-termination-loops.sh` — verdict_history 横断分析
- `dev-validate/scripts/validate-kickoff.sh` — immutability warning

## 参考

- Anthropic: [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
