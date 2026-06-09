# W4 設計: red→green 実証ゲートで収束を ledger 駆動に差し替え

- **日付**: 2026-06-09
- **ステータス**: design(red→green mechanism の選択待ち → 確定後に bite-sized plan へ)
- **base**: W3(`feature/dev-flow-w4-redgreen-gate` は W3 tip `9747931` から stack。PR #144 merge 後に dev へ rebase)
- **上位 spec**: `claudedocs/2026-06-09-dev-flow-adaptive-ledger-redesign.md` の W4

## 1. W3 の到達点と W4 の課題

W3 で Evaluate phase に Goal Ledger を **observe-only** で構築済み(`dev-flow.js` L498-560)。
だが収束は依然 `ev.verdict === 'pass'` で break し、ledger は log + return のみ。

**核心の発見(W4 の設計を決める)**: W3 の AC item は `check:{kind:'inspection'}` + `severity:'major'` で
構築されるため `laneOf` では **advisory**(blocking ではない)。よって `isConverged`(= blocking lane の
全項目 checked)は **AC をゲートしない** — critical feedback だけ。

> 帰結: 単純に収束を `isConverged` へ差し替えても、AC に対しては現状の `verdict==pass` より**弱くなる**。
> `isConverged` が AC に対して意味を持つのは、**red→green でテスト化できた AC を `check:{kind:'deterministic'}`
> = blocking に昇格させたとき**だけ。つまり red→green は W4 のオプションでなく**心臓部**。

## 2. 収束契約(recalibration 反映)

W4 後の Evaluate 収束条件:

```
収束 = isConverged(ledger) AND ev.verdict === 'pass'
```

- `isConverged(ledger)`: **決定論ゲート**。red→green 実証済み AC(deterministic-blocking)が全て green、
  かつ全 critical が解消。test 化できる AC の充足を ungameable に保証。
- `ev.verdict === 'pass'`: **LLM ゲート**。test 化できない AC・holistic な設計健全性を LLM が判定
  (recalibration: LLM を advisory に降格しない。test が捉えられない領域の判断は残す)。
- 両者の AND = 「決定論で測れるものは決定論で、測れないものは LLM で」。critical は ledger の blocking
  なので isConverged が解消を要求(critical-always-blocks 維持)。

既存の stuck/relax/early-cutoff は **backstop として残す**(spec §3 原則5。ledger 実証まで撤去しない)。

## 3. 評価者の契約変更(item-validator 化)

`isConverged` を駆動するには evaluator が「どの AC が満たされたか」を返す必要がある。
EVAL schema と `evaluator.md` に **per-AC 判定**を追加する:

```jsonc
// EVAL schema 追加フィールド
"ac_results": {
  "type": "array",
  "items": { "type": "object",
    "required": ["ac_index", "satisfied"],
    "properties": {
      "ac_index": { "type": "number" },        // req.acceptance_criteria の index
      "satisfied": { "type": "boolean" },
      "evidence": { "type": "string" },         // file:line / テスト名 等
      "verified_by": { "type": "string", "enum": ["test", "inspection"] }
    }
  }
}
```

orchestrator は `ac_results` を見て `checkItem(ledger, 'AC-${i+1}', evidence)` する。
`verified_by==='test'` かつ red→green 実証が取れた AC は `check:{kind:'deterministic'}` に昇格(blocking)。
それ以外は inspection のまま(advisory、`verdict==pass` 側でカバー)。

`evaluator.md` は「verdict 決定者」から「**per-item validator + 全体 verdict**」へ。severity 判定は残す
(recalibration: severity は frontier の強み)。

## 4. red→green 実証メカニズム(要・選択)

**設計上の難所**: dev-flow の Evaluate phase 時点で、implementer の変更は worktree に**未 commit**で存在し
HEAD = base(origin/dev の fork 点)。「変更前 = red」を作るには、**テストは残しつつ実装だけ base に戻した
状態**でテストを走らせる必要がある。単一共有 worktree でこれをどう実現するかが選択ポイント。

### 案 R1+(採用): stash で impl だけ退避 + 推測しない4層分離
`git stash push -- <impl-paths>` で実装だけ base に戻し test は残す → test 実行(**red 期待**)→
`git stash pop` で復元 → test 実行(**green 期待**)。`<impl-paths>` を**推測でなく authoritative に**決める:

1. **第一情報源 = agent 申告**: implementer/evaluator が per-AC で `test_files[] / impl_files[]` を申告。
2. **runner glob で決定論クロスチェック**: 申告 `test_files` が repo の test discovery
   (`*.test.mjs` / `*.bats`)に一致しなければ昇格拒否(mislabel を機械的に弾く)。
3. **per-AC・per-test-file 粒度**: global 一括分離をせず AC ごとに紐づく test だけ stash 検証。
4. **fail-safe**: 曖昧なら deterministic 昇格を諦め inspection(advisory)に留める。
- 注意: workflow JS は bash 不可 → red→green の実行は **dev-runner-haiku agent** が
  `_shared/scripts/redgreen-verify.sh` を走らせ raw exit code を verbatim 返す(opus evaluator に
  判定させない = gaming 抑制)。

### 案 R2: base の別 checkout を temp に用意
`git worktree add <tmp> origin/<base>` で clean な base worktree を作り、新規テストファイルだけ
コピーして実行(red 期待)→ 元 worktree で実行(green 期待)。
- 利点: impl/test 分離が「新規テストファイルのコピー」だけで済み R1 より堅い。
- 欠点: worktree 追加コスト + テストの依存(fixture 等)が base に無いと誤 red。

### 案 R3: evaluator/implementer に reproduction test を明示生成させる
TDFlow 流。AC ごとに「これが満たされなければ落ちる」最小テストを生成させ、base で red・現状で green を
JS が記録。
- 利点: AC と test の対応が明示的で最も正確。
- 欠点: 生成コスト最大。test の adequacy(AC を本当に制約してるか)は別途 LLM 判定が要る(red-team 指摘の核)。

> いずれも「red→green が取れた AC だけ」を deterministic 昇格。取れない AC は inspection(advisory)に留め
> `verdict==pass` 側でカバー(=安全側。決定論化できないものを無理に blocking にしない)。

## 5. 作業分解(bite-sized は mechanism 確定後)

| # | 作業 | 依存 | リスク |
|---|------|------|--------|
| W4-1 | EVAL schema + `evaluator.md` に `ac_results` 追加(per-item validator 化) | — | 中(agent 契約変更) |
| W4-2 | orchestrator が `ac_results` で `checkItem` + AC を deterministic 昇格 | W4-1 | 中 |
| W4-3 | red→green 実証スクリプト `_shared/scripts/redgreen-verify.sh`(選択した案)+ bats | 案選択 | 高(novel) |
| W4-4 | 収束を `isConverged(ledger) && verdict==pass` へ差し替え(stuck/relax は backstop 維持) | W4-2,3 | 高(live gate) |
| W4-5 | W3 follow-up nit: `appendItem` の `check` shallow-clone / 未定義 severity の throw | — | 低 |

## 6. Open questions(plan 化前に解消)

1. ~~red→green mechanism の選択~~ → **解決: R1+ 採用**(2026-06-09)。
2. red→green が取れない AC が多数の場合、`isConverged` は実質 critical のみゲート → `verdict==pass`
   依存に戻る。それを許容するか(= traffic 次第。spec open question #5 と接続)。
3. evaluator が `ac_index` を req.acceptance_criteria と正しく対応づけられるか(index ずれ対策)。
4. red→green 実行のコスト(テスト2回 + checkout 往復)を EVAL_MAX ループ内で毎回やるか、初回 + 変化時のみか。

## 7. 非ゴール / backstop

- stuck/relax/early-cutoff/hard cap は撤去しない(ledger 実証まで)。
- merge tiering(AUTO/REVIEW/HOLD)は W5。gate_policy enum は W6。本 plan では扱わない。
- 動的コード生成はしない(W3 同様、可変 script + inline)。

## 参考
- W3 PR: #144 / W3 plan: `claudedocs/2026-06-09-w3-goal-ledger-engine-plan.md`
- 検証 run 2(human/LLM 境界 recalibration): `recalibrate-human-llm-boundary`
