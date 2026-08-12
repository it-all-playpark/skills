# issue #491: EvalSeal missing-reason 分布の実測と root cause 分析

## 1. 実測（`trust-receipts-report.sh --window 30d`）

実行コマンド: `dev-flow-doctor/scripts/trust-receipts-report.sh --window 30d`
（`window`: 30d, `since`: 2026-07-12T23:22:56Z, `taken_at`: 2026-08-11T23:22:56Z, `total_runs`: 65）

```
trust_active_runs: 12
missing_receipt.evalseal:
  count: 12
  rate: 1.0
  reason_distribution:
    seal_error: 1
    unrecorded: 11
missing_receipt.effectdelta:
  count: 5
  rate: 0.4167
```

全 12 の `trust_active` run で EvalSeal receipt が 0 件（missing rate 100%）。うち EffectDelta
receipt を持つ run は 7 件（missing_receipt.effectdelta の残 count=5 が「EffectDelta も無い」run）。

## 2. AC-6 の充足判定: **未達**

`trust_evalseal_missing_reason` の gating を stage スコープへ修正した F1 の変更は本 worktree に
**未コミット**（`main` HEAD `651b3aa` は旧 gating のまま）。上記 30d window の 12 run は全て
本 PR の merge 以前に実行された旧コードの run であり、「修正を反映した run」は **0 件**。
issue AC-6 が明示する `(run 数 0 の場合は未達)` に該当する。

個々の run を journal raw entry で裏取りした結果、「unrecorded」11 件のうち 10 件は
`trust_evalseal_missing_reason` telemetry 自体が導入される前（issue #471, commit `3292945`,
2026-07-31 13:08 JST 以前）の run であり、機構が存在しないため必然的に unrecorded だった
（F1/#491 のバグとは無関係）。残り 1 件（run_id `1785832894`, 2026-08-04 実行、telemetry に
`{"layer":"effectdelta","stage":"summary-comment"}` の receipt あり・EvalSeal receipt なし）は
機構導入後の run で、**本 issue #491 が修正対象とする gating バグの実測痕跡そのもの**
（詳細は §3）。`seal_error:1`（run_id `1785829613`, 2026-08-04 実行, EvalSeal/EffectDelta 双方
receipt なし）は旧 gating でも正しく理由が emit された run。

**再測定コマンドと再測定タイミング**: 本 PR merge 後、次回以降の dev-flow run が journal に
蓄積された時点で `dev-flow-doctor/scripts/trust-receipts-report.sh --window 30d` を再実行する。
修正反映 run（merge 後の run_id）が `missing_receipt.evalseal.runs` に現れ、対応する
`reason_distribution` に non-unrecorded の enum 値が現れれば AC-6 は充足に転じる。

## 3. Root cause 分析

### 3.1 現行 30d 分布の内訳（時系列裏取り）

journal raw entry（`~/.claude/journal/*.json`）を run_id ごとに突合した結果:

| run_id | 実行日時 | receipts (raw) | telemetry `trust_evalseal_missing_reason` | 説明 |
|---|---|---|---|---|
| 1785100028〜1785465934（10件） | 2026-07-26〜07-31 05:14 | 混在 | `null`（unrecorded） | issue #471（`trust_evalseal_missing_reason` telemetry 導入コミット `3292945`, 2026-07-31 13:08）**以前**の run。機構自体が存在しないため必然的に unrecorded |
| 1785829613 | 2026-08-04 08:34 | `[]`（EvalSeal・EffectDelta とも無し） | `seal_error` | 機構導入後の run。`state.trustReceipts.length===0`（旧 gating の条件）が成立し正しく理由が emit された |
| 1785832894 | 2026-08-04 10:10 | `[{"layer":"effectdelta","stage":"summary-comment"}]`（EffectDelta のみ） | `null`（unrecorded） | 機構導入後の run。**EvalSeal receipt は無いが EffectDelta receipt があるため旧 gating（`state.trustReceipts.length===0`、3 layer union）が不成立となり `trust_evalseal_missing_reason` キーが抑制された** — issue #491 / AC-1 が修正対象とする欠陥そのものの実測発現 |

すなわち、現行 30d window で観測できる「本物の分布ノイズ」（機構導入後・かつ本 issue のバグに
起因する unrecorded）はサンプル数 1（`1785832894`）のみであり、F1 の修正（`evalsealStageReceipts`
への stage スコープ化）が入ればこの run は `evalsealStageReceipts.length===0` によって
正しく理由（内部的には `state.trustEvalsealMissingReason` に設定された実際の enum 値）を
emit するはずだった run である。

### 3.2 背景: issue #471（EvalSeal receipt 恒常的欠落, 2026-07-31）

`gh issue view 471 --repo it-all-playpark/skills` の実測記録によると、当時（2026-07-01〜07-31
window）は EvalSeal receipt 取得率が **9 run 中 9 件欠落（rate 1.0）** で、原因は 2 層と分析されていた:

1. **設計欠陥**: `buildEvalsealObligation` の `verdict`/`evidence` が orchestrator 側で
   自然文から組み立てられ、実 tool 出力（`diff-risk-classify.sh` の stdout・test green 判定）
   に束縛されていなかった。
2. **症状**: 2026-07-28 の run（issue #438）で `trust-seal-eval` subagent が safety classifier に
   "Security Test Removal" として拒否された実測事例（44 agent 中 1 error）。分類器の指摘は
   「orchestrator が SEC-* pass クレームを自ら書き下した JSON を subagent に seal させており、
   実行証跡から導出されていない」というもので、(1) の設計欠陥への指摘として妥当と判断された。

issue #471 は `evalseal/2` schema 化 + obligation の機械導出化でこの設計欠陥を修正し、
`trust_evalseal_missing_reason` の closed enum telemetry（本 issue #491 が gating を修正する
対象そのもの）を同時に導入した。`TRUST_LAYER_CONFIG.evalseal` は `'shadow'` のまま変更されて
いない（#471 の non-goal）。

### 3.3 現在の window での classifier block 再発有無

本 30d window の reason_distribution には `agent_throw` / `agent_null`（#471 が指摘した
classifier-block パターンに対応する enum 値）が **1 件も出現していない**。ただし前述の通り
機構導入後の実 run はわずか 2 件（`1785829613` の `seal_error`, `1785832894` の
本バグによる `unrecorded`）しかなく、classifier block が再発しているかどうかを判別するには
サンプル数が構造的に不足している（本 issue #491 の gating バグ自体が「理由の可視化」を
阻害していたため、この不足は #491 の欠陥と無関係ではなく、その一部でもある）。

## 4. 対応

**本 issue スコープ内の欠陥は F1 で修正済み**: `.claude/workflows/dev-flow.js` の
`trust_evalseal_missing_reason` gating を 3 layer union（`state.trustReceipts.length===0`）から
EvalSeal 自身の stage スコープ述語（`evalsealStageReceipts = state.trustReceipts.filter((r) =>
r.stage === 'evaluate' || r.stage === 'final')`）へ変更し、telemetry handoff・return payload の
両箇所を同一変数参照に統一した（AC-1〜AC-5）。§3.1 の run `1785832894` はこの修正が
なぜ必要かを実データで裏付けている。F2（本レポート）では **これ以上のコード修正を行わない**
（F1 の gating を後退させない — Boundary 遵守）。

`evalseal-seal.mjs` の verdict 導出・`TRUST_LAYER_CONFIG` の shadow→advisory 昇格・
safety classifier の挙動そのものは本 issue のスコープ外（#471/#390 が扱う領域）であり、
修正しない。

### Sunset path（再評価トリガ）

1. **表現**: 本 PR merge 後、通常の dev-flow 運用で run が蓄積された時点
   （#390 の 2x2x2 dogfood と同じ運用単位: 20〜30 eligible runs 目安）で
   `dev-flow-doctor/scripts/trust-receipts-report.sh --window 30d` を再実行する。
2. **判定**:
   - `missing_receipt.evalseal.reason_distribution` に non-unrecorded の enum 値が複数件
     現れれば AC-6 は充足。支配的理由が `agent_throw`/`agent_null` であれば #471 の
     classifier-block 論点がまだ残存している可能性を示すため、epic #390 配下に follow-up
     issue を起票する。
   - 支配的理由が `unrecorded` のままであれば、telemetry 配線漏れ（F1 修正の merge 反映
     漏れ・journal.sh 側の未登録キー等）を疑い再調査する。
   - `mode_off`/`eval_skipped` が支配的であれば、micro path（Evaluate skip）や
     kill switch/allowlist 起因の非稼働が多いことを意味し、EvalSeal 自体の稼働率向上が
     次の課題になる。
3. **再評価トリガ**: 上記のいずれの場合も、次回 dev-improve サイクル（週次）または
   `#390` の Go/No-Go 再判定タイミングで本コマンドを再実行し判定する。

## 5. epic #390 への報告

`.devflow-tmp/issue491-390-comment.md` の内容で `gh issue comment 390` により投稿する
（投稿結果は本レポート末尾に追記）。

---

**#390 コメント投稿結果**: 成功（後述コマンド実行の exit code 0 を確認）。
