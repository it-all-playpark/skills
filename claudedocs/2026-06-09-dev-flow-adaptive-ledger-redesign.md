# dev-flow 再設計: スケール適応 + 2レーン Goal Ledger + gradient 境界

- **日付**: 2026-06-09
- **ステータス**: implemented (W1-W7 完了、W6b=#154 のみ繰り延べ。2026-06-11 実装同期済み)
- **対象**: `.claude/workflows/dev-flow.js` / `pr-iterate.js` / `.claude/agents/*` / `_shared/scripts/` / `AGENTS.md`
- **検証**: 2 回の multi-agent 検証 run を経た合意設計
  - run 1 (`validate-devflow-redesign`): Goal Ledger + スケール適応の 5 レンズ批判 → adopt-with-changes
  - run 2 (`recalibrate-human-llm-boundary`): human/LLM 境界の再調整 → appropriate-with-recalibration

---

## 1. 問題

GitHub issue を渡したら、アーキテクチャ的にもセキュリティ的にも問題ない PR を作り、レビュー
LGTM まで人手なしで完走する自律パイプライン。merge だけ人手。現状 `dev-flow.js` は機能するが
2 つの不満がある:

1. **軽い変更にも重いパイプラインを毎回フル稼働**。`classifyTriviality` ゲートは存在するが（当時。現在は `classifyShape` に置換済み）
   閾値が硬い (`count > 2` で即 non-trivial)。時間と token を浪費している。
2. **LLM 判定の敵対的ループが 3 つ** (Plan / Evaluate / pr-iterate)。全部が cold-start
   moving-target (毎回 fresh context の reviewer が AC に無い新観点の major を捻り出し収束しない)
   を抱え、stuck / relax / dedup の後付け機械 (issue #123 / #125 / #126) でパッチ済み。

## 2. Load-bearing な洞察: 2 軸の分離

設計判断の土台。検証で実証された。

- **軸 A — 収束の安定性 = 能力非依存 (構造アーティファクト)**
  moving-target は LLM の能力不足ではなく、incentive (adversarial opener "能動的に探せ") +
  cold-context (毎回 fresh) の構造的産物。**賢いモデルほどシャープな non-convergent nitpick を
  出す**ため、frozen target / 既出findings累積 / topic-stuck 検出は能力非依存に正しく、モデルが
  賢くなっても撤去してはならない。
  - 2026 エビデンス: One-Token-to-Fool の judge FPR ≈35% かつスケールに対して非単調 /
    overconfidence ECE ≈39% / Judge Reliability Harness は大規模 codebase で劣化。

- **軸 B — 判定の信頼 (決定論 oracle vs LLM チェックの線引き) = 能力依存**
  時間とともに LLM 側へ滑る。ここを決定論で固定すると、モデルが賢くなるほど過小活用が累積する。

**過去の誤り (本設計が是正する点)**: 初版提案はこの 2 軸を「LLM-as-judge は reward-hackable
だから決定論に寄せる」という単一スタンスに束ね、軸 B まで決定論で固定した。これは現行
`dev-flow.js` (収束=JS、severity=LLM、JS は critical floor のみ強制) からの **後退** だった。

## 3. 設計原則

1. **軸 A は固く保つ (能力非依存)**。frozen target・既出findings累積・stuck 検出・critical floor・
   append 単調性・収束の最終判定は JS。
2. **軸 B は gradient 化 (能力依存)**。決定論 vs LLM の境界をアーキに焼き込まず、単一の
   `gate_policy` パラメータと earned-autonomy テレメトリで LLM 側へ滑らせる。
3. **レーンの cut は「出自」でなく「収束を gate するか否か」**。LLM の critical 判定は blocking に
   残す (advisory に落とさない)。
4. **人間の境界は accountability で正当化する (正確性ではない)**。正確性根拠は frontier が人間を
   超えた瞬間に自壊する。
5. **後方互換 scaffolding を作らない** (repo 規約)。ただし未実証の収束ロジックを実証済み機械で
   backstop することは「互換 scaffolding」ではない — 実証されるまで hard cap + stuck/relax を残す。

## 4. アーキテクチャ

### 4.1 Shape selection (別 SKILL を作らない)

`dev-issue-analyze` の出力 schema に `shape: enum[micro, standard, complex]` を 1 フィールド追加。
既存の sonnet Analyze agent が issue を読むついでに emit する (追加 token ≒ 0)。別 selector
SKILL は issue read を二重化するので作らない。

- **決定論 floor 優先 + LLM は tier を上げるのみ・下げ禁止**。`classifyShape`（`_lib/triviality.mjs`、inline 生成区間）が
  file 数 / AC 数 / `issue_type` / breaking で `shape >= standard|complex` の floor を強制
  （`estimated_change_file_count` 欠落・`acceptance_criteria` 欠落・out-of-enum `issue_type`・breaking → complex floor）。
  LLM の shape token はこの floor の上でのみ有効 (fail-safe: 不明なら重い側)。
  danger-grep hit は shape を上げない — micro でも Evaluate を強制実行する security path として
  別経路で効く（dev-flow.js の `runEval` 判定）。
- 単一 checked-in `dev-flow.js` が `args.shape` で分岐 (micro/standard/complex)。**動的コード生成は
  しない** — workflow ランタイムに fs/import/eval が無く registry はセッションキャッシュのため
  実装不能。SKILL が渡すのはデータ (shape token + 初期化済み ledger JSON) のみ。

| tier | 形 | LLM 判定ループ |
|------|-----|----------------|
| micro (typo/1行/docs) | 単一 implementer → test green → PR → 非ネゴ security pass | 0 |
| standard | plan 1発 → 実装 → test green → 評価 1パス → PR → pr-iterate | 1 (pr-iterate) |
| complex/risky | 現状フル (3ループ) + リスク箇所のみ best-of-N | 3 |

**実装結果 (2026-06 更新)**: W2 の当初 AC「dev-issue-analyze に shape フィールド追加 + classifyTriviality 拡張」は dev-flow 側へ re-scope された。shape 判定は Analyze phase の REQ schema が emit する `shape` token（LLM、raise-only）と、dev-flow.js の `classifyShape`（canonical: `_lib/triviality.mjs`、inline 生成区間）による安全 floor（`estimated_change_file_count` 欠落・`acceptance_criteria` 欠落・out-of-enum `issue_type`・breaking 検出 → complex floor。file 数 <=2/<=5 + AC 数 <=3/<=6 で micro/standard/complex floor）の merge（`mergeShape`、LLM は raise のみ・lower 禁止）で決定する。実装後は realized diff のファイル数で `refloorShape` が raise-only 再判定（EFFECTIVE_SHAPE）。`classifyTriviality` は削除済み（`_lib/workflow-load-smoke.test.mjs` が残存しないことを assert）。

### 4.2 2レーン Goal Ledger (素の JS オブジェクト)

`planSeen` / `evalSeen` と同じ JS 変数。外部 state JSON は持たない。

- **BLOCKING lane** (収束を gate する):
  - (a) 決定論 oracle 付き項目: red→green 遷移を記録できた AC test / danger-grep hit / CI green
  - **OR** (b) LLM が **critical** と判定した finding
  - seeded mandatory 項目: SEC-* / DATA-1 / API-1 (AC と独立に init で積む)
- **ADVISORY lane** (gate しない): 上記以外の LLM 判定。さらに 2 分割:
  - **DECIDED-BY-LLM**: taste / readability / minor — 記録のみ、人間 gate 不要
  - **ESCALATE-TO-HUMAN**: accountability / preference / novelty / 高 blast-radius — REVIEW/HOLD
    マージ tier へ required-block として上げる (読まないと merge できない構造で rubber-stamp 死蔵を防ぐ)

**収束 = BLOCKING lane の全項目 checked AND 未解消 critical なし** — 決定論 JS が判定。
adversarial agent は verdict 決定者ではなく **item validator** (`{id, satisfied, evidence}` を返す)
だが、**severity 判定は LLM に残す** (全面降格しない)。reopen は既存 id 必須 (id 無し reopen は
JS で reject)。append は round 1 以降 critical のみ (単調性を JS 強制)。

### 4.3 決定論 floor (能力非依存・ungameable)

- **red→green 実証**: LLM が書いた AC test は「変更前で落ち変更後で通る」遷移を JS が記録できた時
  **のみ** blocking に昇格。base commit で既に green なら「制約していない」として弾く。
  → これは blocking の **十分条件の一つ** (必要条件ではない)。test 化できない設計不変条件は
  LLM 高確度判定 + danger-grep + critical の第二経路で blocking に入る。
  **実装済み**: evaluator の per-AC 判定（`ac_results`）のうち `verified_by === 'test'` のものは `_shared/scripts/redgreen-verify.sh` を dev-runner-haiku 経由で実行し、red→green 遷移が取れた AC のみ `dev-flow.js:1622` で `setCheck(ledger, acId, { kind: 'deterministic' })` + `checkItem` により deterministic 昇格（blocking）。未成立時は inspection 据え置き。
- **danger-grep on realized diff**: `_shared/scripts/diff-risk-classify.sh` (bats 付き) が
  **実 git diff** (issue text ではなく) を post-Implement と pre-PR で grep。7 クラス
  (auth/authz, crypto, secrets/config, 依存追加, data-migration, public-API, deserialization/exec sink)。
  hit したら tier 無視で heavy security path 強制 + LLM が下げられない critical 注入。
  agent ではなく workflow JS から直接呼ぶ (registry キャッシュ非依存)。
- **severity floor**: danger-class hit は synthetic critical を注入。LLM は raise 可・lower 不可。
  security 系 finding は relax/stuck/early-cutoff から **除外** (resolve-with-evidence か HARD-FAIL のみ)。

### 4.4 Merge tiering (AUTO / REVIEW / HOLD)

merge を一律「人間」にせず 3 階層化。merge 判定は `_lib/merge-tier.mjs` で実装。

- **AUTO**: docs-only / test-only / 単一 module 内 fix で danger-grep clean — 提案 + veto window
  (将来 earned autonomy で真の auto-merge へ昇格)
- **REVIEW**: 標準 — 人間が LGTM して merge
- **HOLD**: danger-class hit / 不可逆・高 blast-radius / 訓練分布外 novelty — 人間必須 + ESCALATE 項目提示

**人間 merge の根拠は accountability/liability/不可逆性/values/preference** (正確性ではない)。

### 4.5 Design-for-the-gradient

- **`gate_policy` enum 単一パラメータ**: `deterministic-only → llm-major-advisory (2026-06 既定)
  → llm-major-blocking → llm-autonomous`。モデル世代更新時は enum 値変更のみで境界を LLM 側へ。
  機構 (2レーン台帳) と partition (パラメータ) を分離。
  **実装結果 (ユーザー確定 2026-06-10)**: enum は trust 昇順 4 値だが LLM major の lane 写像は**非単調** — `[deterministic-only: advisory, llm-major-advisory: advisory, llm-major-blocking: blocking, llm-autonomous: advisory]`。`llm-autonomous` で LLM major が advisory に戻るのは意図的（autonomous = LLM 自身の判断に委ね、機械 gate は軸A invariant のみに縮退）。軸A invariant（critical / deterministic check / seed item）は全 policy で blocking 不変。canonical: `_lib/gate-policy.mjs` の `gateLane`。out-of-enum は明示 error。既定 `llm-major-advisory` は goal-ledger の laneOf と全アイテム一致（既定同一挙動）。
- **earned autonomy**: dev-flow-doctor の journal で AUTO 自動 merge の事後 revert率/incident率を
  計測 → 低実績カテゴリは AUTO 拡大、revert 出たら REVIEW へ降格。実測 blast-radius で境界を動かす。
  （**未実装 — W6b=#154 で対応予定**。W6 は enum 骨格と telemetry 蓄積開始のみ完了）。
- **calibration monitor**: judge confidence vs 実測 correctness を golden-set で追跡。well-calibrated
  と実証されたクラスだけ advisory→blocking へ data-driven 昇格。
  （**未実装 — W6b=#154 で対応予定**。W6 は enum 骨格と telemetry 蓄積開始のみ完了）。
- **distrust 機構の正当化クラスを AGENTS.md 明記**:
  `incentive-structural` (永続) / `blast-radius` (永続) / `capability-bound` (**sunset 対象**)。
  capability-bound 機構はパラメータ値で表現し再評価トリガ (major モデルリリース毎) を必ず持たせる。
  正当化クラスと sunset path の無い distrust 機構は定義上「将来の技術的負債」。

## 5. human / LLM / 決定論 の境界 (まとめ)

| 担い手 | 領域 | 性質 |
|--------|------|------|
| **決定論 (JS/script)** | 収束終端判定 (stuck/上限/critical残存)、red→green 記録、danger-grep on realized diff、severity floor、append 単調性 | 能力非依存・ungameable。"LLM 不信" ではなく敵対ループの勝利宣言を当事者に self-judge させない incentive-engineering |
| **LLM** | severity 判定、holistic 設計健全性 verdict、taste/readability/edge-case、AC 充足の高確度判定、「人間 ground truth が要るか」の分類 | 能力依存・時間とともに拡大。critical 判定は block 系に残す |
| **人間** | (1) merge の accountability/liability (2) values/product/taste (3) preference elicitation (4) 不可逆・高 blast-radius (5) 訓練分布外 novelty | 能力非依存に残る。正確性で正当化しない |

## 6. 現行から保持 (撤去禁止 = 軸 A)

- frozen target + 既出findings累積 + topic-stuck 機械突合
- critical-always-blocks + severity floor + append 単調性
- danger-grep を realized diff に当て security path を tier 非依存で強制
- 収束は orchestrator (JS) が最終判断、verdict は入力に過ぎない (現行 evaluator.md / plan-reviewer.md 構造)
- hard cap (PLAN_MAX/EVAL_MAX/MAX) は last-resort safety net として残す

## 7. 実装可能性の制約 (repo-fit)

- workflow ランタイムに fs/require/import/eval なし → 動的コード生成不可。1 本の可変 script + `args.shape`。
- subagent registry はセッション開始時キャッシュ → 新 agent (security-auditor 等) は実行前に
  **セッション reload 必須**。新 agent を増やすより、非ネゴ security は **決定論スクリプト** か
  既存 evaluator/pr-reviewer の hardened checklist で実装する方が安全。
- `agent()` に effort 引数なし (model のみ) → per-tier の effort は subagent frontmatter で固定。
- workflow ネストは 1 段のみ (dev-flow → pr-iterate で消費済み)。selector は SKILL/JS であり workflow にしない。
- ESM import 不可 → ledger エンジンを複数 script で共有できない。1 本の可変 script に集約 (複製税の回避)。

## 8. 作業分解と仕分け (AUTO/REVIEW/HOLD を実装プロセスにも適用)

| # | 作業項目 | 性質 | ルート | ステータス |
|---|----------|------|--------|----------|
| W1 | `diff-risk-classify.sh` + bats (7 danger クラス、realized diff) | clear-AC / 低 blast-radius / testable | **dev-flow に dogfood** | 完了（`_shared/scripts/diff-risk-classify.sh` + bats、PR #147） |
| W2 | `dev-issue-analyze` に `shape` フィールド追加 + `classifyShape` 安全 floor 実装 | clear-AC / 中 | dev-flow 候補 | 完了（dev-flow 側 `classifyShape` + 安全 floor へ re-scope。§4.1 参照） |
| W3 | 2レーン Goal Ledger エンジン (JS) + 収束 re-cut (LLM critical=block) | アーキ中核 / 高 blast-radius | **human-steered** | 完了（goal-ledger、`_lib/goal-ledger.mjs`） |
| W4 | red→green 実証ゲート (test 昇格ロジック) | アーキ / 中 | human-steered | 完了（red→green 昇格。§4.3 参照） |
| W5 | merge tiering AUTO/REVIEW/HOLD + seeded SEC 項目 | novel / 高 blast-radius | human-steered | 完了（merge tiering、`_lib/merge-tier.mjs` + seeded SEC） |
| W6 | `gate_policy` enum + earned-autonomy テレメトリ + calibration monitor | gradient 基盤 / novel | human-steered | 完了（`gate_policy` enum 骨格 + telemetry 蓄積開始のみ。earned-autonomy 集計・calibration monitor は **W6b (issue #154) へ繰り延べ**） |
| W7 | AGENTS.md に distrust 機構の正当化クラス + sunset path 明記 | docs | dev-flow 候補 (docs-only) | 完了（AGENTS.md「distrust 機構の正当化クラス (W7)」節） |

W1-W7 はすべて実装完了（W6b=#154 のみ繰り延べ）。W1/W2/W7 は小さく testable なので dev-flow に流して dogfooding 済み。W3-W6 はアーキ中核・高 blast-radius なので human-steered で完了。

## 9. Open questions (writing-plans で解決する)

1. `gate_policy` を `llm-major-blocking` へ進める trigger 指標 (golden-set 上の judge ECE/FPR、
   revert率) の初期閾値。**→ W6b (#154) で calibration monitor 実装時に扱う**。
2. ESCALATE-TO-HUMAN を required-block 化したときの rubber-stamp 再発防止 — block 発火頻度上限と
   分類器を締め直す feedback loop。**→ 未解決。W6b 以降で扱う**。
3. AUTO tier を「提案 + veto window」から「真の auto-merge」へ昇格させる無事故 merge 件数閾値と、
   incident 1 件での降格幅。**→ W6b (#154) の earned-autonomy 集計で扱う**。
4. topic-stuck の機械突合が LLM 自由文字列の表記ゆれで漏れるリスク → topic を
   「dimension + 正規化キー」の半構造にすべきか。**→ 現在 dimension+topic 半構造で運用中（実装済み）**。
5. 自分の issue traffic は「再現テスト付きバグ修正」(決定論 oracle 可能) と「新機能」(oracle が
   LLM 製) のどちらが多いか — 決定論的収束がどこまで本物かを左右する。実測で確認。**→ W6b の telemetry データ蓄積後に判断**。

## 10. Non-goals

- cross-vendor portability (dev-flow / pr-iterate は Claude 専用の例外、既定方針通り)
- 動的コード生成 (実装不能、scope 外)
- child-split / DAG / integration branch (廃止済み、復活させない)
- 後方互換 scaffolding (新形式のみ受理)

## 参考

- 検証 run 1: `validate-devflow-redesign` (5 レンズ + red-team)
- 検証 run 2: `recalibrate-human-llm-boundary` (4 レンズ + synthesis)
- 関連 issue: #123 (Plan 収束) / #125 (Evaluate 収束) / #126 (pr-iterate de-churn) / #133 (CI gate)
- memory: `dev-flow-workflow-migration` (harness 制約・運用 gotcha)
