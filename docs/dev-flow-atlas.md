# i dev-flow Pipeline Atlas

GitHub issue から LGTM までを 10 phase で駆動する `dev-flow` の実処理を図で示す。
すべて実装ソース（`plugins/dev-flow/.claude/workflows/dev-flow.js` /
`plugins/dev-flow/.claude/workflows/pr-iterate.js` /
`.claude/rules/dev-flow.md`）から起こしたもので、要約や理想形ではない。

規約・設計判断の正典は [`.claude/rules/dev-flow.md`](../.claude/rules/dev-flow.md)。
本ドキュメントはその視覚的な索引であり、両者が食い違う場合は rules 側が正しい。

## 不変条件

どのモデル世代でも緩めない。

- **merge は常に人間。** LGTM 後にユーザーが merge する。AUTO tier も「推奨ラベル」であって
  自動 merge ではない。全 tier で例外なし
- **1 issue = 1 PR。** 並列実装は単一 worktree 内で file-disjoint な task を fan-out する。
  issue 分割も integration branch も使わない
- **軸A invariant。** 決定論オラクル・security floor・critical アイテムはどの `gate_policy` でも
  blocking。policy で緩めない
- **後方互換 scaffolding を作らない。** enum 外の値は legacy fallback ではなく明示 error にする

---

## 1. パイプライン全体

wrapper skill が worktree を用意して `EnterWorktree` した上で、dynamic workflow `dev-flow-run` を
起動する。phase 遷移とループは workflow script が JS で保持し、中間 state は外部 JSON ではなく
script 変数に持つ。

まず概観を示し、続いて 10 phase を 1 phase 1 図で展開する。

### 1.1 概観

```mermaid
flowchart TD
    U["/dev-flow ISSUE"] --> PF["wrapper preflight<br/>dev-flow-prerun（base → worktree → clean → deps → stack）<br/>→ EnterWorktree"]
    PF --> W["Workflow: dev-flow-run<br/>args.setup = prerun の JSON"]
    W --> S["1. Setup"]
    S --> A["2. Analyze"]
    A --> P["3. Plan"]
    P --> I["4. Implement"]
    I --> V["5. Validate"]
    V --> SF["6. Security floor"]
    SF --> E["7. Evaluate"]
    E --> R["8. PR"]
    R --> FR["9. Final reconcile"]
    FR --> MT["10. Merge tier"]
    MT --> HU["merge は常に人間"]

    S -.->|"fail-closed"| AB["throw / workflow abort"]
    V -.->|"空 diff が 2 回連続"| AB
    A -.->|"AC 空 / 曖昧 / provenance 不合格"| NC["needs_clarification<br/>worktree は保持"]
    I -.->|"NEEDS_CONTEXT 解消不能"| NC
    SF -.->|"risk 欠落・実行不能"| FC["fail-closed<br/>merge tier HOLD 強制"]
```

破線は正常系から外れる経路。`needs_clarification` は worktree を保持したまま返るので、
人間が確認して `dev-flow-prerun` から再起動すれば同じ worktree が再利用される（`setup` は
再取得する — 前回の epoch を使い回すと isolation probe のファイル名が衝突して abort する）。

### 1.2 Setup

決定論処理（base 解決・worktree 作成/再利用と起点検証・`.devflow-tmp` clean・deps install・
stack 検出）は run 前に wrapper skill が top-level の Bash 1 コマンド `dev-flow-prerun` で済ませ、
その stdout JSON を `args.setup` として渡す。Setup phase で subagent を spawn するのは
isolation probe の 1 回だけ。

```mermaid
flowchart TD
    PR["wrapper: dev-flow-prerun<br/>base → worktree → clean → deps → stack<br/>JSON 1 行を args.setup へ"] --> IN["Workflow 起動"]
    IN --> S1["validatePrerunSetup(args.setup)<br/>純関数・spawn なし"]
    S1 --> S5["isolation probe<br/>Write tool で書けるか<br/>token = setup.epoch"]
    S5 --> OUT["Analyze へ"]

    PR -.->|"ok:false"| STOP["wrapper が停止し人間へ報告"]
    S1 -.->|"setup 欠落 / ok:false<br/>必須キー欠落"| AB["throw / abort"]
    S5 -.->|"written:false"| AB
```

`dev-flow-prerun` の各段は独立に `ok:false` を報告し後続段を巻き込まない。base は明示指定なら
origin に存在するか検証、未指定なら `origin/dev` → `origin/HEAD` の順。既存 worktree は upstream が
`origin/BASE` と一致するか検証する。`args.setup` が無い・`ok:false`・必須キー欠落は workflow が
即 throw し、workflow 内 proxy への fallback は置かない（後方互換 scaffolding 禁止）。
worktree は repo 内 `.claude/worktrees/df-N` を優先し、書き込めない
（`worktree_status:"unwritable"`）場合のみ wrapper が repo 外 `repo-wt/df-N` で prerun を再実行する。
isolation probe は wrapper で代替しない — subagent の Write 経路が通ることの検証であり、
top-level の Bash では意味が変わる。

### 1.3 Analyze

```mermaid
flowchart TD
    IN["Setup 完了"] --> A0{"DEPTH が standard ?"}
    A0 -->|yes| A1["contract probe<br/>決定論 parse"]
    A0 -->|no| A2["analyze<br/>dev-runner"]
    A1 -->|"ok かつ whitelist 合格"| A3
    A1 -->|"失敗（fail-open）"| A2
    A2 --> A3{"provenance 検証 OK ?"}
    A3 -->|no| NC["needs_clarification<br/>worktree は保持"]
    A3 -->|yes| A4{"AC 空 or<br/>ambiguities が 2 超 ?"}
    A4 -->|yes| NC
    A4 -->|no| A5["classifyShape"]
    A5 --> OUT["Plan へ"]
```

contract 経路は `analyze-issue.sh --contract` の出力を決定論 parse する高速経路で、
失敗しても sonnet の analyze へ fail-open で落ちる。provenance 検証は analyze 結果が
実際の issue 取得に基づくことを突き合わせる fail-closed のゲートで、捏造した要件を
Implement へ流さないためにある。

### 1.4 Plan

```mermaid
flowchart TD
    IN["shape 確定"] --> PF["全 shape: planner 0 回<br/>issue から単一 task の plan を合成（plan#fable-skip、plan_iter=0）"]
    PF --> OUT["Implement へ"]
```

Plan phase は shape に依存しない。shape 判定は Evaluate の深さ・LITE gate・refloor のために残る。
合成 task の `file_changes` は空で始まり、Implement の返却 `files` を宣言として取り込む。

### 1.5 Implement

`dev-implement-fable`（plan+impl 統合）を単一 worktree に 1 spawn する。parallel fan-out・
issue 分割・integration branch は使わない。

```mermaid
flowchart TD
    IN["plan 確定"] --> I1["dev-implement-fable を 1 spawn<br/>impl:serial:issue-N"]
    I1 --> I3{"status"}
    I3 -->|OK| OUT["Validate へ"]
    I3 -->|BLOCKED| I4["累積 findings を付けて再 spawn<br/>reimpl-blocked#b / BLOCK_MAX"]
    I4 --> I3
    I3 -->|NEEDS_CONTEXT| I5["comprehensive 再分析"]
    I5 -->|"解消"| I1
    I5 -->|"解消不能"| NC["needs_clarification"]
```

### 1.6 Validate

```mermaid
flowchart TD
    IN["実装完了"] --> V1["test 実行"]
    V1 --> V2{"green ?"}
    V2 -->|no| V3["green-fix<br/>テスト弱体化は禁止"]
    V3 --> V1
    V2 -->|"yes / no_tests<br/>GREEN_MAX 到達"| V4{"empty-diff gate<br/>origin/BASE と一致 ?"}
    V4 -->|"差分あり"| OUT["Security floor へ"]
    V4 -->|"空 diff"| V5["cross-repo probe<br/>差し戻し 1 回"]
    V5 -->|"差分あり"| OUT
    V5 -->|"再度空"| AB["throw / abort"]
```

format / lint はこの phase の責務外で、test の結果だけを見る。
`GREEN_MAX` 到達時は red のまま次へ進むが、未解消の状態は merge tier が HOLD で受け止める。

### 1.7 Security floor

```mermaid
flowchart TD
    IN["test green"] --> C1["secfloor-classify.sh<br/>統合 exec-proxy・1 呼び出し"]
    C1 --> C2["refloorShape<br/>EFFECTIVE_SHAPE 確定"]
    C2 --> C3["format_only を count から除外"]
    C3 --> C4["ui-verify config<br/>UI touch 時のみ"]
    C4 --> C5{"runEval ?"}
    C5 -->|true| OUT["Evaluate へ"]
    C5 -->|false| SKIP["micro path<br/>evaluator 0 回"]

    C1 -.->|"risk 欠落・実行不能"| FC["fail-closed<br/>SEC 全 unchecked → HOLD"]
```

`secfloor-classify.sh` は risk（danger-grep）/ files（realized diff）/ struct（structural 分類）/
diffhash を 1 回で返す。フィールドごとに失敗セマンティクスが分かれており、**risk の欠落だけは
fail-closed** で SEC seed を全 unchecked にして merge tier を HOLD へ倒す（軸A invariant）。

`runEval` が true になる条件は次のいずれか。

- `EFFECTIVE_SHAPE` が micro 以外
- danger-grep hit / test-weakening 検出 / plan 宣言外の変更
- green-fix が発生した / dev-implement-fable が null を返して task を落とした / UI パスを touch した

### 1.8 Evaluate

```mermaid
flowchart TD
    IN["runEval=true"] --> E1["evaluator<br/>standard=1 パス / complex=EVAL_MAX"]
    E1 --> E2{"verdict"}
    E2 -->|"fail: design"| E3["dev-implement-fable へ fix_feedback 付きで再 spawn（reimpl#i）<br/>DESIGN_REPLAN_MAX で cap"]
    E3 --> E1
    E2 -->|"fail: impl"| E4["同じく reimpl#i<br/>未解消 critical を最優先"]
    E4 --> E1
    E2 -->|pass| OUT["PR へ"]
```

standard は 1 パスのみで差し戻さない。未解消の critical は merge tier の HOLD が担保する。

### 1.9 PR

```mermaid
flowchart TD
    IN["Evaluate 完了 / micro path"] --> R1["diff-hash 比較<br/>不一致なら stale-eval"]
    R1 --> R2["pr-artifacts で commit message / PR body 確定<br/>haiku が verbatim 転写 + git commit / push / gh pr create"]
    R2 --> R4{"LITE ?<br/>micro かつ runEval=false<br/>かつ danger clean"}
    R4 -->|yes| LITE["lite route<br/>pr-reviewer 1-pass → ci-check"]
    R4 -->|no| FULL["workflow: pr-iterate"]
    LITE -->|"clean かつ CI green"| OUT["Final reconcile へ"]
    LITE -->|"blocking finding<br/>CI 非 green"| FULL
    FULL --> OUT
```

nested 起動する `pr-iterate` には issue の acceptance criteria と
nested context（cwd / head_ref / repo / epoch）を渡す。

### 1.10 Final reconcile

```mermaid
flowchart TD
    IN["pr-iterate 終端"] --> F0{"fixes_applied が 1 以上 ?"}
    F0 -->|no| FSKIP["skipped<br/>agent 呼び出しゼロ"]
    F0 -->|yes| F1["worktree を PR 最終 HEAD へ ff-sync"]
    F1 --> F2["test suite 再実行"]
    F2 --> F3["changed-files-final で<br/>UI touch / 宣言外を再判定"]
    F3 --> F4["final AC reconcile"]
    FSKIP --> OUT["Merge tier へ"]
    F4 --> OUT
```

`changed-files-final` の結果は Merge tier へ持ち越され、同一 tree に対する再実行を skip する。

### 1.11 Merge tier

```mermaid
flowchart TD
    IN["Final reconcile 完了"] --> M0["merge-tier-facts<br/>(diff-hash / danger-grep / changed-files /<br/>gh pr view / head tree / gh pr checks を 1 spawn)"]
    M0 --> M1["danger 再 reconcile<br/>one-shot security clearance"]
    M1 --> M2["classifyMergeTier"]
    M2 --> M3["終端サマリを PR へ投稿"]
    M3 --> M4["journal telemetry 記録"]
    M4 --> HU["merge は常に人間"]
```

`merge-tier-facts` の diffhash が Security floor 時点の tree OID と一致すれば、facts の risk / changed
を使わず Security floor の結果を再利用する。tier の判定ロジックは [4. merge tier 判定](#4-merge-tier-判定) を参照。

---

## 2. shape 判定

shape は Analyze で `classifyShape` が決め、Implement 後に `refloorShape` が実 diff のファイル数で
再判定する。どちらも **raise-only** で、下げる経路は存在しない。入力が欠けていたり enum 外だったり
した場合は例外なく complex へ落ちる安全弁が効く。

```mermaid
flowchart TD
    START["analyze 結果 req"] --> F1{"estimated_change_file_count<br/>が数値 ?"}
    F1 -->|no| CX["floor = complex"]
    F1 -->|yes| F2{"acceptance_criteria<br/>が配列 ?"}
    F2 -->|no| CX
    F2 -->|yes| F3{"issue_type が<br/>feat/fix/docs/refactor/chore/test/perf/ci ?"}
    F3 -->|no| CX
    F3 -->|yes| F4{"breaking_change が true ?"}
    F4 -->|yes| CX
    F4 -->|no| F5{"count と AC 数"}
    F5 -->|"count ≤ 2 かつ AC ≤ 4"| MI["floor = micro"]
    F5 -->|"count ≤ 5 かつ AC ≤ 6"| ST["floor = standard"]
    F5 -->|"それ以外"| CX

    MI --> MG["mergeShape<br/>LLM 申告と floor の大きい方（raise-only）"]
    ST --> MG
    CX --> MG
    MG --> SHAPE["SHAPE 確定"]

    SHAPE --> IMPL["Implement 完了"]
    IMPL --> RF["refloorShape<br/>realized diff のファイル数で再判定<br/>宣言外・ephemeral・format_only は除外<br/>取得不能は complex 安全弁"]
    RF --> ES["EFFECTIVE_SHAPE（raise-only）"]
```

### 3 tier の経路差

| shape | Plan | Evaluate | merge tier |
| --- | --- | --- | --- |
| `micro` | issue から単一 task の plan を合成（`plan#fable-skip`、`plan_iter=0`）→ Implement で `dev-implement-fable` を 1 spawn | skip（evaluator 0 回）。danger-grep hit 時は security path で強制実行 | `AUTO`（docs・test-only + danger clean + 収束時のみ） |
| `standard` | 同上 | 1 パスのみ。差し戻しなし。未解消 critical は merge tier HOLD で担保 | `REVIEW` |
| `complex` | 同上 | 差し戻し loop（`EVAL_MAX` 上限、design 差し戻しは `DESIGN_REPLAN_MAX` まで。差し戻し先は同じ `dev-implement-fable`） | `REVIEW` / `HOLD`（danger・breaking 検出時） |

micro のうち `runEval=false` かつ danger clean のものだけが PR phase で **lite route** に入り、
pr-reviewer 1-pass と CI green だけで終端する。blocking finding か CI 非 green を検出した時点で
通常の pr-iterate へ自動昇格する。

---

## 3. pr-iterate ループ

`pr-iterate` は dev-flow から入れ子で呼ばれるほか、単体でも起動できる。approve が出ても
CI gate を通らなければ LGTM にならず、**CI pending を成功扱いすることは決してない**。
同じ topic が `REVIEW_STUCK` 回繰り返された時点で stuck と判定して人間へ渡す。

```mermaid
flowchart TD
    IN["pr-iterate PR 番号<br/>MAX / REVIEW_STUCK<br/>nested 起動時は pr-meta / isolation-cleanup を skip<br/>（isolation probe 本体は不変で実行）"] --> LOOP["iteration i"]
    LOOP --> REV["pr-reviewer が実 diff を宣言意図に照合<br/>issue の acceptance criteria も判定に含める"]
    REV --> D{"decision"}

    D -->|approve| CI["ci-check 1 spawn = 1 判定<br/>gh pr checks → check-ci.sh<br/>pending なら script 側 ci-wait ループ（上限 CI_WAIT_CEILING_SECONDS）"]
    D -->|"request_changes / comment"| BL{"blocking findings あり ?"}

    CI --> CS{"status"}
    CS -->|"passed / no_checks"| LGTM["status: lgtm"]
    CS -->|error| ERR["status: ci_error<br/>gh API 失敗（auth / network）"]
    CS -->|pending| PEND["status: ci_pending<br/>ceiling 到達・never auto-approve"]
    CS -->|failed| CIF["CI failure を findings 化"]

    CIF --> STK1{"同一 topic が反復 ?"}
    STK1 -->|yes| STUCK["status: stuck"]
    STK1 -->|no| FIX

    BL -->|no| CI
    BL -->|yes| STK2{"同一 topic が反復 ?"}
    STK2 -->|yes| STUCK
    STK2 -->|no| FIX["fix agent が修正適用"]

    FIX --> AP{"applied が true ?"}
    AP -->|no| FF["status: fix_failed"]
    AP -->|yes| CM{"ensureFixCommitted<br/>commit + push 成功 ?"}
    CM -->|no| FF
    CM -->|yes| NEXT{"i が MAX 未満 ?"}
    NEXT -->|yes| LOOP
    NEXT -->|no| MAXR["status: max_reached"]
```

### 終端 status

| status | 意味 | dev-flow 側の扱い |
| --- | --- | --- |
| `lgtm` | review clean かつ CI passed / no_checks | Final reconcile へ。`fixes_applied` が 1 以上なら最終 tree を再検証 |
| `stuck` | 同一 topic が反復（review / CI failure） | merge tier `HOLD` |
| `fix_failed` | fix 未適用、または commit / push の保証に失敗 | merge tier `HOLD` |
| `max_reached` | `MAX` iteration で収束せず | merge tier `HOLD` |
| `ci_error` | gh API 失敗（auth / network） | merge tier `HOLD` |
| `ci_pending` | checks 未完了。自動承認しない | merge tier `HOLD` |

---

## 4. merge tier 判定

`classifyMergeTier` は純関数で、HOLD 理由の配列が空でなければ無条件に HOLD を返す。
AUTO は micro かつ docs/test-only かつすべての HOLD 条件が不成立のときだけで、それでも
「推奨ラベル」であり **merge 操作そのものは人間が行う**。

```mermaid
flowchart TD
    IN["classifyMergeTier の入力<br/>ledger / danger / AC / iterate status / mergeable ほか"] --> H{"HOLD 理由が<br/>1 つでも成立 ?<br/>（下表 10 条件）"}

    H -->|"1 つでも成立"| HOLD["HOLD<br/>人間 review 必須"]
    H -->|"すべて不成立"| A{"shape が micro かつ<br/>docs / test-only ?"}
    A -->|yes| AUTO["AUTO<br/>推奨ラベル<br/>micro eval skip なら AC 未検証を開示"]
    A -->|no| REVIEW["REVIEW<br/>標準 — 人間が LGTM"]

    HOLD --> D["開示行を reasons に追記<br/>tier 判定値は不変"]
    AUTO --> D
    REVIEW --> D
    D --> M["merge 操作は常に人間<br/>全 tier 共通の不変条件"]
```

### HOLD 理由（1 つでも成立すれば HOLD）

| # | 条件 | 備考 |
| --- | --- | --- |
| 1 | ledger 未収束（未 checked の blocking item が残る） | |
| 2 | danger-grep hit 未解消 / 実行不能 | 実行不能は fail-closed |
| 3 | `breaking_change=true`（構造化判定） | keyword 単独 hit は不採用 |
| 4 | ESCALATE-TO-HUMAN 項目あり | |
| 5 | AC 未達 / Final AC reconcile 判定不能 | |
| 6 | Final reconcile 再検証不能 / final test red | |
| 7 | pr-iterate が `lgtm` 以外で終端 | |
| 8 | `eval_staleness = hash_mismatch` | 評価済み tree と merge 対象 tree の乖離 |
| 9 | test-weakening 未クリア | |
| 10 | base branch と conflict（`CONFLICTING` / `DIRTY`） | `UNKNOWN` は fail-open |

### gate_policy に依らず常に blocking

軸A invariant により、以下は `gate_policy` の設定に関係なく blocking のまま。

| 理由 | なぜ緩めないか |
| --- | --- |
| AC 未達 | `acceptance_criteria` が `satisfied:false` |
| Final AC reconcile 判定不能 | agent null / schema 不一致 / evidence 不足 |
| pr-iterate 非 LGTM 終端 | review ⇄ fix loop が LGTM 未到達 |
| `eval_staleness = hash_mismatch` | 評価済み tree と merge 対象 tree の乖離 |
| base branch conflict | `mergeStateStatus=DIRTY` / `mergeable=CONFLICTING` |
| danger-grep 実行不能 | security 未検証のまま出荷しない fail-closed |

`mergeable` が `UNKNOWN` の場合や proxy 失敗は fail-open で、definitive な `CONFLICTING` / `DIRTY` の
ときだけ HOLD する。breaking の keyword scan 単独ヒットは HOLD 理由に採用せず、構造化判定
`breaking_change=true` と組み合わさったときだけ blocking になる（単独ヒットは可視化のみ）。
evaluator が `verdict=fail` のまま PR へ進んだ run も同じ扱いで、開示行だけが reasons に入り
tier は動かない。

---

## 5. 定数と担当 agent

### ループ上限

<!-- atlas:loop-constants:begin -->

| 定数 | 値 | 効く場所 |
| --- | --- | --- |
| `EVAL_MAX` | 10 | complex の evaluate 差し戻しループ |
| `EVAL_STUCK` | 2 | 同一 topic 反復での design churn 打ち切り |
| `DESIGN_REPLAN_MAX` | 2 | design 差し戻し（replan + reimpl）の hard cap |
| `GREEN_MAX` | 3 | Validate の test green 差し戻し |
| `BLOCK_MAX` | 2 | BLOCKED 由来の再計画 |
| `AMBIGUITY_MAX` | 2 | 超過で needs_clarification |
| `REVIEW_STUCK` | 2 | pr-iterate の同一 topic 反復での stuck 判定 |
| `CI_WAIT_CEILING_SECONDS` | 300 | pr-iterate の CI pending 待ち（script 側 ci-wait ループ）の nominal 総待機上限（秒） |

<!-- atlas:loop-constants:end -->

この表の値は `plugins/dev-flow/_lib/atlas-constants.test.mjs` が実装ソースと照合する。
ソース側の定数を変えたらこの表も更新しないと CI が落ちる。

pr-iterate の `MAX`（review ⇄ fix 反復、既定 10）は `args.max_iterations` で上書きできるため
上表には含めない。

### subagent の役割分担

| agent | 役割 | model / effort |
| --- | --- | --- |
| `dev-implement-fable` | plan+impl 統合実装（全 shape の唯一の実装 agent。Implement・BLOCKED 再実装・green-fix・evaluator 差し戻しを担う） | fable / high |
| `evaluator` | 実装品質ゲート | `QUALITY_MODEL` / high |
| `pr-reviewer` | PR レビュー | `QUALITY_MODEL` / high |
| `dev-runner` | Skill 呼び出し（analyze / commit / PR） | frontmatter / high |
| `dev-runner-haiku` | 書き込み・Skill 呼び出しを伴う exec-proxy | haiku / low |
| `dev-runner-haiku-ro` | read-only exec-proxy | haiku / low |
| `dev-runner-haiku-wo` | isolation probe 専任（Write のみ） | haiku / low |

model は subagent の frontmatter を既定としつつ `agent()` の `opts.model` で per-call override する。
品質ゲート系 4 agent の model だけは `plugins/dev-flow/_lib/quality-model.mjs` の `QUALITY_MODEL` 定数で一括指定し、
`tools/sync-inlines.mjs` が workflow へ inline 生成する。

effort は subagent の frontmatter で固定している。harness 同梱の `workflow-authoring` リファレンスは
`agent()` の opts に `effort` を記載しているが、**本 harness で実際に適用されるかは未検証**である
（受理と適用は別物で、effort は subagent 側から観測できない）。`dev-flow-canary` の
`agent_opts_effort_accepted` probe で受理可否だけを測り、その結果を根拠に再判定する。

---

## 補足

dev-flow は Workflow に依存するため **Claude 専用**で、cross-vendor portability を放棄する
唯一の例外扱いである。

本ドキュメントは実装ソースから起こした図であり、仕様書ではない。
dev-flow 本体（`plugins/dev-flow/.claude/workflows/` / `plugins/dev-flow/.claude/agents/` /
`plugins/dev-flow/_lib/` / `tools/`）を変更したら、
この図も同じ PR で更新すること。変更の経緯は git log を参照。
