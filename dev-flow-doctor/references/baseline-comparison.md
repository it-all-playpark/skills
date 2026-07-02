# Baseline Comparison (AC4 / AC5)

> ⚠️ **`tests/no-glue-errors.sh` と lint.yml の `no-glue-errors` CI job は撤去済み（PR #118 / commit 62f6b58）**
> glue-error チェックは旧 child-split / dev-kickoff-worker 機構専用（patterns が v1 の worktree-agent
> 失敗文言）であり、dynamic workflow 移行で監視対象が消滅したため意図的に削除された。
> **復元しないこと** — PR #214 で一度 stale な本ドキュメントに誘導されて復元され、取り消された経緯がある。
> workflow 時代の glue 定義・CI ゲート再設計は issue #116 のスコープ。
> 比較エンジン本体（`baseline-snapshot.sh` / `compare-baseline.sh`）と `--compare` フラグは存続しており、
> 以下の記述はエンジン仕様のリファレンスとして残している（CI 連携の節は歴史的記述）。

> ⚠️ **`templates/baseline-pre-79.example.json` と `.claude/dev-flow-doctor-baseline-pre-79.json` は
> 「常時参照し続ける基準」ではない** — issue #79（worker subagent 移行）マージ前後の**一度きりの
> historical snapshot** であり、以降の全期間と比較し続ける固定リファレンスとしては設計されていない。
> dev-flow family は高頻度で構造改修されるため、固定 baseline は時間が経つほど陳腐化し、
> 実 regression とは無関係な乖離を積み上げてしまう。継続的な回帰検知には
> `compare-baseline.sh --rolling --window <N>d`（issue #88、下記「Rolling comparison」節）の
> ローリング比較モードを使うこと。
> 固定 baseline 比較（`--baseline`/`--current`）自体は撤去しない — 特定コミット前後の一回性比較
> （例: issue #79 移行時のような単発のビフォーアフター検証）には引き続き有効で、rolling モードと
> 併存する。

`dev-flow-doctor` の baseline 比較機能は、リファクタや connector 変更
（issue #79 で実装した worker subagent への移行など）が **回帰** を引き起こしていないかを
journal driven に検証する。本ドキュメントは snapshot schema・比較セマンティクス・
`tests/no-glue-errors.sh` との連携・CI 運用パターンを集約する（issue #83）。

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│ ~/.claude/journal/*.json         (skill-retrospective 出力)      │
└──────────────────┬──────────────────────────────────────────────┘
                   │
   ┌───────────────▼───────────────┐
   │ baseline-snapshot.sh          │  ⇒ snapshot.json (window 込み)
   │  - per_skill / per_phase       │
   │  - error_categories            │
   │  - glue_errors (count+samples) │
   └────────┬──────────────────────┘
            │
            │       ┌────────────────────────────┐
            ├──────►│ .claude/...baseline-pre-79 │   (gitignored)
            │       └────────────────────────────┘
            │
            │       ┌────────────────────────────────────┐
            └──────►│ templates/baseline-pre-79.example  │   (committed, CI fallback)
                    └────────────────────────────────────┘

  snapshot (current)
            │
            ▼
   ┌────────────────────────────┐
   │ compare-baseline.sh        │  ⇒ {metrics, findings} JSON
   │  - delta / delta_pct        │
   │  - direction                │
   │  - findings[critical/error] │
   └────────┬───────────────────┘
            │
            ▼
   ┌────────────────────────────┐
   │ tests/no-glue-errors.sh    │  ⇒ exit 0 / 1 (regression) / 0 (warn fallback)
   │ run-diagnostics.sh         │  ⇒ health-score penalty (max -15)
   └────────────────────────────┘
```

## CLI

### baseline-snapshot.sh

```
dev-flow-doctor/scripts/baseline-snapshot.sh [--window <dur>] [--until <iso8601>] [--config <path>]
                                              [--include-non-family] [--out <path>]
```

- 入力: `~/.claude/journal/*.json` (or `$CLAUDE_JOURNAL_DIR`)
- 出力: snapshot JSON（stdout もしくは `--out <path>` に書き出し）
- フィルタ: `.timestamp` フィールドで window を判定（mtime ではなく journal entry timestamp が
  authoritative）。BSD/GNU find 差異を回避するため `find -newermt` は使わない
- `--until <iso8601>` 指定時は window を `[until−N, until)` の半開区間として解釈する
  （省略時は従来どおり `[now−N, ∞)`）。出力 JSON に `until` フィールドが追加され、
  `--until` 未指定時は `null` になる

### compare-baseline.sh

```
dev-flow-doctor/scripts/compare-baseline.sh --baseline <path> [--current <path>]
```

- `--current` 省略時は stdin から読み込む
- 出力: 比較 JSON（top-level: `window`, `metrics[]`, `findings[]`）
- exit code:
  | code | 意味                                                          |
  |------|--------------------------------------------------------------|
  | 0    | regression なし                                              |
  | 1    | regression 検出（`findings[].severity == "critical"`）        |
  | 2    | corrupt baseline / window mismatch / IO error（`severity: error`）|

## Rolling comparison (issue #88)

固定 baseline 比較は特定コミット前後の一回性検証に向くが、継続的な回帰監視には
静的な参照点そのものが陳腐化するという弱点がある。rolling モードは journal から
毎回 2 つの window を動的に生成し、直近の傾向同士を比較することでこれを解消する。

### CLI

```
dev-flow-doctor/scripts/compare-baseline.sh --rolling --window <N>d [--config <path>]
```

- `--rolling` は `--baseline`/`--current` と併用不可（矛盾 → exit 2）
- `--window <N>d` は必須（`--rolling` 未指定時のフォーマット規約と同じ `Nd`/`Nw`/`Nm`）

### 動作

- journal から 2 つの snapshot を生成する:
  - previous window: `[now-2N, now-N)`
  - recent window: `[now-N, now)`
- 内部で `baseline-snapshot.sh --window <N>d --until <iso>` を 2 回呼び出す（recent は
  `--until <now>`、previous は `--until <now-N>`）
- 一時ファイルは `mktemp -d` で作成し、比較完了後に残置しない

### 回帰判定

- 対象 metric は 2 つ: `error_count`（per_skill の `failure + partial` の合計）と
  `glue_errors.count`
- `ratio = recent / max(previous, 1)`（add-one 平滑化。0 除算と「0→1 件でノイズ alert」の
  両方を防ぐ）
- `ratio > ratio_threshold`（既定 `1.5`）→ `severity: "critical"` の finding → exit 1

### insufficient data ガード

- previous / recent いずれかの window の `total_entries < min_entries_per_window`
  （既定 `5`）の場合、回帰 finding を一切出さず `insufficient_data: true` を立てて
  exit 0 で終了する（小 N ノイズによる CI alert fatigue を防ぐための advisory 経路）

### config キー

- `dev-flow-doctor.baseline.rolling.ratio_threshold`（既定 `1.5`）
- `dev-flow-doctor.baseline.rolling.min_entries_per_window`（既定 `5`）

### 出力 JSON（additive、既存 compare schema `dev-flow-doctor-compare/v1` を拡張）

固定モードの `mode` は `"fixed"`、rolling モードは `"mode": "rolling"` になる。rolling
モードでは以下が追加される:

- `windows.previous` / `windows.recent`: それぞれ `{since, until, total_entries}`
- `insufficient_data`: boolean
- `metrics[].ratio`: 各 metric の ratio 値（固定モードには存在しない）

### exit codes

| code | 意味                                                                 |
|------|----------------------------------------------------------------------|
| 0    | regression なし、または insufficient data（advisory）                |
| 1    | ratio regression 検出（`findings[].severity == "critical"`）         |
| 2    | 引数矛盾（`--rolling` と `--baseline`/`--current` の同時指定等）・snapshot 生成失敗 |

### run-diagnostics.sh integration

```
dev-flow-doctor/scripts/run-diagnostics.sh --compare <baseline-path>
dev-flow-doctor/scripts/run-diagnostics.sh --update-baseline <path>
```

- `--compare <path>`: 既存 7 scopes に加えて `checks.baseline_compare` セクションを追加。
  health score への penalty (最大 -15) を加算
- `--update-baseline <path>`: `baseline-snapshot.sh --window <baseline.window or 30d> > <path>` を内部実行する delegator。
  `total_entries == 0` のときは stderr に warning を出すが exit 0 で続行

## snapshot JSON schema (v1)

| Field | Type | 必須 | 説明 |
|-------|------|------|------|
| `version` | string | yes | `"1.0.0"` |
| `schema` | string | yes | `"dev-flow-doctor-baseline/v1"` |
| `window` | string | yes | `"30d"`, `"7d"`, etc. compare-baseline.sh が一致性を検証 |
| `since` | string | yes | ISO8601 UTC（window 起点） |
| `until` | string\|null | optional | ISO8601 UTC。`--until` 指定時のみ非 null（window 上限、半開区間 `[since, until)`） |
| `taken_at` | string | yes | ISO8601 UTC（snapshot 生成時刻） |
| `total_entries` | number | yes | window 内 family skill journal entry の総数 |
| `family_skills` | array<string> | yes | skill-config の `dev-flow-doctor.family_skills`（default 8 種） |
| `per_skill` | array<object> | yes | 各 family skill の集計（total/success/failure/partial/failure_rate/avg_duration_turns/duration_samples） |
| `per_phase` | object | yes | `{<phase>: {total, failure}}` の map（failure.error.phase 由来） |
| `error_categories` | object | yes | `{<category>: <count>}` の map（error.category 由来） |
| `glue_errors` | object | yes | `{count, samples, patterns}` — `count` は patterns に match した行数の合計 |

## compare JSON schema (v1)

| Field | Type | 必須 | 説明 |
|-------|------|------|------|
| `version` | string | yes | `"1.0.0"` |
| `schema` | string | yes | `"dev-flow-doctor-compare/v1"` |
| `window` | string | yes | baseline.window をそのまま伝搬 |
| `metrics` | array<object> | yes | 各 metric の `{metric, baseline, current, delta, delta_pct, direction}` |
| `findings` | array<object> | yes | regression / error の `{metric, severity, delta, threshold, reason}` |

### findings semantics

- `severity: "critical"` → regression 検出（exit 1）。`tests/no-glue-errors.sh` は exit 1 を伝播
- `severity: "error"` → window mismatch / corrupt baseline（exit 2）。`tests/no-glue-errors.sh` は warning + exit 0

## tests/no-glue-errors.sh 連携

```bash
BASELINE_FILE=<path> tests/no-glue-errors.sh
```

挙動:

1. `BASELINE_FILE`（既定 `.claude/dev-flow-doctor-baseline-pre-79.json`）が存在しない →
   `dev-flow-doctor/templates/baseline-pre-79.example.json` を fallback。それも無ければ warning + exit 0
2. baseline.window を抽出して `baseline-snapshot.sh --window <baseline.window>` を実行（hardcoded 7d は廃止）
3. `compare-baseline.sh` を呼び、exit code に応じて:
   - 0 → "OK: no glue-error regression detected" + exit 0
   - 1 → "FAIL: glue-error regression detected (baseline=X, current=Y)" + findings 列挙 + exit 1
   - 2 → warning（corrupt / window mismatch）+ exit 0（graceful degradation）

## CI 運用パターン (AC5)

`.github/workflows/lint.yml` の `no-glue-errors` job が PR / push 毎に実行する。

```yaml
jobs:
  no-glue-errors:
    runs-on: ubuntu-latest
    env:
      BASELINE_FILE: dev-flow-doctor/templates/baseline-pre-79.example.json
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get install -y jq
      - run: ./tests/no-glue-errors.sh
```

### 注意点（vacuous CI pass）

- CI runner は通常 `~/.claude/journal/` を持たないため `total_entries: 0` の snapshot になる
- baseline (template) の `glue_errors.count: 0` と current の `0` を比較 → 常に "no regression" で pass
- これは **structural pipeline check**（snapshot → compare の連鎖が壊れていないことを確認）
- 実 regression 検知はローカル開発で `.claude/dev-flow-doctor-baseline-pre-79.json` を populate した状態で行う
- baseline 再生成: `./dev-flow-doctor/scripts/run-diagnostics.sh --update-baseline .claude/dev-flow-doctor-baseline-pre-79.json --window 30d`

### weekly snapshot artifact パターン

回帰検知精度を高めたい場合、CI で weekly snapshot を artifact 化する派生パターンも採れる:

```yaml
- name: Generate weekly snapshot
  run: ./dev-flow-doctor/scripts/baseline-snapshot.sh --window 30d --out snapshot.json
- name: Upload artifact
  uses: actions/upload-artifact@v4
  with:
    name: dev-flow-doctor-baseline-${{ github.run_id }}
    path: snapshot.json
```

後続 PR 上で 前 artifact を `--baseline <downloaded>` として比較すれば、CI 側で実 regression を観測できる。

## health score への影響

`run-diagnostics.sh --compare <baseline>` を指定すると `checks.baseline_compare` セクションが追加され、
health score に最大 **-15** の penalty を加算する:

- `findings[].severity == "critical"` 1件あたり `-5`
- max `-15` でクランプ

詳細は [`health-scoring.md`](./health-scoring.md) の "Baseline regression penalty" セクション参照。

## 再生成手順 (baseline drift mitigation)

長期間運用で baseline が古くなった場合の更新手順:

1. 直近 30 日の安定状態を確認（PR や incident が落ち着いた時期）
2. `./dev-flow-doctor/scripts/run-diagnostics.sh --update-baseline .claude/dev-flow-doctor-baseline-pre-79.json --window 30d`
3. 出力された JSON を目視確認（`glue_errors.count` / `per_skill[*].failure_rate`）
4. 大きく変動している場合は backup を残してから上書き
5. `templates/baseline-pre-79.example.json` は schema 進化時にのみ更新

## 関連

- 親 issue: #79 (worker subagent 移行)
- 本 issue: #83 (baseline metrics + glue-error scanning)
- [`health-scoring.md`](./health-scoring.md) — penalty rule
- [`diagnostic-checks.md`](./diagnostic-checks.md) — 既存 8 checks
- [`responsibility-split.md`](./responsibility-split.md) — connector vs doctor の責務境界
