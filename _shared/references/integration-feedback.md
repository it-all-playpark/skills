# Integration Feedback Channel (Message Bus パターン — run 間学習)

> _「Events flow from one stage to the next, teams can add new agent types as
> threat categories evolve.」_
> — [Anthropic: Multi-Agent Coordination Patterns (2025)](https://claude.com/blog/multi-agent-coordination-patterns)

## 目的

`dev-integrate` で発生した conflict / integration failure は、現状 1 回限りの情報として
消費され、次回 `dev-decompose` の subtask 境界判断には反映されない。結果として、同じ
file や同じ directory 配下で **繰り返し同種の conflict が起きる** 可能性がある。

`_shared/integration-feedback.json` は、この run 間学習を実現するための軽量 event
store（Message Bus パターン）。`#51` の `flow.json.shared_findings` が
**1 run 内の並列 worker 間**で知見を共有するのに対し、integration feedback は
**複数 run を跨いで** 蓄積される evolving knowledge base になる。

```
run 1: dev-integrate がtypes/user.ts で conflict
         → integration-event-append (ev_042)
run 2: dev-decompose --dry-run が past events を見る
         → types/user.ts が過去 3 回コンフリクトしていると検出
         → decomposition plan に hint を付与
run 3+: dev-flow-doctor が recurring pattern を warning 表示
```

## スキーマ

`_shared/integration-feedback.json` は repo-tracked（commit される）。schema は
[`_lib/schemas/integration-feedback.schema.json`](../../_lib/schemas/integration-feedback.schema.json)
に定義。

```jsonc
{
  "version": "1.0.0",
  "events": [
    {
      "id": "ev_001",                        // auto-generated
      "timestamp": "2026-04-11T10:00:00Z",
      "source_issue": 42,
      "event_type": "conflict",              // conflict | integration_failure | cross_subtask_dependency
      "files": ["src/types/user.ts"],        // 少なくとも 1 件
      "subtask_pair": ["task1", "task2"],    // optional
      "resolution": "unresolved",            // manual_merge | auto_resolved | re_decompose | restart | unresolved
      "lesson": "同一 types/ 配下のファイルは 1 subtask にまとめるべき"
    }
  ]
}
```

- **append-only**: 既存 event は書き換えない。訂正は新しい event を書く。
- **自動 trim**: `max_events`（既定 500）を超えた場合は先頭から削除。
  環境変数 `INTEGRATION_FEEDBACK_MAX_EVENTS` or `--max-events` で上書き可能。
- **version 1.0.0**: reader は未知 version を empty として扱う。

## 書き込み — `dev-integrate` (run 間 pub)

`dev-integrate/scripts/merge-subtasks.sh` が conflict / integration failure を
検出したタイミングで `integration-event-append.sh` を呼ぶ。

```bash
$SKILLS_DIR/_shared/scripts/integration-event-append.sh \
  --source-issue 42 \
  --event-type conflict \
  --files "src/types/user.ts,src/api/auth.ts" \
  --subtask-pair "task1" \
  --resolution unresolved \
  --lesson "未解決の code conflict — 同一 file を複数 subtask に割り当てない"
```

- 戻り値: `{"status":"appended","event_id":"ev_042"}`
- **書き込みは best-effort**: append が失敗しても `merge-subtasks.sh` の主処理は
  継続する（`|| true` でエラー抑制）。dev-integrate の正常系を壊さない。
- 並列 run からの同時書き込みは `.lockdir` による mkdir-based file lock で安全
  （#51 の `flow-append-finding.sh` と同じ戦略）。

### 書き込まれる event の一覧

| イベント | event_type | resolution |
|---------|-----------|-----------|
| Auto-resolved lock/config conflict | `conflict` | `auto_resolved` |
| Unresolvable code conflict | `conflict` | `unresolved` |
| `git merge` が conflict marker なしで失敗 | `integration_failure` | `unresolved` |

## 読み出し — `dev-decompose --dry-run` (run 間 sub)

`dev-decompose --dry-run` は、file grouping を決定する前に過去の feedback を読む。

```bash
$SKILLS_DIR/dev-decompose/scripts/analyze-past-conflicts.sh \
  --affected-files "src/types/user.ts,src/api/auth.ts,src/middleware/jwt.ts" \
  --limit 50 \
  --min-occurrences 2
```

出力:

```json
{
  "has_hints": true,
  "scanned_events": 42,
  "recurring_files": [
    {"file": "src/types/user.ts", "occurrences": 3,
     "lessons": ["同一 types/ 配下のファイルは 1 subtask にまとめる"]}
  ],
  "recurring_prefixes": [
    {"prefix": "src/types", "occurrences": 4}
  ]
}
```

これを dry-run の返却 JSON に `past_conflict_hints` として同梱し、decomposer LLM が
subtask grouping の最終判断に使う。**hint は強制ではない**: LLM が最終判断する。

### 読み出しの低レベル API

任意の filter で event を読む場合は `integration-event-read.sh` を使う:

```bash
# 最新 20 件
$SKILLS_DIR/_shared/scripts/integration-event-read.sh --limit 20

# conflict のみ
$SKILLS_DIR/_shared/scripts/integration-event-read.sh --event-type conflict

# 特定 issue 由来のみ
$SKILLS_DIR/_shared/scripts/integration-event-read.sh --source-issue 42

# src/types/ 配下のみ
$SKILLS_DIR/_shared/scripts/integration-event-read.sh --file-prefix "src/types/"
```

- 出力は JSON 配列、最新順。
- 欠損 / 破損 file は常に `[]` を返す（読み込みはエラーにしない）。

## 診断 — `dev-flow-doctor`

`run-diagnostics.sh --scope feedback`（full にも含まれる）が
`_shared/integration-feedback.json` を読み、`min_occurrences >= 3` の再発 pattern を
warning として surface する。詳細は dev-flow-doctor の
[`diagnostic-checks.md`](../../dev-flow-doctor/references/diagnostic-checks.md)
の Check 9 を参照。

健康スコアへの影響は軽微（最大 -5）— 誤診で全体 score を壊さないよう抑制している。

## 設計メモ

- **Shared findings との違い**: `flow.json.shared_findings` は 1 run 内 (parallel
  worker 間)、`integration-feedback.json` は run 間。スケールが直交する。
- **single-writer 原則の緩和**: どちらも mkdir-based file lock で multi-writer
  safety を確保する。`flow-append-finding.sh` と `integration-event-append.sh` で
  同じ lock パターンを採用している。
- **git tracked**: intentional。チームで共有する knowledge base として機能させる。
  個別マシン固有にしない。
- **trim は保守的**: `max_events=500` まで履歴を保持。過去の "見落としていた pattern"
  も後から見つけられるようにする。
- **非 decomposition use-case**: feedback 自体はシンプルな event store なので、
  将来 `dev-evaluate` が past regression pattern を見たり、`dev-implement` が
  「似たような tests で過去 3 回 flake した」履歴を参照したりする拡張もしやすい。

## 関連

- Issue: #52
- Epic: #38
- 前提: #51 (`flow.json.shared_findings` — 1 run 内 channel)
- 参考: [Anthropic — Multi-Agent Coordination Patterns](https://claude.com/blog/multi-agent-coordination-patterns)
  の **Message Bus パターン**（「Events flow from one stage to the next」）

## API 早見表

| script | 目的 | best-effort |
|--------|------|-------------|
| `_shared/scripts/integration-event-append.sh` | conflict / failure を pub | yes (caller ignores failures) |
| `_shared/scripts/integration-event-read.sh` | event を filter 付きで sub | yes (missing file → `[]`) |
| `dev-decompose/scripts/analyze-past-conflicts.sh` | hint を集計して dry-run に提供 | yes |
| `dev-flow-doctor/scripts/run-diagnostics.sh --scope feedback` | 再発 pattern を warning 化 | yes |
