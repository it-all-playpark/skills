# Shared Findings Channel (Shared State Pattern)

> _「agents build on each other's work, and the shared store becomes an evolving knowledge base.」_
> — [Anthropic: Multi-Agent Coordination Patterns (2025)](https://claude.com/blog/multi-agent-coordination-patterns)

## 目的

`dev-flow --force-parallel` で起動した複数の `dev-kickoff` worker は独立 worktree で動くため、横断的な発見（共通型の破壊変更・API 契約の解釈・repo-wide な設計判断・依存追加）を他 worker に伝える手段がない。結果として integration 時点でしか衝突が発見されず、orchestrator bottleneck が顕在化する。

`flow.json.shared_findings[]` は、この横断知見を格納する **evolving knowledge base** である。Phase 3 (plan) の入力に組み込むことで、worker は互いの設計判断を取り込んだ plan を立てられる。

## いつ finding を書くか

| ケース | category | 例 |
|-------|----------|-----|
| 共通型・共有 interface に破壊的変更を入れた | `breaking_change` | `User` に `email_verified?: boolean` を追加 |
| API エンドポイント契約の解釈を固めた | `api_contract` | `POST /login` の `totp` は optional 扱い |
| repo-wide な設計判断を下した | `design_decision` | logger は `pino` に統一 |
| 新しい依存を追加した | `dependency` | `ajv@8` を追加、型検証はこれで統一 |

**原則**: 他 worker の実装に影響する判断だけ書く。ローカル実装詳細は書かない（ノイズになる）。

## スキーマ

```jsonc
{
  "shared_findings": [
    {
      "id": "sf_001",                         // auto-generated
      "task_id": "task1",                     // author subtask
      "timestamp": "2026-04-11T10:00:00Z",
      "category": "breaking_change",
      "scope": ["src/types/user.ts"],
      "title": "User 型に email_verified を追加",
      "description": "OAuth provider から返る値を保持するため optional で追加。",
      "action_required": "consumers must handle the optional field",
      "acknowledged_by": ["task2", "task3"]
    }
  ]
}
```

`shared_findings` フィールドは flow.json 生成時に必ず初期化される（`init-flow.sh` が `[]` を書き込む）。

## 書き込み (worker 側 — Phase 4/5)

```bash
$SKILLS_DIR/_shared/scripts/flow-append-finding.sh \
  --flow-state "$FLOW_STATE" \
  --task-id "$TASK_ID" \
  --category breaking_change \
  --title "User 型に email_verified を追加" \
  --description "OAuth provider から返る値を保持するため optional 追加" \
  --scope "src/types/user.ts,src/api/auth.ts" \
  --action-required "consumers must handle the optional field"
```

- `id` と `timestamp` は自動生成される (`sf_001`, `sf_002`, ...)
- 並列 worker からの同時書き込みは `flow.json.lockdir` による排他で安全
- 戻り値: `{"status":"appended","finding_id":"sf_003"}`

## 読み出し (worker 側 — Phase 3 plan 入力)

### 未 ack の finding を取得 + ack

```bash
NEW_FINDINGS=$($SKILLS_DIR/_shared/scripts/flow-read-findings.sh \
  --flow-state "$FLOW_STATE" \
  --task-id "$TASK_ID" \
  --unacked-only \
  --ack)

# $NEW_FINDINGS は JSON 配列。空なら他 worker からの新情報なし。
```

`--unacked-only` は次を除外する:

- 自分自身（`task_id == $TASK_ID`）が書いた finding
- すでに `acknowledged_by` に自分の id が入っている finding

`--ack` をつけると、返した finding 全てに対して atomic に `acknowledged_by += $TASK_ID` が適用される（read-and-consume semantics）。

### 全 finding を取得 (読み取り専用)

```bash
$SKILLS_DIR/_shared/scripts/flow-read-findings.sh --flow-state "$FLOW_STATE"
```

## Ack 検証 (dev-integrate)

`dev-integrate` は merge 開始前に未 ack finding を確認する:

```bash
UNACKED=$($SKILLS_DIR/dev-integrate/scripts/check-unacked-findings.sh \
  --flow-state "$FLOW_STATE")
COUNT=$(echo "$UNACKED" | jq -r '.unacked_count')

if [[ "$COUNT" -gt 0 ]]; then
  echo "⚠️  $COUNT shared finding(s) not acknowledged by all subtasks:"
  echo "$UNACKED" | jq -r '.unacked[] | "  - \(.id) [\(.category)] \(.title) (missing: \(.missing_ack | join(",")))"'
fi
```

**未 ack は warning のみで block しない**（非決定論的な block 判断を避けるため）。必要に応じて人間が判断する。

## Worker フロー例

```
[flow.json] ← shared_findings: []

task1:                             task2:
  Phase 3 read-findings → []         Phase 3 read-findings → []
  Phase 4 実装:                       Phase 4 実装:
    User に email_verified 追加          (type 改修なし)
    append-finding sf_001              ...
  Phase 5 完了                         Phase 5 完了

task3 (後発):
  Phase 3 read-findings --ack → [sf_001]
    → plan の Architecture Decisions に反映
  Phase 4 実装 (email_verified を考慮した login flow)

dev-integrate:
  check-unacked-findings
    → task2 が sf_001 を ack していない → warning 表示
    → merge は続行
```

## 設計メモ

- **Single-writer 原則の例外**: worker (= parallel 実行されるサブプロセス) からの書き込みは `flow-append-finding.sh` 経由で mkdir-based file lock を取るため安全。`flow-update.sh` は orchestrator 専用のまま。
- **Ack は自己申告**: ack した = plan に反映した、という worker の自己申告。検証は人間側の責任範囲。
- **Finding は append-only**: 一度書いた finding は変更しない。訂正が必要なら新しい finding を書く。
- **Reader robustness**: reader (`flow-read-findings.sh`) は欠落時に `// []` で空配列に fallback するが、これは graceful read のための保険であり、writer 側 (`init-flow.sh` / `flow-append-finding.sh`) が新規生成する flow.json では `shared_findings` フィールドは必ず存在する。

## 関連

- Issue: #51
- Epic: #38
- 参考: [Anthropic — Multi-Agent Coordination Patterns](https://claude.com/blog/multi-agent-coordination-patterns) の Architectural Principle #4 "If agents need each other's findings in real-time, use shared state."
