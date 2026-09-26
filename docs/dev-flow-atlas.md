# i dev-flow Pipeline Atlas

GitHub issue から LGTM までを 8 phase で駆動する `dev-flow` の実処理を図で示す。
すべて実装ソース（`plugins/dev-flow/.claude/workflows/dev-flow.js` /
`plugins/dev-flow/.claude/workflows/pr-iterate.js` /
`.claude/rules/dev-flow.md`）から起こしたもので、要約や理想形ではない。

規約・設計判断の正典は [`.claude/rules/dev-flow.md`](../.claude/rules/dev-flow.md)。
本ドキュメントはその視覚的な索引であり、両者が食い違う場合は rules 側が正しい。

## 不変条件

どのモデル世代でも緩めない。

- **merge は常に人間。** LGTM 後にユーザーが merge する。AUTO tier も「推奨ラベル」であって
  自動 merge ではない。全 tier で例外なし
- **1 issue = 1 PR。** Implement は全 shape で `dev-implement-fable` を単一 worktree に 1 spawn する
  （parallel fan-out は持たない）。issue 分割も integration branch も使わない
- **軸A invariant。** 決定論オラクル・security floor・critical アイテムはどの `gate_policy` でも
  blocking。policy で緩めない
- **後方互換 scaffolding を作らない。** enum 外の値は legacy fallback ではなく明示 error にする

---

## 1. パイプライン全体

wrapper skill が worktree を用意して `EnterWorktree` した上で、dynamic workflow `dev-flow-run` を
起動する。phase 遷移とループは workflow script が JS で保持し、中間 state は外部 JSON ではなく
script 変数に持つ。

まず概観を示し、続いて 8 phase を 1 phase 1 節で展開する。

### 1.1 概観

```mermaid
flowchart TD
    U["/dev-flow ISSUE"] --> PF["wrapper preflight<br/>dev-flow-prerun（base → worktree → clean → deps ‖ analyze → stack）<br/>→ EnterWorktree"]
    PF --> W["Workflow: dev-flow-run<br/>args.setup = prerun の JSON"]
    W --> S["1. Setup"]
    S --> I["2. Implement"]
    I --> V["3. Validate"]
    V --> SF["4. Security floor"]
    SF --> E["5. Evaluate"]
    E --> R["6. PR"]
    R --> FR["7. Final reconcile"]
    FR --> MT["8. Merge tier"]
    MT --> HU["merge は常に人間"]

    S -.->|"fail-closed"| AB["throw / workflow abort"]
    V -.->|"空 diff が 2 回連続"| AB
    S -.->|"analyze ゲート（Setup 末尾）:<br/>prerun analyze 失敗 / AC 空 /<br/>comment 矛盾 / Jev 未確定"| NC["needs_clarification<br/>worktree は保持"]
    I -.->|"NEEDS_CONTEXT"| NC
    SF -.->|"risk 欠落・実行不能"| FC["fail-closed<br/>merge tier HOLD 強制"]
```

破線は正常系から外れる経路。`needs_clarification` は worktree を保持したまま返るので、
人間が確認して `dev-flow-prerun` から再起動すれば同じ worktree が再利用される（`setup` は
再取得する — 前回の epoch を使い回すと isolation probe のファイル名が衝突して abort する）。

### 1.2 Setup

決定論処理（base 解決・worktree 作成/再利用と起点検証・`.devflow-tmp` clean・deps install・
issue analyze・stack 検出）は run 前に wrapper skill が top-level の Bash 1 コマンド
`dev-flow-prerun` で済ませ、その stdout JSON を `args.setup` として渡す。analyze 段
（`prerun-analyze.sh`: `analyze-issue --contract` の決定論 parse + Jev 有界判定）は deps install と
並列に走る。Setup phase の spawn は末尾の analyze ゲート判定後の 1 本だけ（通常経路は isolation probe、
ゲートが引いたときは analyze-clarify）。

```mermaid
flowchart TD
    PR["wrapper: dev-flow-prerun<br/>base → worktree → clean → deps ‖ analyze → stack<br/>JSON 1 行を args.setup へ"] --> IN["Workflow 起動"]
    IN --> S1["validatePrerunSetup(args.setup)<br/>純関数・spawn なし"]
    S1 --> OUT["Setup 末尾の analyze ゲートへ（下図）"]

    PR -.->|"ok:false"| STOP["wrapper が停止し人間へ報告"]
    S1 -.->|"setup 欠落 / ok:false<br/>必須キー欠落"| AB["throw / abort"]
```

`dev-flow-prerun` の各段は独立に `ok:false` を報告し後続段を巻き込まない。base は明示指定なら
origin に存在するか検証、未指定なら `origin/dev` → `origin/HEAD` の順。既存 worktree は upstream が
`origin/BASE` と一致するか検証する。`args.setup` が無い・`ok:false`・必須キー欠落は workflow が
即 throw し、workflow 内 proxy への fallback は置かない（後方互換 scaffolding 禁止）。
worktree は repo 内 `.claude/worktrees/df-N` を優先し、書き込めない
（`worktree_status:"unwritable"`）場合のみ wrapper が repo 外 `repo-wt/df-N` で prerun を再実行する。
isolation probe は wrapper で代替しない — subagent の Write 経路が通ることの検証であり、
top-level の Bash では意味が変わる。

**Setup 末尾: analyze ゲート**

```mermaid
flowchart TD
    PA["prerun（deps と並列）: prerun-analyze.sh<br/>analyze-issue --contract → 決定論 parse<br/>breaking keyword hit → Jev noul<br/>comments present → comment ごとに Jev choice"] --> IN["args.setup.analyze"]
    IN --> A0{"analyze.ok ?"}
    A0 -->|no| NC["needs_clarification<br/>source=analyze_prerun<br/>spawn 0"]
    A0 -->|yes| A1["buildReqFromContract<br/>whitelist 検証 → REQ"]
    A1 -->|"不合格"| AB["throw（prerun 出力の契約違反）"]
    A1 --> A2{"AC 空 / comment_conflicts 非空 /<br/>uncertain 非空 ?"}
    A2 -->|yes| A3["analyze-clarify（dev-runner）1 spawn<br/>人間向け missing_context を生成"]
    A3 --> NC2["needs_clarification<br/>source=analyze<br/>isolation-probe / fable は spawn しない"]
    A2 -->|no| A4["isolation probe<br/>Write tool で書けるか<br/>token = setup.epoch"]
    A4 -->|"written:false"| AB
    A4 --> OUT["Implement へ"]
```

analyze ゲートは Workflow 内では純関数の検証と 3 条件ゲートだけで、ゲート自体の spawn は 0。
issue を LLM が転写する工程が無いので provenance 突合・comment_count 突合・scope 切断時の
再実行も無い。決定論で解けない 2 理由だけを prerun が Jev（有界判定モデル、`_shared/scripts/jev-classify.sh`）に回す:
breaking keyword hit は noul 2 問（後方互換を保たない API / 形式の変更か・既存データの変換を要するか。
古い値を読み込み時に捨てるだけなら両方 no。どちらかが p ≥ 0.9 で `breaking_change=true`、両方 p ≤ 0.1 で
false、それ以外は `uncertain`）、comments present は comment ごとに choice
`{override, conflict, resolved, unrelated}`（state に issue の updated_at と最新 comment の created_at を載せる。
override かつ権限あり = issue 報告者本人 or OWNER/MEMBER/COLLABORATOR → `comment_overrides`、
override だが権限なし / conflict / 低確信 → `comment_conflicts`、本文で決着済みの resolved は無視）。Jev の応答なし・
`DEVFLOW_JEV_DISABLE=1` は `uncertain` に倒す（fail-closed。応答なしは jev-classify の `--reason-file` が返す
原因 — jev-broker に接続できない / jev-broker 経由の失敗 / 鍵なし / Keychain に届かない / Keychain 読み取り失敗 /
タイムアウト / 通信失敗 / 応答不正 — を文言に載せる）。ゲートが引いたときだけ sonnet を
1 spawn して人間向けの質問文を作る。telemetry の `analyze_path` は `contract` / `jev` /
`sonnet`（ゲート後のみ）の 3 値。

### 1.3 Implement

Setup 末尾の analyze ゲート直後に issue から単一 task の plan を合成する（planner 0 回、`implement#synth-plan`。
shape はこの時点では決まっていない — Security floor で realized diff から決める）。
合成 task の `file_changes` は空で始まり、Implement の返却 `files` を宣言として取り込む。

`dev-implement-fable`（plan+impl 統合、frontmatter opus）を単一 worktree に 1 spawn する。parallel fan-out・
issue 分割・integration branch は使わない。

```mermaid
flowchart TD
    IN["plan 確定"] --> I1["dev-implement-fable を 1 spawn<br/>impl:serial:issue-N"]
    I1 --> I3{"status"}
    I3 -->|OK| OUT["Validate へ"]
    I3 -->|BLOCKED| I4["累積 findings を付けて再 spawn<br/>reimpl-blocked#b / BLOCK_MAX"]
    I4 --> I3
    I3 -->|NEEDS_CONTEXT| NC["needs_clarification<br/>source=implement（再分析はしない）"]
```

### 1.4 Validate

```mermaid
flowchart TD
    IN["実装完了"] --> V1["test 実行"]
    V1 --> V2{"green ?"}
    V2 -->|no| V3["green-fix（sonnet）<br/>テスト弱体化は禁止"]
    V3 --> V1
    V2 -->|"yes / no_tests<br/>GREEN_MAX 到達"| V4{"empty-diff gate<br/>origin/BASE と一致 ?"}
    V4 -->|"差分あり"| OUT["Security floor へ"]
    V4 -->|"空 diff"| V5["cross-repo probe<br/>差し戻し 1 回"]
    V5 -->|"差分あり"| OUT
    V5 -->|"再度空"| AB["throw / abort"]
```

format / lint はこの phase の責務外で、test の結果だけを見る。
`GREEN_MAX` 到達時は red のまま次へ進むが、未解消の状態は merge tier が HOLD で受け止める。

### 1.5 Security floor

```mermaid
flowchart TD
    IN["test green"] --> C1["secfloor-classify.sh<br/>統合 exec-proxy・1 呼び出し"]
    C1 --> C2["ephemeral・宣言外・format_only を count から除外"]
    C2 --> C3["classifyShape(req, realizedCount)<br/>EFFECTIVE_SHAPE 確定"]
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

### 1.6 Evaluate

```mermaid
flowchart TD
    IN["runEval=true"] --> E1["evaluator<br/>standard=1 パス / complex=EVAL_MAX"]
    E1 --> E2{"verdict"}
    E2 -->|"fail: design"| E3["dev-implement-fable へ fix_feedback 付きで再 spawn（reimpl#i）<br/>DESIGN_REPLAN_MAX で cap"]
    E3 --> E1
    E2 -->|"fail: impl"| E4["同じく reimpl#i<br/>未解消 critical を最優先"]
    E4 --> E1
    E2 -->|pass| P0{"reimpl#i が 1 回以上 ?"}
    P0 -->|no| OUT["PR へ"]
    P0 -->|yes| P1["test#post-eval-i（フルテスト 1 回）<br/>red → green-fix#post-eval-i / GREEN_MAX"]
    P1 --> OUT
```

standard は 1 パスのみで差し戻さない。未解消の critical は merge tier の HOLD が担保する。
reimpl が 1 回以上走った run だけ、PR 前にフルテストを再実行する（Evaluate 内は AC ごとの redgreen-verify しか
走らず、reimpl が AC 対象外のテストを壊しても Validate では捕まらないため）。red は Validate と同じ green-fix
ループ（`tests:'error'` は green-fix しない）。ここでの green-fix は evaluator が再評価しないので、
Evaluate 時点から tree が変わったことによる `eval_staleness=hash_mismatch` の HOLD（差分ファイル一覧つき）で
テスト弱体化の監査を人間に委ねる。reimpl 0 回の run は spawn しない。

### 1.7 PR

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

### 1.8 Final reconcile

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

### 1.9 Merge tier

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

shape は Setup 末尾の analyze ゲートでは決めない。Implement 後の Security floor で `classifyShape(req, realizedCount)` が
realized diff のファイル数（ephemeral・宣言外・format_only を除外した数）と issue 由来の決定論特徴量
（AC 数 / `issue_type` / 構造化 `breaking_change`）だけで **1 回で** 決め、その返り値が `EFFECTIVE_SHAPE`
になる。LLM の事前見積もりは入力にならない。入力が欠けていたり（realized count 取得不能）enum 外だったり
した場合は例外なく complex へ落ちる安全弁が効く。micro の LITE 経路に対する意味的リスクの安全網は
runEval 強制条件（danger-grep / testsurf / green-fix / dropped task / 宣言外変更 / UI 接触）が担う。

```mermaid
flowchart TD
    START["Security floor: req + realized diff"] --> F1{"realized file count<br/>が有限の数値 ?"}
    F1 -->|"no（取得不能 NaN）"| CX["shape = complex"]
    F1 -->|yes| F2{"acceptance_criteria<br/>が配列 ?"}
    F2 -->|no| CX
    F2 -->|yes| F3{"issue_type が<br/>feat/fix/docs/refactor/chore/test/perf/ci ?"}
    F3 -->|no| CX
    F3 -->|yes| F4{"breaking_change が true ?"}
    F4 -->|yes| CX
    F4 -->|no| F5{"realized count と AC 数"}
    F5 -->|"count ≤ 2 かつ AC ≤ 4"| MI["shape = micro"]
    F5 -->|"count ≤ 5 かつ AC ≤ 6"| ST["shape = standard"]
    F5 -->|"それ以外"| CX

    MI --> ES["EFFECTIVE_SHAPE 確定"]
    ST --> ES
    CX --> ES
```

### 3 tier の経路差

| shape | Implement | Evaluate | merge tier |
| --- | --- | --- | --- |
| `micro` | Setup 末尾の analyze ゲート直後に issue から単一 task の plan を合成（`implement#synth-plan`）→ Implement で `dev-implement-fable` を 1 spawn | skip（evaluator 0 回）。danger-grep hit 時は security path で強制実行 | `AUTO`（docs・test-only + danger clean + 収束時のみ） |
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
| `GREEN_MAX` | 3 | Validate と Evaluate 差し戻し後の PR 前再テストの test green 差し戻し |
| `BLOCK_MAX` | 2 | BLOCKED 由来の再計画 |
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
| `dev-implement-fable` | plan+impl 統合実装（全 shape の唯一の実装 agent。Implement・BLOCKED 再実装・green-fix・evaluator 差し戻しを担う） | opus / high |
| `evaluator` | 実装品質ゲート | opus / medium |
| `pr-reviewer` | PR レビュー | opus / high |
| `dev-runner` | Skill 呼び出し（analyze ゲート（Setup 末尾）後の missing_context 生成のみ。通常経路では起動しない） | frontmatter / high |
| `dev-runner-haiku` | 書き込み・Skill 呼び出しを伴う exec-proxy | haiku / low |
| `dev-runner-haiku-ro` | read-only exec-proxy | haiku / low |
| `dev-runner-haiku-wo` | isolation probe 専任（Write のみ） | haiku / low |

model は subagent の frontmatter で決める。dev-flow / pr-iterate の call site は `opts.model` を渡さない
（evaluator / pr-reviewer の model を変えるなら `agents/*.md` の frontmatter を変える）。`opts.model` を渡すのは
dev-improve の `rank-judge` のみで、`plugins/dev-flow/_lib/quality-model.mjs` の `QUALITY_MODEL` 定数を
`tools/sync-inlines.mjs` が dev-improve.js へ inline 生成する。

effort は原則 subagent の frontmatter で決める。`agent()` の `opts.effort` は frontmatter より優先して
実効値に反映される（transcript で確認済み。`dev-flow-canary` の `agent_opts_effort_accepted` probe は
受理可否だけを測る）。opts で effort を渡すのは pr-iterate の fix（`fix#i` / `fix#i-retry`）のみで、
`dev-runner`（frontmatter high）を `FIX_EFFORT = 'medium'` で起動する。

---

## 補足

dev-flow は Workflow に依存するため **Claude 専用**で、cross-vendor portability を放棄する
唯一の例外扱いである。

本ドキュメントは実装ソースから起こした図であり、仕様書ではない。
dev-flow 本体（`plugins/dev-flow/.claude/workflows/` / `plugins/dev-flow/.claude/agents/` /
`plugins/dev-flow/_lib/` / `tools/`）を変更したら、
この図も同じ PR で更新すること。変更の経緯は git log を参照。
