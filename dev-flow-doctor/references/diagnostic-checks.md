# Diagnostic Checks

## Check 2: Failure & Partial Distribution

Analyze journal entries for both `failure` AND `partial` outcomes:

```bash
# Include both failure and partial outcomes
$SKILLS_DIR/skill-retrospective/scripts/journal.sh query --skill dev-flow --limit 200 | \
  jq '[.[] | select(.outcome == "failure" or .outcome == "partial")] |
    group_by(.error.phase // "unknown") |
    map({phase: .[0].error.phase // "unknown", count: length, outcomes: (group_by(.outcome) | map({outcome: .[0].outcome, count: length}))}) |
    sort_by(-.count)'
```

`error.phase` は dev-flow workflow の phase 名（`Setup` / `Analyze` / `Plan` / `Implement` /
`Validate` / `Security floor` / `Evaluate` / `PR` / `Merge tier`）を取る。

| Pattern | Recommendation |
|---------|----------------|
| `Implement` phase > 30% | Plan の粒度・自明性判定を見直す（plan-reviewer loop の収束状況を確認） |
| `Validate` phase > 40% | test green 化のリトライ設計を見直す、静的解析を implement 前段に前倒し |
| `Setup` phase > 10% | worktree isolation / env bootstrap（`_shared/scripts/ensure-worktree-deps.sh`）を確認 |
| `Analyze` / `Plan` phase issues | shape classification（`classifyShape`）と要件抽出の精度を確認 |

## Check 3: Error Category Distribution

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh stats | jq '.by_category'
```

| Category Dominance | Recommendation |
|--------------------|----------------|
| `env` > 30% | Wire `_shared/scripts/ensure-worktree-deps.sh` into dev-flow.js Setup phase |
| `lint` > 40% | Add auto-fix to the Validate phase, configure stricter editor settings |
| `test` > 40% | Review test quality, consider TDD strategy |
| `type-check` > 20% | Enable strict TypeScript mode, add pre-commit type checks |
| `runtime` > 20% | Investigate skill flow control issues (phase transitions) |

## Check 4: Worktree Health

Check worktrees across all known repository locations, including sibling `-worktrees/` directories:

```bash
# List worktrees registered in git
git worktree list --porcelain

# Check for orphaned worktree directories (siblings of repo)
REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")
WORKTREE_BASE="${REPO_ROOT}/../${REPO_NAME}-worktrees"
if [[ -d "$WORKTREE_BASE" ]]; then
  echo "=== Worktree directory: $WORKTREE_BASE ==="
  ls -lt "$WORKTREE_BASE" 2>/dev/null
  # Check each for staleness (>7 days old)
  find "$WORKTREE_BASE" -maxdepth 1 -type d -mtime +7 2>/dev/null
  # Check each for kickoff.json
  for wt in "$WORKTREE_BASE"/*/; do
    [[ -f "$wt/.claude/kickoff.json" ]] && echo "HAS_STATE: $wt" || echo "NO_STATE: $wt"
  done
fi
```

| Finding | Recommendation |
|---------|----------------|
| Stale worktrees (>7 days) | Clean up: `_shared/scripts/worktree-teardown.sh <path>`（veridelta 証跡を退避してから削除） |
| Directories without kickoff.json | Orphaned worktrees, safe to remove |
| Worktrees with failed state | Investigate or remove |
| Directories not registered as git worktrees | Leftover from failed cleanup, safe to remove |

## Check 5: Average Recovery Turns

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh stats | jq '.avg_recovery_turns'
```

| Value | Health | Recommendation |
|-------|--------|----------------|
| < 2.0 | Good | No action needed |
| 2.0 - 5.0 | Fair | Review common failure patterns |
| > 5.0 | Poor | Run /skill-retrospective for improvement proposals |

## Check 6: Success Rate Trend

Compare recent success rate (last 7 days) vs overall:

```bash
# Recent
$SKILLS_DIR/skill-retrospective/scripts/journal.sh stats --since 7d
# Overall
$SKILLS_DIR/skill-retrospective/scripts/journal.sh stats
```

| Trend | Meaning |
|-------|---------|
| Improving | Skills are getting better (retrospective working) |
| Stable | Consistent performance |
| Declining | New failure patterns emerging, investigate |

## Check 7: Duration Outliers

Identify executions with unusually high turn counts:

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh query --skill dev-flow --limit 200 | \
  jq '(map(.duration_turns) | add / length) as $avg |
    { average_turns: $avg,
      outliers: [.[] | select(.duration_turns > ($avg * 3))] |
        map({issue: .context.issue, turns: .duration_turns, shape: (.telemetry.shape // "unknown"), args: .args})
    }'
```

| Finding | Recommendation |
|---------|----------------|
| Outliers correlate with `complex` shape runs | Expected — complex issue の plan-review / evaluate ループが turn 数を押し上げる |
| Outliers in `micro` / `standard` shape runs | Investigate: likely validation failures or unexpectedly complex implementations |
| Average > 8 turns | Overall pipeline may need optimization |
| Average < 5 turns | Pipeline is efficient |

## Check 8: Dev-Flow Telemetry Distribution & Anomaly Detection (Journal-Driven)

dev-flow / pr-iterate が journal に書き出す telemetry（`shape` / `merge_tier` /
`eval_iter` / `plan_iter` / `gate_policy` / `iterate_status`）を集計し、分布と
4 種の anomaly を検出する。旧 v1 の family skill 集計（8 skill 固定リスト前提の
dead phase / stuck skill / bottleneck / disconnected skill）は廃止され、
workflow 化された dev-flow が実際に記録する telemetry 値のみを対象にする。

```bash
# Full (既定 window 30d, skill-config.json で上書き可能)
$SKILLS_DIR/dev-flow-doctor/scripts/analyze-dev-flow-telemetry.sh --window 30d

# run-diagnostics 経由
$SKILLS_DIR/dev-flow-doctor/scripts/run-diagnostics.sh --scope telemetry --window 7d
```

### 分布集計

| 分布 | 分母 | 説明 |
|------|------|------|
| `shape` | `skill == "dev-flow"` の entry | micro / standard / complex / unknown |
| `merge_tier` | `skill == "dev-flow"` の entry | AUTO / REVIEW / HOLD / unknown（pr-iterate standalone entry は `merge_tier == "PR_ITERATE"` かつ `skill == "pr-iterate"` のため自然に対象外） |
| `eval_iter` / `plan_iter` | `skill == "dev-flow"` の entry | max 値・cap（`eval_iter_cap` / `plan_iter_cap`）・cap 到達件数 |
| `gate_policy` | `skill == "dev-flow"` の entry | deterministic-only / llm-major-advisory / llm-major-blocking / llm-autonomous / unknown |
| `iterate_status` | `.telemetry.iterate_status != null` の全 entry を正規化した normalized run（nested 実行の dev-flow×pr-iterate 親子ペアを 1 run に統合。raw_entries / unjoinable / status_conflicts を併記） | lgtm / stuck / fix_failed / max_reached / ci_error / ci_pending / review_contract_error / unknown |
| `vdelta_verdict` | dev-flow telemetry の per-AC 配列 `vdelta_verdicts[].verdict`（veridelta フックの生 JSON: `{comparability, transitions, verification_surface}`） | `_lib/vdelta-transitions.mjs` の `vdeltaDenies()` と同一ロジックで clean / deny / abstain / fail_open に分類（`improved`/`unchanged`/`regressed`/`inconclusive` という schema は実 producer に存在しない）。0 件でも全キー 0 で安全に出力。集計は `skill == "dev-flow"` の構造化キーのみを対象とし、他 skill（調査系 journal 等）の文字列部分一致で誤カウントしない |

欠落フィールドは `unknown` バケットへ計上する（fail-safe。die しない）。

### Nested run normalization（iterate_status のみ）

dev-flow は pr-iterate を nested workflow 呼び出し（`workflow('pr-iterate')`）することがあり、
その場合 dev-flow entry（親）と pr-iterate entry（子）が同一 run の `iterate_status` を
二重に記録してしまう。この正規化 stage は以下のルールで de-dupe する: `.context.repo` と
`.context.pr_number` を両方持ち `.timestamp` が ISO 8601 として parse 可能な entry のみを
joinable とし `repo#pr_number` で group 化する。group 内では `skill=="dev-flow"` ×
`skill=="pr-iterate"` の異種ペアのみを、timestamp 差が `nested_join_window_seconds`
（既定 600 秒、`dev-flow-doctor.thresholds.nested_join_window_seconds` で上書き可）以内の
最近接 greedy matching（各 entry の消費は最大 1 回）で 1 run に統合する。同種同士
（pr-iterate 同士等）は絶対に join しないため、同一 PR への standalone pr-iterate
複数回再実行は別 run のまま残る。joined run の status は pr-iterate（child）側の値を
採用し、親子で値が異なる場合は `normalization.status_conflicts` を +1 する。
`context.repo` / `context.pr_number` 欠落や timestamp parse 不能の entry は暗黙 dedupe
せず `normalization.unjoinable` として明示集計し、各 1 run のまま残る。
出力: `distributions.iterate_status.total`（normalized run 数）+ `raw_entries`
（正規化前 entry 数）+ `normalization: {joined_pairs, unjoinable, status_conflicts,
join_window_seconds}`。既知の限界: handoff flush が遅延して window を超えた nested
ペアは join されず 2 run のまま残る（over-count 温存。`raw_entries` と
`normalization.joined_pairs` の乖離で観測可能）。

### 検出カテゴリ（anomaly 4 種）

| anomaly | severity | 条件 | 推奨アクション |
|---------|----------|------|---------------|
| **cap_pinned** | `warn` | dev-flow entry の `eval_iter >= eval_iter_cap`（既定 10）または `plan_iter >= plan_iter_cap`（既定 8）が 1 件以上 | 収束しない run が cap で打ち切られている。該当 issue の plan/evaluate の差し戻し内容（frozen target・topic-stuck 判定）を確認 |
| **iterate_unhealthy** | `warn` | 非 lgtm（stuck / fix_failed / max_reached / ci_error / review_contract_error）の割合が `iterate_unhealthy_rate`（既定 0.30）を超え（分母は normalized run（nested 親子統合後）から ci_pending を除外した effective_total）、かつ effective_total が `iterate_min_runs`（既定 3）以上。detail に正規化前の `raw_entries` も併記される | pr-iterate の review ⇄ fix ループが健全に収束していない。pr-reviewer の finding 傾向・critical/major-always-blocks の影響、review decision と blocking findings の矛盾再発によるエスカレーション、または CI 未設定/pending が多い場合は CI 整備状況を確認 |
| **micro_nonfiring** | `warn`（`skipped` は insufficient_data） | dev-flow の総 run 数が `micro_min_runs`（既定 10）以上あるにもかかわらず `shape: micro` の run が 0 件。run 数が `micro_min_runs` 未満のときは `severity: "skipped"`, `reason: "insufficient_data"` を明示出力し判定しない | classifyShape の micro floor 判定が過剰に安全側へ寄っていないか確認（`estimated_change_file_count` / `acceptance_criteria` 欠落・breaking 検出の誤爆有無） |
| **vdelta_unhealthy** | `warn`（`skipped` は insufficient_data） | dev-flow の vdelta_verdicts 全要素における abstain+fail_open（比較不能・シグナルなし）の割合が `vdelta_unhealthy_rate`（既定 0.50、**placeholder — 実データ蓄積後にキャリブレーション予定**）を超え、かつ総 verdict 数が `vdelta_min_runs`（既定 5、placeholder）以上。総数が min 未満のときは `severity:"skipped", reason:"insufficient_data"` を明示出力し判定しない | veridelta 検証が abstain（comparability 不一致）・fail_open（未取得/不正 JSON）に偏っている。redgreen verdict フック（.claude/redgreen.conf）の設定状況・veridelta 実行環境を確認。report-only（blocking gate 化しない — INV-10 advisory） |

### window オプション

- `--window 7d`: 直近の異常を捕まえたいとき
- `--window 30d`（既定）: 傾向把握
- `--window 14d` / `--window 2w`: 週次レビュー用
- 任意の `Nd` / `Nw` / `Nm` フォーマットを受け付ける（`parse_since` と同じ）

### 閾値の設定

すべての閾値は `skill-config.json` の `dev-flow-doctor.thresholds` から読み込む
（`eval_iter_cap` / `plan_iter_cap` / `iterate_unhealthy_rate` / `iterate_min_runs` /
`micro_min_runs` / `nested_join_window_seconds`、既定 600 / `vdelta_unhealthy_rate`、
既定 0.50、placeholder / `vdelta_min_runs`、既定 5、placeholder）。`vdelta_unhealthy_rate`
と `vdelta_min_runs` は実データ未蓄積の暫定値であり、実データ蓄積後にキャリブレーション
予定（report-only・非 blocking）。`--config <path>` で config ファイルを明示指定できる。

### 責務分離

Check 8 は **dev-flow pipeline の telemetry 健全性** に特化している。全 skill を対象にした
汎用的な failure pattern detection や proposal 生成は `skill-retrospective` 側で
行うこと。詳しくは [responsibility-split.md](responsibility-split.md) を参照。

## Canary intake (issue #325)

`/dev-flow-canary` は harness capability を read-only に検証する専用 workflow
（`schema付きagent` / `parallel or pipeline` / `nested workflow 1段` /
`model/effort routing` / `pause/resume` / `direct fs/shell/import`）で、
production の `dev-flow` / `pr-iterate` とは独立に動作する。実行結果は
repository 外の `~/.claude/logs/dev-flow-canary/` 配下に構造化 JSON
（canary report）として書き出される（**repository・git state・GitHub state を
一切変更しない**）。

dev-flow-doctor はこの canary report を `run-diagnostics.sh --canary <path>`
で取り込む。取り込みは決定論スクリプト `validate-canary-report.sh` による
schema 検証のみを行い、LLM 判断は介在しない。

```bash
# canary を実行した後、生成された report を doctor に取り込む
$SKILLS_DIR/dev-flow-doctor/scripts/run-diagnostics.sh --canary ~/.claude/logs/dev-flow-canary/<timestamp>.json
```

`--canary` を省略した場合でも、環境変数 `DEVFLOW_CANARY_LOG_DIR`（既定
`$HOME/.claude/logs/dev-flow-canary`）配下の `canary-*.json` をファイル名 sort
で最新 1 件自動発見して取り込む。`--canary` を明示指定した場合は常に自動発見
より優先される。対象ディレクトリが存在しない、または report が 0 件の場合は
従来どおり no-op（`checks.canary` キー無し・exit 0・score 不変）。

### 出力: `checks.canary`

| status | 意味 |
|--------|------|
| `ok` | schema 検証 pass。`claude_code_version` / `counts`（pass/fail/unsupported）/ `failed_ids` / `unsupported_ids` / `bridge_sunset` を含む |
| `unavailable` | report 不在・非 JSON・schema violation・`validate-canary-report.sh` 不在 のいずれか。`reason` に理由を記載 |

capability ごとの `pass` / `fail` / `unsupported` の意味:

- `pass`: harness capability が期待通り動作した
- `fail`: capability API は存在するが実行が失敗した（harness regression の可能性）
- `unsupported`: capability API 自体が存在しない（harness が対応していない）

### `checks.canary.version_drift`（harness 更新検知）

`checks.canary.status == ok` のときのみ、現在の harness version（`claude
--version` の verbatim stdout）と report の `claude_code_version` を単純文字列
比較し、`checks.canary.version_drift` を出力する。

| status | 意味 |
|--------|------|
| `drift` | 現在の harness version と report の `claude_code_version` が不一致。`issues[]` に `severity: "warn"` で「/dev-flow-canary の再実行を推奨」の advisory issue を追加する |
| `match` | 一致。追加 issue なし |
| `skipped` | `claude` コマンド不在・実行失敗・空出力、または report 側 `claude_code_version` が `unknown` の場合。harness version が取得できないことを drift の証拠として扱わない fail-open |

なぜ: harness 更新時の再評価トリガ（下記）は canary 再実行を人間の記憶に依存
しており、drift 検知が無いと bridge sunset 再評価が黙って止まる（issue #511
の動機）。

### score への非影響（advisory）

canary check は **health score の計算に一切影響しない**。`ci-checks` proxy
（`gh pr checks` 経由の advisory check）と同じ fail-open advisory 設計であり、
canary の fail/unsupported/report 取り込み失敗のいずれも score・merge tier
判定を変えない。`fail > 0` または `unsupported_ids` に `direct_fs` /
`direct_shell` / `direct_import` のいずれかが含まれる場合は、
`issues[]` に `severity: "info"` で
「canary: bridge (exec-proxy/inline generator) removal NOT possible —
direct fs/shell/import unsupported」を追加するのみで、gate は緩めない。
`version_drift` も同様に score に一切影響しない（advisory issue の追加のみ）。

### harness 更新時の再評価トリガ

Claude Code（harness）が更新されたら `/dev-flow-canary` を再実行し、
`AGENTS.md` の inline 生成区間 bridge（`tools/sync-inlines.mjs`）と
exec-proxy bridge（`dev-runner`/`dev-runner-haiku`/`dev-runner-haiku-ro`）の
sunset path 再評価の判断材料にする。**bridge の撤去そのものは canary では
行わない** — canary は capability の pass/fail/unsupported を報告するのみで、
撤去の実施判断は別 issue を立てて human review を経て行う。

## Trust receipts consumption (issue #413, epic #390 Phase 5)

`scripts/trust-receipts-report.sh` は real trust receipt（SurfaceProof/EvalSeal/
EffectDelta）を dev-flow journal telemetry から run_id 単位で消費し、AC-13
（missing receipt率・inconclusive率・effect mismatch率・false completion検出・
追加 latency/cost 分布の集計、0 件時も安全報告）を満たす。

### 母集団・分母規約

- 母集団は `.skill == "dev-flow" AND (.source // "skill") == "skill"` の journal
  entry（window 内）。`trust-baseline-snapshot.sh` と同一規約。
- `trust_active_runs`（missing_receipt の分母）= `.telemetry.{trust_surfaceproof_shadow,
  trust_receipts, trust_run_id}` のいずれか 1 つ以上を持つ run。**presence-only
  denominator** — trust キーを一切持たない legacy run は missing に数えず分母
  からも除外する。
- `invalidated: true` の receipt は verdict/reason_code 集計から除外し
  `invalidated_count` に別掲する（pr-iterate fix 後の stale SHA 失効等）。
- 同一 run 内で同一 layer×stage の receipt が複数存在する場合、非 invalidated
  の配列末尾優先で採用する（effective verdict 規則: `invalidated: true` の
  receipt は除外し、残った同一 layer×stage の中で配列末尾を優先する）。

### 集計 block

| block | 内容 |
|-------|------|
| `layer_status` | layer 別 verdict × reason_code 分布（+ evalseal/effectdelta の stage 別内訳 + `invalidated_count`） |
| `missing_receipt` | layer 別の missing count/rate（分母は `trust_active_runs`）+ `overall_receipt_success_rate`（3 layer 全て receipt ありの割合） |
| `inconclusive` | 採用済み receipt のうち verdict `"inconclusive"` の rate |
| `effect_mismatch` | EffectDelta receipt が verdict `"fail"` または `domain_reason_code` が `DUPLICATE_EFFECT`/`WRONG_TARGET`/`RESPONSE_LOST`/`PROBE_FAILED`/`TARGET_MISSING` のいずれかの rate（domain_reason_code 別分布を含む） |
| `false_completion` | `eval_verdict == "pass"` かつ非 invalidated receipt が verdict `"fail"` を報告している run の rate |
| `latency` | `trust_active` vs `trust_inactive` の `duration_seconds`/`phase_durations` の count/p50/p95 + `trust_added_p95_seconds`（active p95 − inactive p95） |
| `cost_proxy` | run あたり trust receipt 件数の count/p50/p95（直接 cost telemetry が無いための proxy） |

0 件（journal 空・window 内 run 0 件・trust キー保有 run 0 件）でも script は
exit 0 で完走し、各 rate は `null` を返す（AC-13 の 0 件安全報告）。

### latency 計測不能時の扱い

`trust_inactive` 母集団が 0 件など added p95 が算出できない場合は
`trust_added_p95_seconds` を `null` とする。計測不能を SLO 達成と同一視しない
（後述の `LATENCY_UNMEASURABLE` reason を参照）。

### `--slo` — Go/No-Go 判定

`--slo` を付けると初期 SLO 仮説との照合結果を `slo` object として追加する。

- 閾値: `receipt_success_min: 0.99` / `inconclusive_max: 0.01` /
  `added_p95_max_seconds: 180` / `min_runs: 20`
- `go_no_go`: `"go"` | `"no-go"`（`reasons` が空のときのみ `"go"`）
- `reasons`（closed enum、複数可）:
  - `INSUFFICIENT_RUNS` — eligible run 数が `min_runs`（20）未満
  - `RECEIPT_SUCCESS_BELOW_SLO` — `overall_receipt_success_rate < 0.99`
  - `INCONCLUSIVE_ABOVE_SLO` — inconclusive rate `> 0.01`
  - `LATENCY_P95_ABOVE_SLO` — `trust_added_p95_seconds > 180`
  - `LATENCY_UNMEASURABLE` — `trust_added_p95_seconds == null`（計測不能を
    達成扱いにしない。`LATENCY_P95_ABOVE_SLO` とは排他）

計測不能（`eligible_runs < 20` または added p95 算出不能）は必ず `no-go` に
倒す（決定論 oracle。`hypothesis-check.sh` と同型 — LLM に効果の self-judge
をさせない）。

### `--matrix <dir>` — 2×2×2 dogfood 比較

`--matrix <dir>` は journal window を無視し、`<dir>` 配下の journal-shaped
fixture を 1 entry 1 file で読み込み、`trust-receipts-matrix/v1` schema で
出力する。

- 3 軸: `surfaceproof` × `evalseal` × `effectdelta`（各 `off`/`shadow` の 2 値、
  fixture の `.context.layer_modes.{surfaceproof,evalseal,effectdelta}` 明示値で判定）
- 4 fixture 軸: `long-issue` / `coding` / `pr-side-effect` / `e2e`
  （`.context.fixture_axis` 明示値で判定）
- 4 fixture 軸 × 2^3 layer-mode combo = 32 cell（全 cell 網羅を検証）
- `fixture_axis` / `layer_modes` が out-of-enum の場合は `die_json` で exit 1
  （legacy fallback・黙殺なし）

### Planted failure corpus（AC-14）

7 分類の planted failure corpus — omission（receipt 欠落）/ tamper（改ざん）/
stale SHA（EvalSeal receipt 失効）/ response loss（EffectDelta observation
喪失）/ duplicate（EffectDelta 重複検出）/ partial effect（部分適用検出）/
observer timeout（observer 側タイムアウト）— を CI bats（
`trust-receipts-planted.bats`）で固定し、planted failure recall 100%
（全 7 分類が該当する anomaly block・reason_code で確実に検出される）を
維持する。recall 100% は決定論 fixture ベースの回帰であり、モデル判断に
依らない。

### rollback

本セクションが対象とする変更は dev-flow-doctor（消費側）の
`trust-receipts-report.sh` および本ドキュメントのみ。producer 側の
trust-layer call site（EvalSeal・EffectDelta shadow 実行、`TRUST_LAYER_CONFIG`
を含む）は撤去済みで、本レポートは過去 run の journal telemetry を読むのみ
（新規 trust receipt は生成されない）。rollback する場合は doctor 消費コード
（`trust-receipts-report.sh` とこのドキュメントセクション）を revert すれば
足り、過去 telemetry の読み取り以外への影響はない。
