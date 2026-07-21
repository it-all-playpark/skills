# Issue #390 Phase 0: Child-Issue 分解 / Baseline 参照 / Shadow Opt-in 境界決定

issue #390（epic: SurfaceProof / EvalSeal / EffectDelta を shadow dogfood し trust receipts を
検証する）は tracking parent であり、対象外として「1本のPRで3層を同時実装すること」を明示している。
本 doc は Phase 0 の完了条件「各childが1 issue=1 PRで独立検証・rollback可能。baselineが再計測可能な
形式で残る」を満たすための PR 成果物であり、コード変更は行わない。

悪魔の代弁者履歴 B1（「3層を1実装Issue/1 PRにするとscope・rollback・failure attributionが破綻する」）
への対応として、以下の分解は **層（SurfaceProof/EvalSeal/EffectDelta）ではなく issue 本文の
実装計画 Phase 1〜5 の区切りをそのまま child 境界に採用する**。issue 側で既に依存関係・担当・完了条件が
Phase 単位で定義されており、再分解すると本文の悪魔の代弁者レビュー履歴で確定した境界と乖離し
attribution が二重管理になるため、既存の Phase 区切りを忠実に 1 child = 1 issue = 1 PR へ写像する。

## 1. Child-issue 分解

Post-merge に人手または workflow が `gh issue create` で起票できるよう、5 child の spec を
ready-to-file 形式で表に固定する。依存は issue 本文の実装計画セクションを踏襲する。

| Child | Title 案 | スコープ In | スコープ Out | 依存 | 対応 AC | 完了条件 | Rollback 手順 |
|---|---|---|---|---|---|---|---|
| **Phase 1** | `feat(trust-layer): protocol kernel / feature flags / adversarial fixture基盤 (#390 Phase 1)` | 3 schema（SurfaceProof/EvalSeal/EffectDelta）の versioned closed schema、canonical digest、receipt validator、closed reason code、trust level を `_lib/` の pure function として実装。layer 別 mode（off/shadow/advisory/blocking）と全体 kill switch。共通 `run_id`・telemetry envelope・summary formatter。unknown field/enum・digest mismatch・schema invalid・capability 不足の fixture | GitHub adapter 実装（Phase 2/4）、trusted verifier 実装（Phase 3）、doctor 消費（Phase 5） | Phase 0 | AC-1, AC-2, AC-11, AC-12 | shadow/off で既存 merge tier・agent 呼出回数・return status が不変。receipt の determinism と拒否条件が unit test で固定される | kill switch で全 layer を off に戻す。schema/kernel は追加のみで既存 dev-flow 経路を書き換えないため、child PR を revert すれば挙動は Phase 0 時点に復帰する |
| **Phase 2** | `feat(trust-layer): SurfaceProof GitHub Issue adapter (#390 Phase 2)` | body/comments/labels/添付参照/明示spec link の canonical inventory 化、issue `updatedAt` と source digest の freeze、unit 単位の kind/digest/fetch capability/presentation status/reason と input pack digest 記録、Analyze 直前の source revision 再照合（stale・required unit omission・unsupported/fetch failure の closed taxonomy）、untrusted data としての prompt 分離・外部URL allowlist/redirect/size/content-type 制限 | GitHub Issue 以外の artifact/provider（out of scope、issue 本文の Out of Scope 継承） | Phase 1 | AC-3, AC-4 | comment だけにある AC・添付/明示link・権限不足・freeze後更新の fixture を `complete/pass` と誤判定しない | adapter を shadow off に戻し、child PR を逆順 revert。SurfaceProof 呼び出し箇所を Phase 1 の kernel-only 状態へ戻す（呼び出し元の分岐削除） |
| **Phase 3** | `feat(trust-layer): EvalSeal shadow + trusted verifier (#390 Phase 3)` | exact target head/base/tree OID、evaluator/toolchain bundle digest、obligation result、evidence digest、trust level の seal。現行同一harness evaluatorの receipt を `advisory` として記録（`trusted-environment` 非表示）。PRから変更不能な pinned verifier の feasibility spike（Check Run または署名 receipt の最小経路）。`pr-iterate` fix 後の旧 receipt 失効・Final PR HEAD 再評価。OID/bundle/schema 不一致は `inconclusive` とし blocking昇格後は HOLD へ route | 汎用 artifact protocol への一般化（Round 2 非blocking指摘 N3、本Issue外） | Phase 1（Phase 2 とは並列可） | AC-5, AC-6, AC-7 | agent write 圏外の verifier のみが `trusted-environment` になり、stale SHA/bundle mismatch/tampered receipt/evaluator unavailable corpus が成功扱いされない | pinned verifier digest を直前の既知 good へ戻す。EvalSeal を shadow off に戻し child PR を逆順 revert。同一harness advisory 経路のみへ復帰 |
| **Phase 4** | `feat(trust-layer): EffectDelta GitHub PR/comment/journal adapter (#390 Phase 4)` | `repo + issue + base + head_oid` から effect ID を作り PR 作成前探索・作成後readback で number/URL/base/head/tree/state を照合。`repo + pr + effect_type + run_id + body_digest` marker で comment 作成前探索・投稿後 comment ID readback・重複抑止。journal の stable effect ID・atomic write・flush側dedup・同秒/並列/再実行耐性。provider timeout/成功応答消失時は blind retry せず read-only rediscovery → `observed\|mismatch\|inconclusive` | GitHub PR/comment/journal 以外の provider（out of scope継承） | Phase 1（PR tree 照合は Phase 3 の target identity と同一語彙を共有するため実装順は Phase 3 完了後を推奨） | AC-8, AC-9, AC-10 | 同一 effect を2回実行しても PR/comment/journal が各1件で、wrong target/partial/duplicate/eventual-consistency-timeout を closed taxonomy で区別できる | EffectDelta を shadow off に戻し child PR を逆順 revert。dedup marker 検出のみ残し write 経路は既存（idempotency なし）へ復帰。historical journal entry は削除しない |
| **Phase 5** | `feat(trust-layer): doctor消費・2x2x2 dogfood・段階昇格 (#390 Phase 5)` | `dev-flow-doctor` へ layer別 status/reason、missing receipt、inconclusive、effect mismatch、false completion 検出、latency/cost 分布を追加。Stop hook whitelist/schema/run_id 配線更新。各 layer off/on の 2×2×2 比較を長文Issue/coding/PR副作用/end-to-end fixture で実施。20〜30 eligible runs の shadow 観測後 `shadow → advisory → blocking` の Go/No-Go 判定 | blocking への実昇格そのもの（SLO 未達時は次 child issue へ繰延） | Phase 2, Phase 3, Phase 4 | AC-13, AC-14（全体で AC-15） | planted corpus recall 100%、receipt 取得成功率99%以上、observer inconclusive 1%未満、p95追加時間3分以内を満たすまで blocking へ進めない。未達時は reason 分布と改善 child issue を残す | doctor 消費コードを revert（telemetry 生成側は Phase 1〜4 のまま残り write-only 化しない）。blocking 昇格前であれば advisory/shadow へ即時 down-grade。historical telemetry は削除せず rollout mode と version を残す |

全 child 共通のロールバック原則（issue 本文「リリース/ロールバック」を継承）:

1. kill switch で全 layer を `off` にする。
2. pinned verifier digest を直前の既知 good へ戻す（Phase 3 以降）。
3. adapter child PR を Phase 番号の**逆順**（5→4→3→2→1）で revert する。
4. receipt schema の dual-path 互換は追加せず、新形式 producer を停止する（本 repo の「後方互換
   scaffolding を作らない」規約と一致。legacy fallback や version 分岐は rollback 手段として使わない）。
5. historical telemetry は削除せず、rollout mode と version を残す。

AC 網羅チェック: AC-1, AC-2, AC-11, AC-12（Phase 1） / AC-3, AC-4（Phase 2） / AC-5, AC-6, AC-7（Phase 3）
/ AC-8, AC-9, AC-10（Phase 4） / AC-13, AC-14（Phase 5） / AC-15（全 Phase 共通、下記「shadow opt-in
境界決定」参照）で AC-1〜AC-15 を過不足なく Phase へ割当済み。

## 2. Baseline 参照

Phase 0 の完了条件「baseline が再計測可能な形式で残る」は、静的な数値記録ではなく **同一手順で
再実行できる決定論スクリプト + 凍結スナップショット** として本 PR に含める。

- スクリプト: `dev-flow-doctor/scripts/trust-baseline-snapshot.sh`
  （schema: `trust-layer-baseline/v1`）。既存 `dev-flow-doctor/scripts/analyze-dev-flow-telemetry.sh` /
  `baseline-snapshot.sh` が確立した「`~/.claude/journal/*.json`（`CLAUDE_JOURNAL_DIR` で override 可）を
  `jq` で `.telemetry.*` 集計する」パターンを踏襲し、新規 telemetry producer は追加しない。
- 凍結スナップショット例: `dev-flow-doctor/templates/trust-baseline-390.example.json`
  （`--window 30d` で実測した固定サンプルの形状例。実運用の再計測結果はこのファイルを上書きせず、
  別 out path に保存して比較する）。

### 4 proxy の意味

新 telemetry を追加せず、既存 dev-flow journal キーから trust-layer 問題への近似（proxy）を導出する。

1. **false_completion_proxy** — `eval_verdict == "pass"`（Evaluate が完了を宣言）にもかかわらず、
   `final_ac_reconcile == "unavailable"` / `testsurf_hits` 非空 / `redgreen_deny` 非空のいずれかが
   同居する run の割合。SurfaceProof/EvalSeal が防ごうとする「偽成功」の代理指標。
2. **inconclusive_events** — `eval_staleness in [hash_mismatch, iterate_incomplete]` /
   `final_reconcile == "unavailable"` / `vdelta_fail_open > 0` / `ui_verify in [failed_open, setup_failed]`
   のいずれかが立つ run の割合。「評価不能を成功に丸めない」観測ギャップの代理指標。
3. **phase_latency** — analyze/plan/implement/validate/evaluate/pr/iterate/final の各 phase と
   全体 `duration_seconds` の count/p50/p95。trust layer 追加によるレイテンシ増分の比較基準。
4. **effect_failure_rate** — `iterate_status in [fix_failed, stuck]` の割合（`iterate_status` が
   存在する run のみが分母）。EffectDelta が防ごうとする PR/comment/journal 副作用不整合の代理指標。

各 proxy はキー欠落（古い journal entry に該当キーが無い run）を failure/inconclusive に数えず、
その proxy の分母から除外する（`checks.*` の presence-only denominator）。journal が空、または
window 内に該当 run が 0 件の場合はエラーにせず `total_runs: 0` と全 count 0 / rate `null` を返す
（`dev-flow-doctor` の「0件時も安全に報告」規約に準拠）。

### 再計測手順

```bash
dev-flow-doctor/scripts/trust-baseline-snapshot.sh --window 30d --out /path/to/rerun.json
```

Phase 1（shadow flag 実装）マージ後、同一 `--window`（および比較したい場合は同一 `--until` アンカー）
で再実行し、`dev-flow-doctor/templates/trust-baseline-390.example.json` の値と `false_completion_proxy` /
`inconclusive_events` / `phase_latency` / `effect_failure_rate` を突合する。比較は本 PR のスコープ外
（Phase 5 の 2×2×2 dogfood 比較タスクに帰属）だが、突合対象となる基準ファイルと再計測コマンドは
本 PR で固定する。

### 初期 SLO 仮説（issue 本文由来、20〜30 run 実測前の仮説値）

- receipt 取得成功率 >= 99%
- observer inconclusive < 1%
- p95 追加時間 <= 3 分

これらは Phase 5 の Go/No-Go 判定基準であり、未達成のうちは `blocking` へ進めない（issue #154
calibration 設計との統合可否は Open Questions のまま）。

## 3. Shadow opt-in 境界決定

Phase 0 では feature flag 自体は実装しない（Phase 1 の担当）。本節は「どの識別子で skills repo を
判定し、既定 off をどう保証するか」の**決定のみ**を記す。

- **判定識別子**: `git remote get-url origin`（または CI 環境なら `GITHUB_REPOSITORY`）が
  本リポジトリの slug（`it-all-playpark/skills`）と一致する場合にのみ shadow 対象とする。
  未取得・未一致・判定不能（remote なし、fork、別 repo にコピーされた設定ファイル等）は
  すべて **off** にフォールバックする（fail-closed な allowlist 方式。denylist 方式は採らない）。
- **既定 off の保証**: layer 別 mode の default 値は `off`。skills repo 向けの `shadow` 指定は
  上記識別子一致を前提にした明示 override としてのみ有効化し、識別子判定が失敗・不一致の場合は
  override を無視して `off` を維持する。これにより配布先/他 repo（本 repo からスキルを import・
  clone した先）は追加設定なしで常に `off` のまま留まる。
- Phase 1 の flag 実装はこの決定を継承し、`off | shadow | advisory | blocking` の 4 値 enum と
  全体 kill switch を実装する際に上記の識別子判定ロジックをデフォルト解決の入力として使う。

**AC-15 の非緩和宣言**: shadow/off の導入・本 PR の baseline 集計・Phase 1〜5 のいずれの実装段階でも、
既存の security floor（danger-grep fail-closed 等）・Final reconcile（fail-safe HOLD）・`gate_policy`
（軸A invariant: critical/deterministic/seed = blocking を policy で緩めない）・人間 merge を緩和しない。
blocking への昇格は shadow 実測と初期 SLO 仮説の達成が確認された後、本 PR とは別の PR で判断する
（Phase 5 の完了条件と同一）。
