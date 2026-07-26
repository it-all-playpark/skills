# QUALITY_MODEL 向け 4 agent 指示インベントリ（issue #424）

## 目的

issue #424 は dev-flow の品質ゲート系 4 agent（`dev-planner` / `plan-reviewer` / `evaluator` /
`pr-reviewer`。いずれも `QUALITY_MODEL` 定数でモデルを一括指定される）の指示ブロックを、
`.claude/rules/dev-flow.md` の「指示の規範性 (prescription) の正当化クラス」節で定義された
**contract / incentive-structural / capability-bound** の 3 分類へ実測でマッピングする。
3 分類の定義・判定基準の正本は `.claude/rules/dev-flow.md` の当該節を参照する（本ファイルでは
再掲しない）。

**本インベントリは 2026-07-27 時点のスナップショットである。** agent ファイルの将来編集で
行番号が drift しうるため、各行に対応するセクション見出し（アンカー）を併記する。
**実際の指示削減は本インベントリの非目標であり、削減判断は別 issue で扱う。**

分類が複数クラスにまたがるブロック（例: 契約の説明に few-shot 例示が付随する等）は、主分類を
1 つ記載したうえで備考欄に副次的な capability-bound 側面を併記する
（`.claude/rules/dev-flow.md` W7 節の「pr-iterate major 閾値の sunset path」の書き方と同型）。
sunset path 列は **主分類が capability-bound の行にのみ** 記入し、それ以外は `—`。

---

## dev-planner（`.claude/agents/dev-planner.md`、108 行）

| 指示ブロック | 行範囲 | 分類 | 分類根拠 | sunset path |
|---|---|---|---|---|
| frontmatter（name/description/model/effort/tools） | `dev-planner.md:L1-15` | contract | `agentType` 解決・schema instantiate・model/effort ルーティングに workflow 側が依存する契約 | — |
| タイトル・役割記述 + 呼び出し規約（`agent({agentType:'dev-planner',schema:PLAN})`）+ 外部 state 非保持規約（L17-25、`# dev-planner`） | `L17-25` | contract | 呼び出し方法・返り値の扱い・state 非保持は workflow 側の統合が直接依存するインターフェース契約 | — |
| ## 入力（spawn prompt キー定義） | `L26-34` | contract | `requirements`/`worktree`/`feedback`/`testing` の命名・意味を変えると呼び出し元 prompt 生成と drift する | — |
| ## ワークフロー（5 step 概要） | `L35-39` | capability-bound | 作業手順の箇条書き分解。frontier モデルなら「計画を立てて返せ」のみで同等の順序を自律的に踏める可能性が高い | 表現: 本節（手順概要の箇条書き）の削除・1 文への圧縮 / 再評価トリガ: major モデルリリース毎（`QUALITY_MODEL` 世代交代時に当該指示なし dry-run で品質劣化が無いことを確認して削減） |
| ## Step 1: コードベース調査（実際に確認・推測しない） | `L40-45` | capability-bound | 「推測しない・実際に grep/glob で確認する」という具体手順の明示。確認漏れは plan-reviewer が別途 falsification stance で担保するため、本項目は capability 補助の性格が強い | 表現: Step 1 本文の簡略化（「調査してから計画する」の 1 文へ） / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## Step 2: feedback 反映（severity 順対応・BLOCKED時の別設計強制・topic 反復時のアプローチ変更強制） | `L46-58` | incentive-structural | critical 全件解消義務・topic 反復時の同じ直し方の再適用禁止は、逸脱がモデルの能力不足ではなく「同じ修正を繰り返す」optimization pressure に由来する。dev-flow.md 新節の代表例と同型 | — |
| ## Step 3: serial / parallel 分解（依存関係の 2 群振り分け） | `L59-68` | contract | workflow は返り値 JSON の `serial[]`/`parallel[]` をそのまま for ループ/`parallel()` fan-out へ投入するため、配列順序=実行順序・parallel=disjoint という意味定義は呼び出し側が依存するインターフェース契約 | 備考: 末尾「迷ったら serial に倒す」（L67）はデフォルト値のヒューリスティックで capability-bound 側面。次回 major モデル更新時に要否を見直す |
| ## Step 4: self-contained task 記述（禁止表現・書き直し例） | `L69-81` | incentive-structural | implementer は周辺 context を持たない cold-context の独立 agent として task を受け取るため、曖昧な相互参照を防ぐ self-contained 記述強制は構造要因由来（定義の代表例そのもの） | 備考: L74 の禁止表現具体列挙・L76-80 の書き直し例（few-shot）は capability-bound 側面。次回 major モデル更新時に、当該列挙を「曖昧な相互参照を避け自己完結的に書く」の 1 文へ圧縮できるか dry-run で確認する |
| ## Step 5: 出力 JSON（schema 強制） | `L82-102` | contract | workflow が parse する返り値 schema 定義そのもの。削除・変更は呼び出し側を壊す | — |
| ## 原則「具体的に書く（抽象は禁止）」 | `L105` | capability-bound | 抽象的記述を避けるよう促す具体化指示 | 表現: 当該箇条書きの削除 / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## 原則「YAGNI」 | `L106` | capability-bound | 一般的エンジニアリング原則の再掲であり、投機的機能追加という過剰生成を抑える capability 補助 | 表現: 当該箇条書きの削除（AGENTS.md の YAGNI 原則へ一本化） / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## 原則「revise は全件対応」 | `L107` | incentive-structural | Step 2 の critical 全件解消義務の反復強調。同一 incentive 設計の再掲 | — |
| ## 原則「state を書かない」 | `L108` | contract | 外部 state 非保持の契約の再掲 | — |

## plan-reviewer（`.claude/agents/plan-reviewer.md`、140 行）

| 指示ブロック | 行範囲 | 分類 | 分類根拠 | sunset path |
|---|---|---|---|---|
| frontmatter | `plan-reviewer.md:L1-15` | contract | 同上（agentType/schema/model/effort ルーティング契約） | — |
| タイトル・役割記述（dev-planner とは別 agent として confirmation bias を排除） | `L17-22` | incentive-structural | 別 agent として独立呼び出しすることで同調バイアス（confirmation bias／self-judge）を構造的に排除する設計そのもの | — |
| ## Adversarial Opener（反証スタンス明示） | `L23-31` | incentive-structural | rubber-stamp 化を防ぐ反証スタンスの明示。逸脱は能力不足でなく同調バイアスという incentive 構造由来 | — |
| ## 入力（`plan`/`requirements`/`worktree`） | `L32-36` | contract | `plan`/`requirements`/`worktree` は spawn prompt（`dev-flow.js:L3375-3384`）が実際に渡す入力キーで、意味定義変更は呼び出し元 prompt 生成と drift する | — |
| ## 入力（`pass_threshold`） | `L37` | capability-bound | spawn prompt（`dev-flow.js:L3375-3384`）は `pass_threshold` を渡しておらず、VERDICT schema（`dev-flow.js:L2510-2531`）にも存在しない。agent 内部で完結する self-contained default（既定 80）であり、workflow との入出力契約は存在しない（消費者ゼロ） | 表現: 入力節からの削除（Step 3 の閾値記述にのみ既定値 80 として残す）、または残存 schema フィールドとして別 issue で削除要否を検討 / 再評価トリガ: 別 issue でのフォローアップ時に確認 |
| ## ワークフロー（5 step 概要） | `L39-42` | capability-bound | 手順箇条書きの概要 | 表現: 本節の削除・1 文への圧縮 / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## Step 1: checklist レビュー（dimension 別確認内容の表） | `L43-56` | capability-bound | dimension ごとの確認観点を過剰に具体化した checklist。frontier モデルなら「実コードに照合して系統的にレビューせよ」の 1 文で同等の網羅性が期待できる | 表現: 表を「各 dimension を実コードに照合しレビューする」の 1 文へ圧縮 / 再評価トリガ: major モデルリリース毎（`QUALITY_MODEL` 世代交代時に当該指示なし dry-run で網羅性が劣化しないことを確認） |
| ## Step 2: findings 分類（severity enum 定義 + 必須フィールド） | `L57-68` | contract | severity enum（critical/major/minor）は `planConverged()` の block/revise/pass 判定に直接使われ、findings 必須フィールドは workflow の feedback 累積処理が依存するスキーマ | — |
| ### topic 命名（共有辞書、issue #207） | `L69-77` | incentive-structural | stuck 検出（#123 topic 反復）を成立させるための命名規約。cold-context 補償と同型の incentive 設計 | 備考: L71-76 の 5 項目手順列挙は capability-bound 側面。次回 major モデル更新時に「共有辞書の enum を再利用し、無ければ kebab-case 新語」の 1 文へ圧縮できるか確認する |
| ## Step 3: verdict enum（pass/revise/block） | `L84-87`（enum 値） | contract | `verdict` enum 自体は `planConverged()`（`dev-flow.js:L2410-2415`）が `rev.verdict === 'pass'` で直接消費するインターフェース契約 | — |
| ## Step 3: score 帯定義 + `pass_threshold` 比較式 | `L78-88`（計算式・帯定義） | capability-bound | `planConverged()`（`dev-flow.js:L2410-2415`）は `rev.verdict` と `findings[].severity` のみを消費し、score 値・score 帯・`pass_threshold` 比較を再消費しない（score は `log()` 出力のみ、`dev-flow.js:L3392`）。verdict を導く閾値式は agent 内部で完結するヒューリスティック | 表現: score 帯定義・`pass_threshold` 比較式を「妥当な根拠で verdict を決める」の 1 文へ圧縮し、score フィールド自体は schema 必須のまま残す（ログ用途のみ） / 再評価トリガ: major モデルリリース毎（`QUALITY_MODEL` 世代交代時に dry-run で verdict 判定精度が劣化しないことを確認） |
| ## 反復レビュー（iteration 2 以降・cold start 補償） | `L89-97` | incentive-structural | 既出 findings 対応済み前提・新規 critical/major のみ報告・topic 再利用という cold-context 補償／moving-target 抑制の incentive 設計（#123） | — |
| ## 収束は orchestrator が最終判断する | `L98-109` | incentive-structural | verdict を最終決定にせず topic-stuck + early-cutoff で orchestrator が収束判定する W7 同型機構の説明 | — |
| ## Step 4: 出力 JSON（schema 強制） | `L110-126` | contract | workflow が parse する返り値 schema 定義 | — |
| ### 出力言語・簡潔性（日本語指定・200 字目安） | `L127-133` | capability-bound | 日本語限定・字数目安・前置き禁止などの文体指示。frontier モデルは指示なしでも簡潔な日本語要約が可能な見込みが高い | 表現: 本節の削除、schema description のみへ委譲 / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## 原則「計画と要件しか見ない」 | `L136` | incentive-structural | 実装経緯を意図的に見せないことで確証バイアスを構造的に排除する by-design 設計 | — |
| ## 原則「具体的に（architecture is weak は無価値）」 | `L137` | capability-bound | 抽象的コメント禁止の具体例提示 | 表現: 当該箇条書きの削除 / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## 原則「正直にレビュー（rubber-stamp しない）」 | `L138` | incentive-structural | rubber-stamp 防止の反復強調 | — |
| ## 原則「scope 尊重（YAGNI）」 | `L139` | capability-bound | 一般 YAGNI 原則の再掲 | 表現: 当該箇条書きの削除（AGENTS.md へ一本化） / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## 原則「state を書かない」 | `L140` | contract | 外部 state 非保持の契約の再掲 | — |

## evaluator（`.claude/agents/evaluator.md`、220 行）

| 指示ブロック | 行範囲 | 分類 | 分類根拠 | sunset path |
|---|---|---|---|---|
| frontmatter | `evaluator.md:L1-14` | contract | 同上 | — |
| タイトル・役割記述（implementer とは別 agent として self-evaluation bias を排除） | `L16-21` | incentive-structural | implementer とは別 agent として呼ぶことで self-evaluation bias を排除する設計そのもの | — |
| ## Adversarial Opener | `L22-30` | incentive-structural | 反証スタンス明示による rubber-stamp 防止 | — |
| ### concerns 駆動フォーカス | `L31-35` | incentive-structural | implementer が自己申告した弱点を最優先検査するという、正直な自己申告を引き出す incentive 設計 | — |
| ## 入力 | `L36-49` | contract | `requirements`/`plan`/`worktree`/`focus_areas`/既出 feedback 等の入力キー定義 | — |
| ## ワークフロー（5 step 概要） | `L50-53` | capability-bound | 手順箇条書きの概要 | 表現: 本節の削除・1 文への圧縮 / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## Step 1: 入力収集（report を鵜呑みにしない・実際に diff/テストを確認） | `L54-60` | incentive-structural | 「report を鵜呑みにしない」＝implementer の自己申告を信用しない self-judge 回避の設計 | 備考: `git diff $(git merge-base...)` の具体コマンド例（L56）は capability-bound 側面。次回 major モデル更新時に「実 diff とテスト結果を実際に確認する」の 1 文へ圧縮できるか確認する |
| ## Step 2: task type 判定（type enum + 追加観点の列挙） | `L61-65` | capability-bound | task type の具体例とタイプ別追加観点の列挙という具体化補助 | 表現: 本節の削除、type 判定を model の自律推定に委任 / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## Step 3: `total` フィールド | `L66-74`（フィールド定義のみ） | contract | `total` は EVAL schema（`dev-flow.js:L2552-2556`）の必須フィールドで、削除すると schema 検証が壊れる。ただし workflow は `total` を `log()` 出力（`dev-flow.js:L4060`）以外で消費せず、gate は ledger（`isConvergedUnderPolicy`、`dev-flow.js:L3938,L4163`）が消費する | — |
| ## Step 3: 採点式（スコア式 total = avg(common)×0.7 + type_specific×0.3） | `L66-74`（計算式） | capability-bound | 加重平均の計算式・スコア帯は workflow のどの判定にも再消費されない（phase ルーティングは `feedback_level` と ledger が担う。`dev-flow.js:L3938`「収束は isConvergedUnderPolicy のみで判定し ev.verdict は参照しない」）。agent 内部で完結する採点ヒューリスティック | 表現: 加重平均式を「common/type_specific 観点を総合し 0-100 で採点する」の 1 文へ圧縮 / 再評価トリガ: major モデルリリース毎（`QUALITY_MODEL` 世代交代時に dry-run で採点の相対順序が劣化しないことを確認） |
| ## Step 4: verdict & 差し戻し先（pass/fail 閾値 + feedback_level enum） | `L75-83` | contract | `feedback_level`（design/implementation）は workflow の phase ルーティング（`dev-flow.js:L4169,L4181` の分岐）が直接消費するスキーマ。`total >= threshold` の閾値比較自体は verdict を導出する agent 内部の計算であり、workflow は再消費しない（`dev-flow.js:L3938`） | 備考: `total >= threshold`（既定 7.0）の閾値比較部分は capability-bound 側面（agent 内部完結・workflow 非消費）。次回 major モデル更新時に threshold 明記の要否を見直す |
| ### feedback_level 判定フロー：根本質問 | `L84-88` | capability-bound | 「plan 通り再実装しても再現するか」という一発判定ヒューリスティックの明示 | 表現: 根本質問文の削除、feedback_level enum 定義のみを残す / 再評価トリガ: major モデルリリース毎（同上条件） |
| 灰色領域の個別規則 1-5 + tie-breaker | `L89-97` | capability-bound | 5 パターンの逐条列挙という過剰な具体化 | 表現: 個別規則 1-5 を削除し根本質問 + tie-breaker のみへ圧縮 / 再評価トリガ: major モデルリリース毎（`QUALITY_MODEL` 世代交代時に dry-run で判定精度が劣化しないことを確認）。備考: tie-breaker の根拠（design churn は orchestrator の early-cutoff 対象）は incentive-structural 側面 |
| feedback[] 必須フィールド定義（severity/topic/description/suggestion/escalate/escalate_reason） | `L98-109` | contract | severity=critical は軸A invariant で workflow が常時 blocking にし、escalate=true は merge tier を HOLD にする——いずれも workflow 側 gate 判定が直接依存する schema | 備考: escalate_reason (a)-(d) の詳細基準列挙（L107）は capability-bound 側面。topic 命名規約部分は incentive-structural 側面（stuck 検出支援）。次回 major モデル更新時に (a)-(d) の説明を「当事者性・好み・分布外」の 1 文へ圧縮できるか確認する |
| ## 反復評価（iteration 2 以降・cold start 補償） | `L110-118` | incentive-structural | cold-context 補償・moving-target 抑制・topic 再利用（#125） | — |
| ## 収束は orchestrator が最終判断する | `L119-129` | incentive-structural | topic-stuck + design churn 抑制の early-cutoff 機構の説明 | — |
| ## per-AC 判定（ac_results。W4 item-validator 契約） | `L130-140` | contract | `ac_index`/`satisfied`/`evidence`/`verified_by`/`test_files`/`impl_files` は W4 item-validator 契約で workflow（`redgreen-verify.sh`）が直接消費するスキーマ | 備考: 「自分で red→green 判定を主張しないこと」（L138）は self-judge 禁止の incentive-structural 側面 |
| ## critical_resolutions / security_clearance / concern_resolutions 契約 | `L141-168` | contract | `_lib/evaluator-contract.mjs` の `EVALUATOR_OPERATIONAL_CONTRACT` と完全一致必須、drift 検出テストあり。本ファイル中最も強い contract の一つ | — |
| ## 出力言語・簡潔性（日本語化・200 字目安・before/after 例） | `L169-180` | capability-bound | 日本語化・字数目安・語彙置換の before/after 例という文体の具体列挙 | 表現: before/after 例と字数目安の削除、「日本語で簡潔に」の 1 文へ圧縮 / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## Step 5: 出力 JSON（schema 強制） | `L181-213` | contract | workflow が parse する返り値 schema 定義 | — |
| ## 原則「diff・plan・テスト結果しか見ない」 | `L216` | incentive-structural | 実装経緯を見せない by-design の確証バイアス排除 | — |
| ## 原則「正直に採点（rubber-stamp しない）」 | `L217` | incentive-structural | rubber-stamp 防止の反復強調 | — |
| ## 原則「feedback_level が肝」 | `L218` | capability-bound | Step 4 手順順守を促す重複リマインドであり、frontier モデルなら本文の判定フロー自体で足りる | 表現: 当該箇条書きの削除 / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## 原則「state を書かない」 | `L219` | contract | 外部 state 非保持の契約の再掲 | — |
| ## 原則「escalate は当事者性で立てる（乱発しない）」 | `L220` | incentive-structural | escalate 濫用抑制の incentive 設計。品質問題を escalate に転嫁しないよう強制する | — |

## pr-reviewer（`.claude/agents/pr-reviewer.md`、144 行）

| 指示ブロック | 行範囲 | 分類 | 分類根拠 | sunset path |
|---|---|---|---|---|
| frontmatter | `pr-reviewer.md:L1-14` | contract | 同上 | — |
| タイトル・役割記述 + 呼び出し規約 + 言語指定（`agent({agentType:'pr-reviewer', schema:REVIEW})`） | `L16-21` | contract | 呼び出し方法・LGTM 判定への統合は pr-iterate workflow が直接依存する契約 | 備考: 「レビューコメント・summary は日本語で書く」の言語指定は capability-bound 側面。次回 major モデル更新時に要否を見直す |
| ## Adversarial Opener | `L22-27` | incentive-structural | PR author の説明が diff を過大に売り込む可能性への反証スタンス明示 | — |
| ## 入力 | `L28-34` | contract | `pr`/`worktree`/既出 findings の入力キー定義 | — |
| ## ワークフロー（5 step 概要） | `L35-38` | capability-bound | 手順箇条書きの概要 | 表現: 本節の削除・1 文への圧縮 / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## Step 1-2: 情報・context 収集（`gh pr view`/`gh pr diff` コマンド例） | `L39-48` | capability-bound | 具体コマンド例の明示的指定 | 表現: コマンド例を削除し「PR 情報と diff を取得する」の 1 文へ / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## Step 3: 系統的レビュー（Correctness/Security/Performance/Maintainability/Testing の 5 観点列挙） | `L49-56` | capability-bound | 5 観点を逐条列挙。出力 schema に `dimension` フィールドは存在せずガイダンス専用のため workflow 依存性なし | 表現: 「主要品質観点を網羅的にレビューする」の 1 文へ圧縮 / 再評価トリガ: major モデルリリース毎（`QUALITY_MODEL` 世代交代時に網羅性が劣化しないことを確認） |
| ## Step 4: findings 分類（severity enum） | `L57-64` | contract | severity enum（critical/major/minor）は decision 判定（approve/request-changes/comment）に直接使われるスキーマ | — |
| ## 反復レビュー（iteration 2 以降・cold start 補償） | `L65-81` | incentive-structural | cold-context 補償・moving-target（churn）抑制・topic 再利用（#126）。「ゲート緩和ではない」の明示を含む incentive 設計 | — |
| ## Step 5: 出力 JSON（schema 強制） | `L82-99` | contract | workflow が parse する返り値 schema 定義 | — |
| summary/verification_evidence 長さ制約（severity/topic/file/description/suggestion 必須含む） | `L100-108` | contract | 「schema validation で retry になるため必ず収める」と明記される通り、REVIEW schema の maxLength/maxItems と同一値の契約 | 備考: 「検証根拠の列挙を summary に詰め込まない」の文体注意は capability-bound 側面。次回 major モデル更新時に要否を見直す |
| topic 付与手順 1-5 | `L109-117` | incentive-structural | stuck 突合（#126）を成立させる命名規約 | 備考: 5 段階の手順分解は capability-bound 側面。次回 major モデル更新時に「共有辞書の enum を再利用し、無ければ kebab-case 新語」の 1 文へ圧縮できるか確認する |
| decision 判定基準（approve/request-changes/comment） | `L118-124` | contract | pr-iterate workflow の LGTM loop 終了条件が直接消費する判定順序 | — |
| ## 文体ルール（日本語主体、before/after 語彙置換例 5 組） | `L125-135` | capability-bound | `disclosure→開示` 等の逐語置換例を 5 組列挙する典型的な書き直し例（few-shot） | 表現: 例示 5 組を削除し「一般語は日本語で書く」の 1 文へ / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## 原則「日本語でレビュー」 | `L138` | capability-bound | 言語指定の再掲（frontmatter・文体ルールと重複） | 表現: 当該箇条書きの削除（重複排除） / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## 原則「具体的・実行可能に」 | `L139` | capability-bound | 抽象的指摘を避ける具体化指示 | 表現: 当該箇条書きの削除 / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## 原則「rubber-stamp しない」 | `L140` | incentive-structural | 反証スタンスの反復強調 | — |
| ## 原則「蒸し返さない（moving target 禁止）」 | `L141-142` | incentive-structural | #126 の churn 抑制設計そのもの | — |
| ## 原則「scope 尊重（YAGNI）」 | `L143` | capability-bound | 一般 YAGNI 原則の再掲 | 表現: 当該箇条書きの削除（AGENTS.md へ一本化） / 再評価トリガ: major モデルリリース毎（同上条件） |
| ## 原則「state を書かない」 | `L144` | contract | 外部 state 非保持の契約の再掲。PR への投稿は workflow 側が行う旨も含む | — |

---

## 集計

- 総ブロック数: 78（dev-planner 13 / plan-reviewer 20 / evaluator 25 / pr-reviewer 20）
- クラス別内訳: **contract 29 件（37.2%）** / **incentive-structural 24 件（30.8%）** / **capability-bound 25 件（32.1%）**
- capability-bound 比率（sunset 対象比率）: 25/78 ≈ **32.1%**。全 25 件に sunset path（表現 + 再評価トリガ）を併記済み（併記漏れゼロ）。
- 主分類が contract/incentive-structural でも capability-bound 側面を併記した混在ブロック: 10 件（dev-planner 2 / plan-reviewer 1 / evaluator 4 / pr-reviewer 3）。実際の削減判断は本インベントリの非目標であり、別 issue で扱う。
