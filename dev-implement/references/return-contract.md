# Return Contract — dev-implement worker

dev-implement の worker（および dev-kickoff-worker から呼び出される実装サイクル）は、
完了時に **4 値 status enum** を含む JSON を返す。本ドキュメントはその schema を定義する。

dev-kickoff の Phase 5/6 orchestrator は本 contract に従って分岐する。詳細な分岐ロジックは
[`../../dev-kickoff/references/evaluate-retry.md`](../../dev-kickoff/references/evaluate-retry.md) を参照。

## Status enum

| status | 意味 | 必須フィールド (追加) | dev-kickoff orchestrator の挙動 |
|---|---|---|---|
| `DONE` | 実装完了、self-doubt なし | (なし、ベースフィールドのみ) | → Phase 6 (dev-evaluate) へ進む |
| `DONE_WITH_CONCERNS` | 完了したが implementer が懸念を申告 | `concerns: string[]` (>= 1 要素、各要素非空) | → Phase 6 に `focus_areas = concerns[]` を渡して重点監査 |
| `BLOCKED` | 同アプローチでは進めない（環境問題 / 設計不適合 / 要件矛盾） | `blocking_reason: string` (非空、>= 10 文字) | → **同アプローチでの retry 禁止**。`update-phase.sh --reset-to 3_plan_impl` で Phase 3 に戻し、`blocking_reason` を `plan-review-feedback.json` 経由で渡す |
| `NEEDS_CONTEXT` | 不足情報あり（issue body 不足 / related code 未読 / 前段 task 結果未参照） | `missing_context: string[]` (>= 1 要素、各要素非空) | → 不足情報を補足して Phase 4 に再 dispatch。連続 2 回 `NEEDS_CONTEXT` で human escalate |

**全 status 共通の必須ベースフィールド**: `status`, `branch`, `worktree_path`, `commit_sha`。

**任意フィールド**: `pr_url` (Phase 8 完了時のみ), `phase_failed` (失敗 phase 番号), `error` (失敗メッセージ)。

## 互換マッピング (legacy mapping)

dev-kickoff の status parser は、worker 出力に `status` が欠落しているか、旧形式（`success` / `fail`）の場合
のみ以下の legacy mapping を適用する。新規 worker 実装はこの mapping に依存してはならない。

| Legacy 値 | 新 status | 補完フィールド | journal カウンタ |
|---|---|---|---|
| `"success"` | `DONE` | (なし) | `legacy_success` |
| `"fail"` | `BLOCKED` | `blocking_reason: "Legacy worker returned 'fail'; treat as approach mismatch (rollout heuristic)"` | `legacy_fail` |
| 文字列以外 / 上記以外 | (適用しない) | (適用しない) | schema error として journal failure 記録 |

互換マッピングを適用した entry には `kickoff.json.phases.6_evaluate.iterations[].generator_meta.legacy_mapped: true` を記録する。

### legacy_mapped 時の focus_area 汚染防止

dev-evaluate は `generator_meta.legacy_mapped == true` の entry を受け取った場合、`focus_areas` を
synthesize する際に `blocking_reason` / `concerns[]` をそのまま使わず、**全範囲監査モード**に切り替える。
これは synthetic な reason 文字列（"Legacy worker returned 'fail'..." 等）で evaluator の探索範囲を
人工的に狭めないため。

## サンプル JSON

### DONE
```json
{
  "status": "DONE",
  "branch": "feature/issue-92-m",
  "worktree_path": "/abs/path",
  "commit_sha": "abc1234..."
}
```

### DONE_WITH_CONCERNS
```json
{
  "status": "DONE_WITH_CONCERNS",
  "branch": "feature/issue-92-m",
  "worktree_path": "/abs/path",
  "commit_sha": "abc1234...",
  "concerns": [
    "test-status-distribution.sh の fixture が現実の journal 形式と乖離している可能性",
    "互換 mapping の edge case (status が数値型で来る) が未テスト"
  ]
}
```

### BLOCKED
```json
{
  "status": "BLOCKED",
  "branch": "feature/issue-92-m",
  "worktree_path": "/abs/path",
  "commit_sha": "abc1234...",
  "blocking_reason": "現状の dev-kickoff scripts は --reset-to 引数を持たないため、Phase 3 再走の hand-off が API レベルで実現できない。先に update-phase.sh の API 拡張が必要。"
}
```

### NEEDS_CONTEXT
```json
{
  "status": "NEEDS_CONTEXT",
  "branch": "feature/issue-92-m",
  "worktree_path": "/abs/path",
  "commit_sha": "",
  "missing_context": [
    "並列 mode で dev-decompose がどの prompt 経路を取るかの実装ファイル",
    "issue body に書かれていない invariants (例: kickoff.json schema version 4 への移行有無)"
  ]
}
```

## feature_list との関係

`kickoff.json.feature_list[i].status` (`todo|in_progress|done|skipped`) は **本 contract とは別 namespace**。
本 contract の `status` は dev-implement worker の return 値であり、各 feature の進捗ではない。混同しないこと。

## 関連

- [`../SKILL.md`](../SKILL.md) — dev-implement Workflow 本体
- [`../../_shared/references/subagent-dispatch.md`](../../_shared/references/subagent-dispatch.md) — 4 値 status enum と "Paste, Don't Link" 規約の中央定義
- [`../../dev-kickoff/references/evaluate-retry.md`](../../dev-kickoff/references/evaluate-retry.md) — status 別の Phase 5/6 分岐
