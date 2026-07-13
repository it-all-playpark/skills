# dev-improve: dev-flow 自己改善ループ設計

- 日付: 2026-07-13
- ステータス: 設計承認済み（brainstorming セッションで各セクション承認）
- 対象: dev-flow パイプラインを telemetry 駆動で継続的に自己改善するループ機構

## 1. 目的と要件

dev-flow は telemetry 蓄積（journal handoff）と診断（dev-flow-doctor）までの部品を持つが、
「診断 → 改善 issue 化 → dev-flow による自己実装 → 効果の再観測」というループが未接続である。
本設計はこのループを閉じる。

承認済み要件:

| 軸 | 決定 |
|----|------|
| スコープ | フルループ自動化（診断→issue→実装→PR まで自動。merge のみ人間 — 既存 invariant 維持） |
| 改善ソース | 4 系統全部入り（doctor anomaly / 失敗 run RCA / sunset 監視 / PR 由来シグナル） |
| 駆動方式 | 週次 cron（ローカル bg job） |
| スループット | 厳選 1〜2 件/サイクル + backlog 繰越（dedup 付き） |
| 効果検証 | 仮説駆動追跡（期待 telemetry 変化を issue に埋め込み、次サイクル以降に実測突合。効果なしは revert 候補化） |
| アーキテクチャ | 新規 dynamic workflow `dev-improve.js` + 薄い起動 skill `/dev-flow-improve` |

## 2. 週次サイクル全体像

```
週次 cron（ローカル scheduled task, bg job）
 └─ /dev-flow-improve（薄い起動 skill）
     ├─ Workflow('dev-improve')  ← 新規 .claude/workflows/dev-improve.js
     │   ├─ Phase 1: Reconcile — 前サイクル仮説の実測突合
     │   ├─ Phase 2: Mine      — 4 ソース並列マイニング（parallel() 4 miners）
     │   ├─ Phase 3: Rank      — dedup + 優先度 rank + 上位 1〜2 件に絞る
     │   └─ Phase 4: File      — issue 作成（仮説ブロック埋め込み）→ issue 番号を返す
     └─ 返却 issue ごとに Skill('dev-flow') を順次起動（serial — worktree/CI 競合回避）
         → draft PR → pr-iterate → LGTM → 人間 merge（invariant 不変）
```

dev-improve から dev-flow を直接呼ばない二段構えは、workflow nesting 1 段制限
（dev-flow が既に `workflow('pr-iterate')` を nest している）による制約上の必然。

## 3. Phase 詳細

### Phase 1: Reconcile（仮説突合）

- label `self-improve` の closed issue（merged PR 付き）のうち hypothesis `status: pending`
  のものを exec-proxy（dev-runner-haiku-ro: `gh issue list` / `gh pr view`）で列挙。
- merge 日以降の telemetry window で期待 metric 変化を実測する決定論 script
  （`scripts/hypothesis-check.sh` 系。journal を読み doctor と同じ集計軸で該当 metric を算出）。
- 判定は 3 値: `confirmed` / `not-confirmed` / `insufficient-data`（データ不足は次サイクル持越し）。
- `not-confirmed` は **revert 候補**として Phase 3 の候補プールに入る（自動 revert はしない —
  blast-radius: revert の最終判断は人間）。
- 突合結果は issue コメントに記録（監査証跡）。hypothesis の `status` は
  `confirmed` / `not-confirmed` に更新（issue body 編集は dev-runner 経由）。

### Phase 2: Mine（4 miner 並列 fan-out）

`parallel()` で 4 miner agent を同時起動。

| # | miner | 入力 | 出す候補 |
|---|-------|------|----------|
| 1 | doctor-anomaly | `dev-flow-doctor --scope telemetry` の JSON（exec-proxy 取得） | anomaly 3 種（cap張り付き / iterate不調率 / micro不発火）+ recommendation の issue 化 |
| 2 | failure-RCA | telemetry 上の異常 run（iterate_status 異常、final_reconcile/final_ac_reconcile unavailable、ui_verify setup_failed 等）の個別掘り | 系統的な失敗原因の修正 |
| 3 | sunset | W7 capability-bound 機構（gate_policy advisory / ui-verify advisory / exec-proxy 橋 / sync-inlines 橋）の再評価トリガー条件チェック（calibration データ量・major モデルリリース・harness 機能解禁） | distrust 昇格・橋撤去の候補 |
| 4 | PR-signal | 直近 merged/closed PR の pr-iterate findings + merge_tier 推奨 vs 人間の実 merge 判断 | findings 再発パターンの根治、merge tier calibration の乖離是正 |

全 miner の共通出力 schema:

```json
{
  "source": "doctor-anomaly | failure-rca | sunset | pr-signal",
  "title": "...",
  "evidence": ["telemetry/PR/journal への具体的参照（空は決定論で棄却）"],
  "expected_metric_delta": {
    "metric": "iterate不調率 等（doctor が集計可能な軸）",
    "current": "実測値",
    "target": "期待値",
    "window": "突合に必要な観測窓（run 数 or 期間）"
  },
  "risk": "low | medium | high"
}
```

`evidence` 空の候補は決定論バリデーションで棄却する（既存 fail-safe 哲学と同一）。

### Phase 3: Rank

1. **dedup**: 既存 open issue（label `self-improve`）+ backlog issue の候補リストと
   決定論照合（タイトル・対象ファイルの重なり）→ 疑わしいペアのみ judge agent で同一性確認。
2. **rank**: evidence の定量性 × 期待効果 × リスク逆数で優先度スコアリング
   （judge agent 1 発 + 決定論 tie-break）。
3. **絞り**: 上位最大 2 件のみ通過（hard cap `IMPROVE_MAX=2`。強い候補が 1 件しか無ければ 1 件、0 件なら issue 化なしで終了）。
4. **落選候補**は単一の pinned **backlog issue** の body に追記
   （issue spam 回避 + 繰越と dedup 照合を 1 箇所に集約）。

### Phase 4: File

- 通過候補を `gh issue create`（dev-runner 経由）。
- issue body 構成: 背景 / evidence / acceptance criteria / **hypothesis ブロック**:

```yaml
# hypothesis (dev-improve managed)
metric: <doctor 集計軸>
current: <実測値>
target: <期待値>
window: <観測窓>
status: pending
```

- label: `self-improve`。
- workflow の返り値: `{issues_filed: [番号], reconcile: {...}, candidates_found, backpressure_skipped}`。

### Skill 側（/dev-flow-improve）

- backpressure チェック → workflow 起動 → 返却 issue に対し `Skill('dev-flow')` を 1 件ずつ serial 実行。
- 完走時に skill-retrospective 経由で improve-cycle telemetry を journal に記録。
- 完了サマリ通知（issue 化件数 / PR URL / 仮説突合結果）。

## 4. 安全弁

1. **人間 merge invariant 不変** — self-improve PR も既存 dev-flow の全 gate
   （danger-grep / merge tier / pr-iterate）をそのまま通る。
2. **throughput cap**: 最大 2 件/サイクル（`IMPROVE_MAX=2`）+ **backpressure**: open な
   self-improve PR が 2 件以上残っていたら新規 issue 化を skip（人間の merge ペースに自動同期）。
3. **自己改変の追加 floor**: dev-flow 本体（`.claude/workflows/` / `_lib/` / `.claude/agents/`）を
   触る PR は merge tier を最低 REVIEW に floor し、AC に `/dev-flow-canary` 実行を含める。
4. **dev-improve 自身の失敗は fail-open** — miner/exec-proxy 失敗時は issue 0 件で終了し
   telemetry に記録（誤発火乱発よりループ休止を選ぶ）。
5. LLM rank/judge は gate ではなく絞り込みのみ — 軸A invariant に触れない。

## 5. W7 distrust 分類（新機構の必須宣言）

| 機構 | クラス | 根拠 |
|------|--------|------|
| 自動 revert 禁止（revert は人間 merge 経由） | blast-radius（永続） | 不可逆性・accountability |
| 1〜2 件 cap + backpressure | incentive-structural（永続） | ループが自分の提案量を自己増幅させない |
| 仮説突合は決定論 script（LLM に効果判定を self-judge させない） | 軸A deterministic oracle | 改善の勝利宣言を当事者にさせない |
| sunset 昇格も issue → 人間 merge 経由 | blast-radius（永続） | gate 緩和の最終決定は人間 |

capability-bound な新規 distrust は追加しない（rank judge は gate でないため対象外）。

## 6. State（外部 state JSON なし — dev-flow 哲学と一貫）

| データ | 置き場所 |
|--------|----------|
| 候補・仮説 | GitHub issue body の構造化ブロック（label `self-improve`） |
| backlog | 単一 pinned issue（body に候補リスト） |
| 突合結果・監査証跡 | issue コメント |

## 7. Telemetry（ループ自身も観測対象 = メタ監視）

improve-cycle entry（journal 経由）:

```json
{
  "candidates_found": 0,
  "issues_filed": 0,
  "hypotheses_confirmed": 0,
  "hypotheses_not_confirmed": 0,
  "hypotheses_insufficient": 0,
  "dev_flow_runs": 0,
  "backpressure_skipped": false
}
```

doctor がループ自体の不調（毎回 0 件 / backpressure 恒常化 / 仮説 not-confirmed 率）も診断できる。

## 8. 実装規約

- 共有ロジック（hypothesis ブロックの parse / 生成、rank tie-break 等）は `_lib/` canonical →
  `tools/sync-inlines.mjs` で `dev-improve.js` へ inline 生成（既存 generator の対象に追加、
  `_lib/workflow-inlines.sync.test.mjs` で全文一致保証）。
- canonical の構造制約に従う（ESM import / Date.now / Math.random 禁止 — timestamp は args 渡し）。
- exec-proxy は既存 3 agent を再利用: read-only（issue/PR 列挙、telemetry 集計）は
  `dev-runner-haiku-ro`、書き込み（issue コメント / body 更新 / journal）は `dev-runner-haiku`、
  判断寄り（issue create）は `dev-runner`。失敗ポリシーは fail-open（§4-4）。
- 決定論 script（hypothesis-check / dedup 照合 / backpressure カウント）には bats テストを隣接配置。
- cron 登録: 週次ローカル scheduled task → `/dev-flow-improve` 起動。
- miner / judge subagent の dispatch は必須 5 要素（Objective / Output format / Tools / Boundary / Token cap）に従う。

## 9. スコープ外（YAGNI）

- 自動 revert・自動 merge
- 複数 issue の並列 dev-flow 実行（serial のみ）
- LLM 自由提案 miner（発散リスク。将来ソースとして追加余地はあるが初期実装には含めない）
- W6b calibration monitor 本体（sunset miner はトリガー条件の検知のみ。calibration 集計自体は別途）
