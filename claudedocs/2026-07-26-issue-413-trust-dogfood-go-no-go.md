# issue #413 — trust-layer 2×2×2 dogfood 比較 + shadow→advisory→blocking Go/No-Go 判定

epic #390 Phase 5（trust-layer dogfooding）。SurfaceProof（issue #410）/ EvalSeal（issue #411/#390
Phase 3）/ EffectDelta（issue #412、epic #390 Phase 4）の各 layer を軸に、fixture ベースの 2×2×2
比較と real journal shadow 観測を実施し、shadow→advisory→blocking 昇格の Go/No-Go を記録する。

**スコープ境界（重要）**: 本 issue は **消費・観測のみ**。`_lib/trust-wiring.mjs` の
`TRUST_LAYER_CONFIG`（全 layer `'shadow'`）・security floor・Final reconcile・gate_policy・人間 merge
は一切変更しない。blocking への実昇格は SLO 達成確認後の別 PR で行う（詳細 §(f)）。

## (a) 再実行手順

### 1. fixture 2×2×2 比較（--matrix, journal window 非依存）

```bash
bash dev-flow-doctor/scripts/trust-receipts-report.sh \
  --matrix dev-flow-doctor/tests/fixtures/trust-receipts/matrix
```

fixture corpus: `dev-flow-doctor/tests/fixtures/trust-receipts/matrix/<axis>-s{on|off}-e{on|off}-d{on|off}.json`
（4 fixture axis × surfaceproof/evalseal/effectdelta 各 off|shadow の 2^3 = 8 cell、計 32 件）。
決定論検証は `bats dev-flow-doctor/scripts/trust-receipts-matrix.bats` を参照。

### 2. real journal shadow 観測（--slo, 30d window, --until アンカー固定）

```bash
bash dev-flow-doctor/scripts/trust-receipts-report.sh \
  --slo --window 30d --until 2026-07-26T00:00:00Z \
  --out .devflow-tmp/trust-slo-observation.json
```

`CLAUDE_JOURNAL_DIR` は未設定（実 journal `~/.claude/journal` を読む）。`--until` を固定アンカーに
すると再実行が「今日」に依存せず同一 window（`since=2026-06-26T00:00:00Z`〜`until` 排他）を再現できる。
`--until` を省略すると window は実行時点の「今」基準に変わる点に注意。出力は一時ファイルであり本 PR には
含めない（`.devflow-tmp/` 配下のみ、コミット対象外）。

## (b) fixture 2×2×2 比較結果（--matrix 実出力の要約）

`--matrix` 実行結果は `trust-receipts-matrix/v1` schema、`cells` 配列 32 件全てが埋まる
（各 cell `run_count=1`）。要約表（`false_completion` / `inconclusive` / `effect_mismatch` は
全て count、`duration_p50` は秒）:

| axis | surfaceproof | evalseal | effectdelta | run_count | false_completion | inconclusive | effect_mismatch | duration_p50 |
|---|---|---|---|---|---|---|---|---|
| long-issue | off | off | off | 1 | 0 | 0 | 0 | 100 |
| long-issue | off | off | shadow | 1 | 0 | 0 | 0 | 130 |
| long-issue | off | shadow | off | 1 | 0 | 0 | 0 | 130 |
| long-issue | off | shadow | shadow | 1 | 0 | 0 | 0 | 160 |
| long-issue | shadow | off | off | 1 | 0 | 0 | 0 | 130 |
| long-issue | shadow | off | shadow | 1 | 0 | 0 | 0 | 160 |
| long-issue | shadow | shadow | off | 1 | 0 | 0 | 0 | 160 |
| long-issue | shadow | shadow | shadow | 1 | 0 | 0 | 0 | 190 |
| coding | off | off | off | 1 | 0 | 0 | 0 | 100 |
| coding | off | off | shadow | 1 | 0 | 0 | 0 | 130 |
| coding | off | shadow | off | 1 | 0 | 0 | 0 | 130 |
| coding | off | shadow | shadow | 1 | 0 | 0 | 0 | 160 |
| coding | shadow | off | off | 1 | 0 | 0 | 0 | 130 |
| coding | shadow | off | shadow | 1 | 0 | 0 | 0 | 160 |
| coding | shadow | shadow | off | 1 | 0 | 0 | 0 | 160 |
| coding | shadow | shadow | shadow | 1 | 0 | 0 | 0 | 190 |
| pr-side-effect | off | off | off | 1 | 0 | 0 | 0 | 100 |
| pr-side-effect | off | off | shadow | 1 | 0 | 0 | 0 | 130 |
| pr-side-effect | off | shadow | off | 1 | 0 | 0 | 0 | 130 |
| pr-side-effect | off | shadow | shadow | 1 | 0 | 0 | 0 | 160 |
| pr-side-effect | shadow | off | off | 1 | 0 | 0 | 0 | 130 |
| pr-side-effect | shadow | off | shadow | 1 | 0 | 0 | 0 | 160 |
| pr-side-effect | shadow | shadow | off | 1 | 0 | 0 | 0 | 160 |
| pr-side-effect | shadow | shadow | shadow | 1 | 0 | 0 | 0 | 190 |
| e2e | off | off | off | 1 | 0 | 0 | 0 | 100 |
| e2e | off | off | shadow | 1 | 0 | 0 | 0 | 130 |
| e2e | off | shadow | off | 1 | 0 | 0 | 0 | 130 |
| e2e | off | shadow | shadow | 1 | 0 | 0 | 0 | 160 |
| e2e | shadow | off | off | 1 | 0 | 0 | 0 | 130 |
| e2e | shadow | off | shadow | 1 | 0 | 0 | 0 | 160 |
| e2e | shadow | shadow | off | 1 | 0 | 0 | 0 | 160 |
| **e2e** | **shadow** | **shadow** | **shadow** | 1 | **1** | 0 | 0 | 190 |

**観測ポイント**:

- **false completion 検出は layer on 時のみ発現する**: e2e axis の全 layer on cell
  (`e2e-son-eon-don`) にのみ `eval_verdict=="pass"` かつ EvalSeal 受領 `verdict=="fail"`
  (`DIGEST_MISMATCH`) を仕込んだ結果、その cell だけ `false_completion_count=1` を検出した。
  同じ e2e axis の全 off cell (`e2e-soff-eoff-doff`) は trust キー自体が存在しないため矛盾兆候が
  一切現れない（`false_completion_count=0`）— これが「layer off では検出不能、on で初めて検出できる」
  という trust-layer dogfood の中核主張の直接証拠になる。他の 31 cell は矛盾を仕込んでいないため
  `false_completion_count=0`。
- **added latency は on layer 数に比例して観測できる**: 全 4 axis で off cell (`duration_p50=100`)
  → 全 on cell (`duration_p50=190`) まで、on layer 数（0→3）に応じて単調に増加する
  （fixture は on layer 1 個あたり +30s の合成 latency を仕込んでいる。実運用の絶対値ではなく
  「off/on 差が report script で観測できる」ことの決定論的な検証）。
- inconclusive / effect_mismatch は本 corpus では意図的に仕込んでおらず全 cell 0
  （検出ロジック自体は base fixture corpus — `dev-flow-doctor/tests/fixtures/trust-receipts/base/` —
  の `03-inconclusive-surfaceproof.json` / `04-effect-mismatch-duplicate.json` で別途 F1 の
  `trust-receipts-report.bats` により固定済み）。

決定論検証: `bats dev-flow-doctor/scripts/trust-receipts-matrix.bats`（4 tests, 全 green）。

## (c) real journal shadow 観測結果

`--slo --window 30d --until 2026-07-26T00:00:00Z` 実行結果（`since=2026-06-26T00:00:00Z`）:

| metric | 値 |
|---|---|
| total_runs（window 内 dev-flow run） | 45 |
| eligible_runs（trust_active_runs） | **0** |
| receipt_success_rate | null（測定不能） |
| inconclusive_rate | null（測定不能） |
| added_p95_seconds | null（`trust_active` 母集団 0 件のため `LATENCY_UNMEASURABLE`） |

**初期 SLO 仮説との照合**:

| 仮説 | 閾値 | 観測値 | 判定 |
|---|---|---|---|
| receipt 取得成功率 | >= 99% | null（母集団 0） | 未達成（測定不能を達成扱いにしない） |
| observer inconclusive 率 | < 1% | null（母集団 0） | 未達成（測定不能を達成扱いにしない） |
| p95 追加時間 | <= 180s | null（測定不能） | 未達成（`LATENCY_UNMEASURABLE`） |
| min_runs | >= 20 | 0 | 未達成（`INSUFFICIENT_RUNS`） |

45 件の dev-flow run 自体は window 内に存在するが、そのうち **1 件も** `trust_run_id` /
`trust_surfaceproof_shadow` / `trust_receipts` のいずれも持たない（`trust_active_runs=0`）。
これは trust-layer 自体（`_lib/trust-wiring.mjs`, shadow 固定）が機能していないのではなく、
**dotfiles 側 Stop hook（`stop-devflow-telemetry.sh`）が現時点でこれら trust telemetry キーを
whitelist / 転送しておらず、real journal entry に trust キーが到達していない**ことが原因
（本 worktree で `skill-retrospective/scripts/journal.sh` / `.claude/workflows/dev-flow.js` を
grep しても `trust_run_id` 系の配線は未実装であることを確認済み — 詳細は §(e)）。

## (d) Go/No-Go 判定

```json
{
  "eligible_runs": 0,
  "min_runs": 20,
  "receipt_success_rate": null,
  "inconclusive_rate": null,
  "added_p95_seconds": null,
  "go_no_go": "no-go",
  "reasons": ["INSUFFICIENT_RUNS", "LATENCY_UNMEASURABLE"]
}
```

**判定: No-Go**（`--slo` の決定論 oracle による。LLM の self-judge ではなく閉集合 enum 出力 —
`RECEIPT_SUCCESS_BELOW_SLO` / `INCONCLUSIVE_ABOVE_SLO` は rate が null のため評価自体が
成立せず reasons に現れない。`INSUFFICIENT_RUNS` と `LATENCY_UNMEASURABLE` の 2 reason のみ発火）。

**reason 分布**:

| reason | 発生 | 根本原因 |
|---|---|---|
| `INSUFFICIENT_RUNS` | 1 | eligible_runs(0) < min_runs(20) |
| `LATENCY_UNMEASURABLE` | 1 | trust_active 母集団 0 件で `trust_added_p95_seconds` が算出不能 |
| `RECEIPT_SUCCESS_BELOW_SLO` | 0（不発火・評価不能） | receipt_success_rate が null で閾値比較自体が成立しない |
| `INCONCLUSIVE_ABOVE_SLO` | 0（不発火・評価不能） | inconclusive_rate が null で閾値比較自体が成立しない |

**改善 child issue 案（No-Go 解消の道筋）**:

1. dotfiles Stop hook（`stop-devflow-telemetry.sh`）の trust telemetry 配線を追加する
   （§(e) の diff 案を適用 — dotfiles は本 worktree 外のため本 PR では変更しない）。
2. 配線後、通常の dev-flow 運用で **20〜30 eligible runs**（trust_active_runs、SurfaceProof/EvalSeal
   はほぼ全 run で shadow 実行されるため通常運用の蓄積で足りる見込み）を蓄積する。
3. 蓄積後に本スクリプトを再実行し Go/No-Go を再判定する:
   `bash dev-flow-doctor/scripts/trust-receipts-report.sh --slo --window 30d`
4. `go_no_go=="go"` を確認できた時点で `_lib/trust-wiring.mjs` の `TRUST_LAYER_CONFIG` を
   `shadow` → `advisory` へ昇格する別 PR を起票する（本 issue のスコープ外、W7 sunset path 準拠）。

## (e) dotfiles companion patch（記載のみ・本 PR では変更しない）

`~/ghq/github.com/it-all-playpark/dotfiles/claude-code/hooks/stop-devflow-telemetry.sh` の
jq object（72-91 行相当）へ trust telemetry キーを追加し、非空時のみ journal.sh へ転送する diff 案:

```diff
   if ! parsed=$(jq -e '{
     skill: .skill,
     outcome: .outcome,
     issue: .issue,
     journal_sh: .journal_sh,
     repo: .repo,
     pr_number: .pr_number,
     merge_tier: .telemetry.merge_tier,
     gate_policy: .telemetry.gate_policy,
     danger_hits: (.telemetry.danger_hits // []),
     shape: .telemetry.shape,
     shape_refloored: .telemetry.shape_refloored,
     plan_iter: .telemetry.plan_iter,
     eval_iter: .telemetry.eval_iter,
     eval_verdict: .telemetry.eval_verdict,
     iterate_status: .telemetry.iterate_status,
     eval_staleness: .telemetry.eval_staleness,
     ci_wait_seconds: .telemetry.ci_wait_seconds,
-    ci_poll_attempts: .telemetry.ci_poll_attempts
+    ci_poll_attempts: .telemetry.ci_poll_attempts,
+    trust_run_id: .telemetry.trust_run_id,
+    trust_receipts: .telemetry.trust_receipts,
+    trust_surfaceproof: .telemetry.trust_surfaceproof_shadow
   }' "$claimed" 2>/dev/null); then
```

```diff
   ci_wait_seconds=$(echo "$parsed" | jq -r '.ci_wait_seconds // empty')
   ci_poll_attempts=$(echo "$parsed" | jq -r '.ci_poll_attempts // empty')
+  trust_run_id=$(echo "$parsed" | jq -r '.trust_run_id // empty')
+  trust_receipts_json=$(echo "$parsed" | jq -c '.trust_receipts // empty')
+  trust_surfaceproof_json=$(echo "$parsed" | jq -c '.trust_surfaceproof // empty')
```

```diff
   if [[ -n $ci_poll_attempts && $ci_poll_attempts != "null" ]]; then
     cmd_args+=(--ci-poll-attempts "$ci_poll_attempts")
   fi
+  if [[ -n $trust_run_id && $trust_run_id != "null" ]]; then
+    cmd_args+=(--trust-run-id "$trust_run_id")
+  fi
+  if [[ -n $trust_receipts_json && $trust_receipts_json != "null" && $trust_receipts_json != "empty" ]]; then
+    cmd_args+=(--trust-receipts "$trust_receipts_json")
+  fi
+  if [[ -n $trust_surfaceproof_json && $trust_surfaceproof_json != "null" && $trust_surfaceproof_json != "empty" ]]; then
+    cmd_args+=(--trust-surfaceproof "$trust_surfaceproof_json")
+  fi
```

**前提**: 上記 diff は `journal.sh` 側が `--trust-run-id` / `--trust-receipts` /
`--trust-surfaceproof` を受理し（非配列 JSON・未知 layer/mode/verdict は closed enum で
`die_json` exit 1、3 フラグ未指定時は既存呼び出しと byte 互換）、`.claude/workflows/dev-flow.js` が
`state.trustSurfaceProofShadow || state.trustReceipts.length` の条件でのみ `trust_run_id` を
handoff JSON へ emit することを前提にする（architecture_decision 準拠）。**本 issue の時点では
これら 2 点（journal.sh 受理・dev-flow.js emit）は本 worktree 内で未実装であることを確認済み**
（本 task は `_lib/trust-wiring.mjs` / `.claude/workflows/dev-flow.js` / dotfiles 側ファイルを
変更しない境界のため、これらは本 issue 内の別 task、または後続 issue の責務として扱う。適用前に
`grep -n "trust_run_id" .claude/workflows/dev-flow.js skill-retrospective/scripts/journal.sh`
で配線状況を再確認すること）。

## (f) AC-15 非緩和宣言

本 PR（issue #413）は **消費・観測のみ** を行い、以下を一切変更しない:

- `_lib/trust-wiring.mjs` の `TRUST_LAYER_CONFIG`（全 layer `'shadow'` のまま）
- security floor（danger-grep fail-closed 等）
- Final reconcile（fail-safe HOLD）
- `gate_policy`（軸A invariant — deterministic oracle / seed / critical アイテムは全 policy で
  blocking のまま）
- 人間 merge（全 tier で例外なし）

blocking への実昇格は、本 doc §(d) の改善 child issue 経由で 20〜30 eligible runs を蓄積し
`--slo` が `go_no_go=="go"` を返した後の **別 PR** で行う（W7 capability-bound の sunset path —
`.claude/rules/dev-flow.md` の「EvalSeal shadow 固定の sunset path」「EffectDelta shadow 固定の
sunset path」に準拠）。
