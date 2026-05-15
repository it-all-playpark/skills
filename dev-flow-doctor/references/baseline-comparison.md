# Baseline Comparison (AC4 / AC5)

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
dev-flow-doctor/scripts/baseline-snapshot.sh [--window <dur>] [--config <path>]
                                              [--include-non-family] [--out <path>]
```

- 入力: `~/.claude/journal/*.json` (or `$CLAUDE_JOURNAL_DIR`)
- 出力: snapshot JSON（stdout もしくは `--out <path>` に書き出し）
- フィルタ: `.timestamp` フィールドで window を判定（mtime ではなく journal entry timestamp が
  authoritative）。BSD/GNU find 差異を回避するため `find -newermt` は使わない

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
