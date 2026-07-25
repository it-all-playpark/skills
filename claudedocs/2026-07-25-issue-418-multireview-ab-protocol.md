# AB 比較 protocol — 多視点レビュー（multi_review） vs 単一パス（issue #418）

## スコープの線引き（evaluator / human reviewer 向けの判断根拠）

AC-4/AC-5 の **in-PR 成果物**は以下までに限定する:

- 計測基盤（`multi_review` / `review_only` / `ab_record` フラグ、history 配列への
  per-round metrics 記録、`pr-iterate/scripts/ab-metrics.sh` 集計スクリプト）
- 本 protocol doc（AC-4 の「比較手順」の前提条件部分）

**実 PR 5 件以上の比較 run と、issue #418 への採用可否コメント（AC-5）は post-merge 運用である。**
理由: Claude Code の `Workflow` tool は top-level session 専用であり、dev-flow / pr-iterate の
subagent 内部から新たな `workflow('pr-iterate', {...})` 呼び出しを起動できない
（`.claude/agents/*.md` はネストされた subagent であり Workflow tool を持たない）。
本 issue の実装は現行の dev-flow / pr-iterate run の中で完結する必要があるため、
実 PR に対する AB run は本 PR のマージ後、別セッションから operator（人間）が
top-level で下記手順を実行する形になる。

本 doc は「実装が完了すれば AC-4/AC-5 を満たす計測が可能になる」ことを示す運用手順書であり、
in-PR で満たされているのは前提条件（計測基盤の実装 + 手順の明文化）である。

## 対象 PR 選定

- **既定基準**: 本 PR マージ後に新規発生する実 PR から、docs-only PR を除いた 5 件以上
  （変更ファイル数 2 以上の PR を推奨 — 単一ファイル trivial PR はレンズ分割の効果が測りにくい）。
- **過去 PR の再実行は既定では使わない**。マージ済み PR は tree の再現（当時の base/head の
  正確な復元）が難しく、AB 比較の同一 HEAD 前提が崩れやすいため（issue #418 Open Question の
  暫定解）。運用上どうしても過去 PR を使う場合は、この既定を変更した旨を issue #418 へ追記すること。

## 計測手順

各対象 PR につき、以下を実行する（top-level session から）。

### 1. review_only probe（同一 HEAD で旧方式・新方式を両方走らせる）

```
workflow('pr-iterate', {pr: <N>, review_only: true, post_terminal_summary: false, ab_record: true})
workflow('pr-iterate', {pr: <N>, review_only: true, post_terminal_summary: false, ab_record: true, multi_review: true})
```

- (a) 旧方式 probe → (b) 新方式 probe の順に連続実行する。
- `review_only: true` は fix agent・CI gate を一切呼ばないため、PR tree は両 probe を通じて不変。
  すなわち (a)(b) は必ず同一 HEAD SHA をレビューする。
- 実行後、`~/.claude/journal/ab-runs/` に書き出された両 result JSON の `head_sha`
  （PR_META probe `gh pr view --json url,headRefOid` 由来）を突合し、一致することを確認する。
  **不一致の場合は PR へ push が挟まった run として無効とし、再実行する**
  （下記「エッジケース」参照）。

### 2. 通常 run（fix loop あり）は PR ごとにどちらか一方の方式のみ

review_only probe とは別に、実際に fix ループを回す通常 run は各 PR につき**片方式のみ**
実行し、対象 PR 群に対して旧方式・新方式を交互に割り当てる（PR1=旧, PR2=新, PR3=旧, ...）。

```
workflow('pr-iterate', {pr: <N1>})                          # 旧方式（PR1, PR3, ...）
workflow('pr-iterate', {pr: <N2>, multi_review: true})       # 新方式（PR2, PR4, ...）
```

理由: fix commit は PR tree を書き換えるため、同一 PR に両方式を順番に通常 run すると
2 回目に実行した方式が「1 回目の fix 適用済み tree」を見ることになり、後行方式が系統的に
有利になる交絡（confound）が生じる。review_only probe（1 節）で品質比較を、通常 run
（本節）で iteration 回数・トークンコストの実運用比較を分離して行う。

## 誤検知（FP）判定

各方式の blocking finding（severity: critical/major）ごとに、人間（yuji naramoto）が
TP/FP を判定する。

判定チェックリスト（3 点すべて満たせば TP、いずれか欠けたら FP — issue #418 Open Question
の暫定基準）:

1. 指摘の `file:line` が実在する
2. 指摘内容がコードから再現・検証できる
3. PR スコープ内である（PR の宣言意図から逸脱した要求でない）

判定結果は各 result JSON に `token_usage` と同様、operator が追記するか、
下記の比較表へ直接記録する。

## 集計

```bash
bash pr-iterate/scripts/ab-metrics.sh
```

の出力表に、以下を追加して比較表を完成させる:

- FP 判定列（誤検知率 = FP 件数 / blocking finding 総数、方式別）
- トークン使用量（session の `/cost` 等から operator が result JSON の任意キー
  `token_usage` へ手動追記した値を集計）

## 判断記録

比較結果に基づき、以下いずれかの判断を行い、`gh issue comment 418` で issue #418 へ記録する。

- **採用**: 新方式（`multi_review: true`）を既定 true へ変更する
- **不採用**: 現状維持（`multi_review` 既定 false のまま）
- **条件付き採用**: 特定条件下（PR サイズ・変更カテゴリ等）でのみ新方式を使う

判断根拠テンプレ（issue コメントに含める 3 軸）:

```
## AB 比較結果（issue #418）

- 対象 PR: N 件（review_only probe / 通常 run 内訳）
- 誤検知率: 旧方式 X% / 新方式 Y%
- iteration 回数（平均）: 旧方式 X / 新方式 Y
- トークンコスト（平均）: 旧方式 X / 新方式 Y

## 判断: 採用 / 不採用 / 条件付き採用

<根拠>
```

## ロールバック

`multi_review` フラグを渡さなければ常に旧方式（単一パスレビュー）が実行される
（コード変更不要。AC-1 のロールバック保証）。AB 比較の結果を待たず、いつでも
既定 false のまま運用を継続できる。

## エッジケース

| ケース | 扱い |
|--------|------|
| AB probe 2 回の間に PR へ push が挟まる | result JSON の `head_sha` を突合し、不一致の run は無効として再実行する。`head_sha` が null（PR_META probe 失敗、fail-open）の場合は operator が `gh pr view` で手動確認する |
| `ab_record` の書き込み失敗（agent null / `recorded:false`） | fail-open — warn log のみで workflow は継続する。AB 計測は advisory であり merge tier・gate 判定に影響しない |
| `ab-metrics.sh` の入力ディレクトリが空・不在 | `no ab-run results found` を出力し exit 0（比較不能を明示するのみ） |
| 個別の result JSON が壊れている | stderr へ warn し当該ファイルを skip して集計を継続する（1 件の破損で全滅させない） |
