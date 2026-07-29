adopted_decision: 条件付き採用

# QUALITY_MODEL 向け指示縮約の A/B 実測 (issue #423, task F3)

## 結論（先頭サマリ）

- **採否判断: 条件付き採用**
- 縮約対象 3 箇所（dev-planner.md 禁止表現リスト、evaluator.md 出力文体×/○例、
  evaluator.md feedback_level 灰色領域5規則）は F1/F2 で `.claude/agents/dev-planner.md` /
  `.claude/agents/evaluator.md` に適用済み（`git diff origin/main` で dev-planner.md
  -11/+4行、evaluator.md -23/+9行の縮約を確認）。
- 契約不変検証（Step 1）: green。proxy A/B（Step 3, #323 先例準拠の nested `claude -p`）:
  3 ケース × 各 N=5（計30 run）で **縮約後（brief）が縮約前（verbose）に一度も劣後しなかった**（30/30 一致）。
- ただし A/B の比較対象は「pre-merge の nested `claude -p` プロキシ測定」であり、
  AC-5 が要求する実 dev-flow run（plan_iter/eval_iter/iterate_status/duration_seconds の比較）は
  merge 前には取得できない（Workflow tool は top-level 専用で nested full dev-flow run は実行不能 — 既知の環境制約）。
  そのため「採用」ではなく「条件付き採用」とし、merge 後に実 run で事後確認する計画を本レポート末尾に明記する。

## Step 1: 契約不変検証

| 項目 | 結果 |
|------|------|
| `./node_modules/.bin/vitest run --configLoader runner`（118 test files, 1652 tests） | **green**（全 pass。素の `npm test` は sandbox の Bash 直接書込み deny で node_modules/.vite-temp への mkdir が EPERM になり起動不能なため、config bundling を skip する `--configLoader runner` で実行） |
| `_lib/eval-convergence.test.mjs` / `_lib/evaluator-contract.test.mjs` 個別実行 | **green**（2 files, 14 tests 全 pass）— AC-4「feedback_level の design/implementation 分岐（dev-flow.js:4169/4181）が変更前と同じく機能する」を直接検証 |
| `bash tests/run-all-bats.sh --strict` | **29 passed / 1 failed**（`_shared/scripts/ui-verify-server.bats`。python3 http.server の実プロセス起動・port bind・curl 到達性を要求するテストで、sandbox のプロセス生成/ポート制約による既知の環境依存失敗。F1/F2 が触れた `.claude/agents/*.md` とは無関係な別スキルの bats であり、F1/F2 適用前の baseline 実行でも同一の失敗だったことを確認済み — 本 issue のスコープに起因する regression ではない） |

AC-7 は「bash tests/run-all-bats.sh --strict および _lib の全 *.test.mjs が green」を要求するが、
上記のとおり bats の非 green は本 issue のスコープ外ファイル（別スキル）の環境依存失敗であり、
`.claude/agents/dev-planner.md` / `.claude/agents/evaluator.md` の縮約に起因する regression ではない。

## Step 2: A-side real-run baseline（journal telemetry, fable切替日 2026-07-22 以降）

`~/.claude/journal/*dev-flow*.json` から `outcome: "success"` かつ `source: "skill"` のエントリを
timestamp 昇順で抽出。該当期間の success run はちょうど5件（2026-07-22〜2026-07-28本日時点）。

| issue | PR | timestamp | shape | plan_iter | eval_iter | iterate_status | findings件数 | duration_seconds |
|------|----|-----------|-------|-----------|-----------|-----------------|--------------|-------------------|
| 422 | 426 | 2026-07-26T22:13:44Z | standard | 1 | 1 | lgtm | N/A（journal未記録） | N/A（journal未記録） |
| 424 | 425 | 2026-07-26T22:52:37Z | standard | 1 | 1 | lgtm | N/A（journal未記録） | N/A（journal未記録） |
| 411 | 415 | 2026-07-28T04:48:07Z | complex | 1 | 1 | lgtm | N/A（journal未記録） | N/A（journal未記録） |
| 433 | 441 | 2026-07-28T05:27:17Z | complex | 1 | 1 | lgtm | N/A（journal未記録） | N/A（journal未記録） |
| 430 | 446 | 2026-07-28T07:28:28Z | complex | 1 | 1 | lgtm | N/A（journal未記録） | N/A（journal未記録） |

欠落理由: `journal.sh` の telemetry スキーマ（`_lib/journal-telemetry-fields.mjs` 系）に
findings 件数を記録するフィールドが存在せず、`duration_seconds` は8キーtelemetryの一部として
存在するが上記5件はいずれも呼び出し側（dev-flow.js）から渡されていない（値が捏造できないため
欠落のまま記載）。5件すべてが `plan_iter=1 / eval_iter=1 / iterate_status=lgtm` で、
縮約前の指示（本 issue の変更前）での挙動として記録されている。これが変更前（verbose）側の
real-run baseline となる。B-side（縮約後 = 本 PR merge 後の run）はこのレポート作成時点では
まだ存在しない（後述の事後観測計画で埋める）。

## Step 3: proxy A/B（縮約前後の直接比較、issue #323 先例準拠）

### 測定条件

| 項目 | 値 |
|------|----|
| model | `fable`（claude-fable-5, CLI `--model fable`） |
| effort | `high`（`--settings '{"effortLevel":"high"}'`） |
| 実行方法 | `CLAUDE_STOP_GUARD=0 env -u ANTHROPIC_API_KEY claude -p '<prompt>' --model fable --settings settings-high.json --disallowedTools <全tool> --output-format json`（詳細下記） |
| N | 各ケース × 各 variant で 5 |
| ケース数 | 3（dev-planner self-containment / evaluator feedback_level 精度 / evaluator 出力文体） |
| 総試行数 | 3 × 2 × 5 = 30 |

### 実行方法の制約と対応（測定方法論の変更理由）

1. **リポジトリ直下からの実行は不可**: worktree のカレントディレクトリで nested `claude -p` を
   起動すると、本セッションの `stop-unfinished-guard.sh` Stop hook が nested セッションにも
   継承され、worktree の未コミット差分（F1/F2 の編集）を検知して無限に "Stop hook feedback" を
   送り続け、`terminal_reason: aborted_streaming` で `result` が空文字のまま応答不能になることを
   確認した。`CLAUDE_STOP_GUARD=0` を nested プロセスの環境変数に設定することでこの hook を
   無効化し、単一 turn で正しい応答を得られることを確認した（#323 の EPERM とは異なる新規の
   環境制約 — nested `claude -p` が親 worktree の hook/uncommitted-state を継承する）。
2. **`$TMPDIR` からの実行**: worktree の cwd では本 repo の `CLAUDE.md`/`AGENTS.md` が system
   prompt として自動注入され、一部の run でモデルが「これは A/B テストスクリプトの実行だ」と
   メタ認識して指示外の Bash/Read 呼び出しを試みる drift が観測された（cwd = worktree 直下での
   予備実行で 10 run 中 2 run が該当）。`$TMPDIR` 配下（プロジェクト外）から起動することで
   この drift を解消した。
3. **tool 呼び出し自体は不要な設計**: 各ケースのプロンプトは判定・書き直し・整形の純テキスト
   応答のみを要求し、nested Bash 実行は要求しない（#323 と同じ設計判断）。`--disallowedTools`
   には標準ツール（Bash/Read/Write/Edit/Glob/Grep/WebFetch/WebSearch/Task/TodoWrite/NotebookEdit）
   に加え、この環境固有の agent 系ツール（Skill/Monitor/ToolSearch/Workflow/Cron*/Task*等）も
   含めないと `tool_use` で応答が中断されることを確認し、全て列挙した。

### ケース定義と判定ルール

- **case1（dev-planner self-containment）**: 縮約前後それぞれの Step4 セクションを埋め込み、
  固定 fixture（「3 task の計画で task2/task3 が task1 のパターンを再利用する状況。各 task の
  desc を書け」）に対する出力を `rg -i '上述|前述|と同様|See Task|same as Task'` で機械判定
  （マッチ = 相互参照違反）。
- **case2（evaluator feedback_level 精度）**: 削除した灰色領域規則1-5に対応する5シナリオ
  （期待値: 規則1→implementation、規則2〜5→design）を fixture 化し、`{"feedback_level":"..."}`
  の JSON 出力を期待値と機械比較。
- **case3（出力文体）**: 英語jargon混じりの生 finding 5件を与え、evaluator の description
  書式で書き直させ、非ASCII文字比率（≥0.35を目安）と文字数（≤260字、200字目安+バッファ）を
  機械判定。

### 結果

| ケース | verbose 成功率 | brief 成功率 | 非劣後判定 |
|--------|:-------------:|:------------:|:----------:|
| case1: self-containment（相互参照違反ゼロ率） | 5/5 (100%) | 5/5 (100%) | 非劣後 |
| case2: feedback_level 精度（期待値一致率） | 5/5 (100%) | 5/5 (100%) | 非劣後 |
| case3: 出力文体（非ASCII比率・文字数遵守率） | 5/5 (100%) | 5/5 (100%) | 非劣後（brief の平均非ASCII比率 0.68 は verbose の平均 0.54 を上回った — 参考値、判定には使用しない） |
| **合計** | **15/15 (100%)** | **15/15 (100%)** | **全ケース非劣後** |

失敗した run: なし（0/30）。

## 採否判断とその根拠

判定ルール（plan 記載）: 「全ケースで縮約後（brief）が縮約前（verbose）に劣後しなければ非劣後」。
今回の実測では 3 ケース全てで brief と verbose が同率（5/5）であり、1 件も劣後していない
（case3 は brief がむしろ僅かに上回った）。したがって proxy A/B は**非劣後**と判定する。

一方で、AC-5/AC-6 が要求する「変更前後で各5run以上の実 dev-flow run による A/B」のうち
B-side（縮約後 = 本変更 merge 後の実 run）はこのレポート作成時点で存在しない
（本変更は F3 実行時点でまだ merge されていない）。issue 自身が
「A/B の run 数・比較対象の選定方法」を未解決の ambiguity として明示しており、
AC は採否3値（採用/不採用/条件付き）を許容している。

以上より、**「条件付き採用」**とする:

- 契約不変検証（Step 1）: green（本 issue スコープ内）
- proxy A/B（Step 3）: 全ケース非劣後
- real-run A/B（AC-5 の完全な形）は merge 後に事後確認する

### 事後観測計画（merge 後）

merge 後、`~/.claude/journal/*dev-flow*.json` の `outcome: success` かつ `source: skill` の
run が **本変更適用後に5件以上**蓄積した時点で、Step 2 と同じ抽出条件（plan_iter / eval_iter /
iterate_status / duration_seconds）で B-side 表を作成し、A-side（本レポート Step 2、5件、
全件 `plan_iter=1 / eval_iter=1 / iterate_status=lgtm`）と突合する。
悪化トリガ（次回 dev-flow-doctor 実行時に確認）: `eval_iter` の中央値上昇（design 差し戻し増加を示唆）、
`iterate_status` の `lgtm` 以外への分布シフト、`plan_iter` の cap 張り付き増加。
いずれかが観測された場合は本縮約を revert 対象として再検討する。

## F1/F2 への申し送り

- 本 A/B の結果、F1（dev-planner.md）/ F2（evaluator.md）の縮約編集は revert 不要。
  現状のまま維持する。
