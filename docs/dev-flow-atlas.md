# dev-flow Pipeline Atlas

GitHub issue から LGTM までを 10 phase で駆動する `dev-flow` の実処理を図で示す。
すべて実装ソース（`.claude/workflows/dev-flow.js` / `.claude/workflows/pr-iterate.js` /
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

### 1.1 概観

```mermaid
flowchart TD
    U["/dev-flow ISSUE"] --> PF["wrapper preflight<br/>base 解決 → worktree add/再利用 → EnterWorktree"]
    PF --> W["Workflow: dev-flow-run"]

    W --> S["1. Setup<br/>base 解決 / worktree / isolation probe / deps"]
    S --> A["2. Analyze<br/>要件・AC 抽出 → classifyShape"]
    A --> P["3. Plan<br/>shape 別に plan ⇄ plan-reviewer"]
    P --> I["4. Implement<br/>parallel → serial"]
    I --> V["5. Validate<br/>test green + empty-diff gate"]
    V --> SF["6. Security floor<br/>danger-grep / refloor / runEval 判定"]
    SF --> E["7. Evaluate<br/>micro path は skip"]
    E --> R["8. PR<br/>commit → PR → lite / full 分岐"]
    R --> FR["9. Final reconcile<br/>fixes_applied が 1 以上のときのみ"]
    FR --> MT["10. Merge tier<br/>HOLD / REVIEW / AUTO"]
    MT --> HU["merge は常に人間"]

    S -.->|"base 解決不能 / 起点不一致 / probe written:false"| AB["throw<br/>workflow abort"]
    V -.->|"空 diff が 2 回連続"| AB
    A -.->|"AC 空 / 曖昧 / provenance 不合格"| NC["status: needs_clarification<br/>worktree は保持"]
    I -.->|"NEEDS_CONTEXT 解消不能"| NC
    SF -.->|"risk 欠落・実行不能"| FC["fail-closed<br/>merge tier HOLD 強制"]
```

破線は正常系から外れる経路。`needs_clarification` は worktree を保持したまま返るので、
人間が確認して再起動すれば同じ worktree が再利用される。

### 1.2 Setup / Analyze / Plan

Setup のゲート（base 解決・worktree 起点検証・isolation probe）はいずれも fail-closed で、
通らなければ run 自体が中断する。前 2 つは `setup-base` という単一 probe に統合されており、
1 回の exec-proxy 応答を `resolveBase` と `checkWorktreeBase` がそれぞれ自分のフィールドだけ読む。

```mermaid
flowchart TD
    WF["Workflow: dev-flow-run"] --> SETUP

    subgraph SETUP["Phase: Setup"]
        S1["setup-base（統合 probe・1 呼び出し）<br/>A: base 解決（明示→origin 検証 / 未指定→origin/dev→origin/HEAD）<br/>B: 既存 worktree の upstream が origin/BASE と一致するか<br/>C: epoch（clock start mark を給電・省略可）"]
        S3["worktree 作成/再利用<br/>repo 内 .claude/worktrees/df-N → 不可なら repo 外 repo-wt/df-N"]
        S4["isolation cleanup<br/>.devflow-tmp を git clean（fail-open）"]
        S5["isolation probe<br/>dev-runner-haiku-wo が Write tool で書けるか"]
        S6["deps install（fail-open）"]
        S1 --> S3 --> S4 --> S5 --> S6
    end

    S1 -.->|"base 解決不能 / worktree 起点不一致"| ABORT["throw / workflow abort"]
    S5 -.->|"written:false"| ABORT

    SETUP --> ANA

    subgraph ANA["Phase: Analyze"]
        A0{"DEPTH が standard ?"}
        A1["contract probe<br/>analyze-issue.sh --contract を決定論 parse"]
        A2["analyze（dev-runner）<br/>要件・AC・issue_type・見積ファイル数・breaking"]
        A3{"provenance 検証 OK ?"}
        A4{"AC 空 or ambiguities が 2 超 ?"}
        A5["classifyShape<br/>micro / standard / complex + safety floor"]
        A0 -->|yes| A1
        A0 -->|no| A2
        A1 -->|"ok かつ whitelist 合格"| A3
        A1 -->|"失敗（fail-open）"| A2
        A2 --> A3
        A3 -->|no| NC["status: needs_clarification<br/>worktree は保持"]
        A3 -->|yes| A4
        A4 -->|yes| NC
        A4 -->|no| A5
    end

    ANA --> PLAN

    subgraph PLAN["Phase: Plan"]
        P0{"shape"}
        P1["plan 1 発<br/>plan-reviewer 0 回（triviality gate）"]
        P2["plan 1 発<br/>plan-reviewer 0 回"]
        P3["dev-planner ⇄ plan-reviewer ループ<br/>PLAN_MAX / PLAN_STUCK で early-cutoff"]
        P0 -->|micro| P1
        P0 -->|standard| P2
        P0 -->|complex| P3
    end
```

### 1.3 Implement / Validate / Security floor / Evaluate

Implement は **parallel を先に fan-out してから serial** を流す。`parallel` に置けるのは
file_changes が互いに disjoint な task のみで、plan-reviewer が検証する。

```mermaid
flowchart TD
    subgraph IMP["Phase: Implement"]
        I1["parallel task を fan-out<br/>file_changes は disjoint / 単一 worktree"]
        I2["serial task を直列実行（依存あり）"]
        I3{"status"}
        I1 --> I2 --> I3
        I3 -->|BLOCKED| I4["別アプローチで再計画<br/>BLOCK_MAX"] --> I1
        I3 -->|NEEDS_CONTEXT| I5["comprehensive 再分析 → 再試行"]
        I5 -->|"解消不能"| NC["status: needs_clarification"]
    end

    IMP --> VAL

    subgraph VAL["Phase: Validate"]
        V1["test 実行（dev-runner-haiku）"]
        V2{"green ?"}
        V3["green-fix（implementer）<br/>テスト弱体化は禁止"]
        V4["empty-diff gate<br/>working tree が origin/BASE と一致か"]
        V1 --> V2
        V2 -->|no| V3 --> V1
        V2 -->|"yes / no_tests / GREEN_MAX 到達"| V4
        V4 -->|"空 diff"| V5["cross-repo probe → 差し戻し 1 回<br/>再度空なら throw"]
    end

    VAL --> SEC

    subgraph SEC["Phase: Security floor"]
        C1["secfloor-classify.sh（統合 exec-proxy・1 呼び出し）<br/>risk / files / struct / diffhash を一括取得<br/>label は danger-grep 据え置き（telemetry 連続性）"]
        C2["refloorShape（files）<br/>raise-only で EFFECTIVE_SHAPE 確定"]
        C3["format_only を count から除外（struct）"]
        C4["ui-verify config（UI パス touch 時のみ・別 proxy）"]
        C5{"runEval ?<br/>EFFECTIVE_SHAPE が micro 以外<br/>or danger hit / testsurf / 宣言外変更<br/>/ green-fix / implementer drop / UI touch"}
        C1 --> C2 --> C3 --> C4 --> C5
        C1 -.->|"risk 欠落・実行不能"| CFC["fail-closed<br/>SEC seed を全 unchecked → merge tier HOLD"]
    end

    C5 -->|false| PRP["micro path: Evaluate skip<br/>evaluator 0 回"]
    C5 -->|true| EVAL

    subgraph EVAL["Phase: Evaluate"]
        E1["evaluator<br/>standard は 1 パス / complex は EVAL_MAX まで"]
        E2{"verdict"}
        E3["design 差し戻し: replan + reimpl<br/>DESIGN_REPLAN_MAX"]
        E4["impl fix（implementer）<br/>未解消 critical を最優先"]
        E5["Evaluate 完了<br/>AC evidence と未解消 critical を merge tier へ引き渡す"]
        E1 --> E2
        E2 -->|"fail: design"| E3 --> E1
        E2 -->|"fail: impl"| E4 --> E1
        E2 -->|pass| E5
    end

    EVAL --> PRP
```

### 1.4 PR / pr-iterate / Final reconcile / Merge tier

```mermaid
flowchart TD
    PRP["Evaluate 完了 / micro path"] --> PR

    subgraph PR["Phase: PR"]
        R1["diff-hash 比較<br/>Evaluate 時点と不一致なら stale-eval"]
        R2["git-commit → git-pr（dev-runner）"]
        R4{"LITE ?<br/>micro かつ runEval=false かつ danger clean"}
        R1 --> R2 --> R4
    end

    R4 -->|yes| LITE["lite route<br/>pr-reviewer 1-pass → ci-check"]
    R4 -->|no| FULL["workflow: pr-iterate<br/>review ⇄ fix ループ<br/>AC と nested context（cwd / head_ref / repo / epoch）を渡す"]
    LITE -->|"clean かつ CI passed / no_checks"| LGTM["status: lgtm<br/>fixes_applied=0"]
    LITE -->|"blocking finding or CI not green"| FULL
    FULL --> LGTM2["status + fixes_applied"]

    LGTM --> FR
    LGTM2 --> FR

    subgraph FR["Phase: Final reconcile"]
        F0{"fixes_applied が 1 以上 ?"}
        F1["worktree を PR 最終 HEAD へ ff-sync"]
        F2["test suite 再実行"]
        F3["changed-files-final で UI touch / 宣言外を再判定<br/>必要時 ui-verify 再実行<br/>結果は Merge tier へ持ち越して再実行を skip"]
        F4["final AC reconcile"]
        F0 -->|no| FSKIP["skipped（agent 呼び出しゼロ）"]
        F0 -->|yes| F1 --> F2 --> F3 --> F4
    end

    FR --> MT

    subgraph MT["Phase: Merge tier"]
        M0["diff-hash-merge<br/>Security floor の tree OID と一致すれば<br/>danger-grep-final / changed-files を skip"]
        M1["gh pr view で mergeable / mergeStateStatus"]
        M2["classifyMergeTier"]
        M3["終端サマリを PR へ投稿<br/>応答の epoch が clock end mark を給電"]
        M4["journal telemetry 記録"]
        M0 --> M1 --> M2 --> M3 --> M4
    end

    MT --> HUMAN["merge は常に人間<br/>全 tier で例外なし"]
```

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
| `micro` | plan 1 発・plan-reviewer 0 回（triviality gate で review loop を skip） | skip（evaluator 0 回）。danger-grep hit 時は security path で強制実行 | `AUTO`（docs・test-only + danger clean + 収束時のみ） |
| `standard` | plan 1 発・plan-reviewer 0 回 | 1 パスのみ。差し戻しなし。未解消 critical は merge tier HOLD で担保 | `REVIEW` |
| `complex` | dev-planner ⇄ plan-reviewer loop（`PLAN_MAX` 上限、topic-stuck で early-cutoff） | 差し戻し loop（`EVAL_MAX` 上限、design 差し戻しは `DESIGN_REPLAN_MAX` まで） | `REVIEW` / `HOLD`（danger・breaking 検出時） |

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

    D -->|approve| CI["ci-check<br/>gh pr checks → check-ci.sh でポーリング"]
    D -->|"request_changes / comment"| BL{"blocking findings あり ?"}

    CI --> CS{"status"}
    CS -->|"passed / no_checks"| LGTM["status: lgtm"]
    CS -->|error| ERR["status: ci_error<br/>gh API 失敗（auth / network）"]
    CS -->|pending| PEND["status: ci_pending<br/>never auto-approve"]
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
| `PLAN_MAX` | 8 | complex の plan ⇄ review ループ |
| `PLAN_STUCK` | 2 | 同一 topic 反復での plan early-cutoff |
| `EVAL_MAX` | 10 | complex の evaluate 差し戻しループ |
| `EVAL_STUCK` | 2 | 同一 topic 反復での design churn 打ち切り |
| `DESIGN_REPLAN_MAX` | 2 | design 差し戻し（replan + reimpl）の hard cap |
| `GREEN_MAX` | 3 | Validate の test green 差し戻し |
| `BLOCK_MAX` | 2 | BLOCKED 由来の再計画 |
| `AMBIGUITY_MAX` | 2 | 超過で needs_clarification |
| `REVIEW_STUCK` | 2 | pr-iterate の同一 topic 反復での stuck 判定 |

<!-- atlas:loop-constants:end -->

この表の値は `_lib/atlas-constants.test.mjs` が実装ソースと照合する。
ソース側の定数を変えたらこの表も更新しないと CI が落ちる。

pr-iterate の `MAX`（review ⇄ fix 反復、既定 10）は `args.max_iterations` で上書きできるため
上表には含めない。

### subagent の役割分担

| agent | 役割 | model / effort |
| --- | --- | --- |
| `dev-planner` | 実装計画の立案 | `QUALITY_MODEL` / high |
| `plan-reviewer` | 計画の devil's-advocate レビュー | `QUALITY_MODEL` / high |
| `implementer` | task 実装・green-fix・evaluator fix | frontmatter / high |
| `evaluator` | 実装品質ゲート | `QUALITY_MODEL` / high |
| `pr-reviewer` | PR レビュー | `QUALITY_MODEL` / high |
| `dev-runner` | Skill 呼び出し（analyze / commit / PR） | frontmatter / high |
| `dev-runner-haiku` | 書き込み・Skill 呼び出しを伴う exec-proxy | haiku / low |
| `dev-runner-haiku-ro` | read-only exec-proxy | haiku / low |
| `dev-runner-haiku-wo` | isolation probe 専任（Write のみ） | haiku / low |

model は subagent の frontmatter を既定としつつ `agent()` の `opts.model` で per-call override する。
品質ゲート系 4 agent の model だけは `_lib/quality-model.mjs` の `QUALITY_MODEL` 定数で一括指定し、
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
dev-flow 本体（`.claude/workflows/` / `.claude/agents/` / `_lib/` / `tools/`）を変更したら、
この図も同じ PR で更新すること。変更の経緯は git log を参照。
