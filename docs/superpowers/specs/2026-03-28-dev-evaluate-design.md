# dev-evaluate: GAN 型 Evaluator Agent の設計

## 背景

[Anthropic Engineering: Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) の知見に基づき、dev-flow に Generator/Evaluator 分離パターンを導入する。

### 課題

- dev-implement（Generator）が自己完結しており、外部からの品質フィードバックループがない
- 自己評価バイアス: 生成エージェントが自身の成果物を評価すると品質を過大評価する
- 品質チェックが PR レビュー（pr-iterate）まで遅延している

### ゴール

- 実装品質の定性評価を commit 前に行い、早期に品質を担保する
- Generator と Evaluator のコンテキストを完全分離し、自己評価バイアスを排除する
- Opus を「考える」ステップ、Sonnet を「作業する」ステップに配置しコスト最適化する

## スコープ

### In Scope

- 新規スキル: `dev-evaluate`（独立評価 Agent）
- 新規スキル: `dev-plan-impl`（実装計画策定）
- `dev-kickoff` の Phase 構成変更 + リトライループ
- `dev-implement` の model 変更（Sonnet）+ 計画書入力対応
- `skill-config.json` への設定追加

### Out of Scope

- pr-iterate の簡素化（後続タスク）
- Runtime 検証: Playwright / curl（Phase 2 で追加）
- dev-validate の変更

## アーキテクチャ

### Phase 構成（dev-kickoff）

```
Phase 1: prepare     — git-prepare              (既存)
Phase 2: analyze     — dev-issue-analyze         (既存, Opus)
Phase 3: plan-impl   — dev-plan-impl             (新規, Opus)
Phase 4: implement   — dev-implement             (変更, Sonnet)
Phase 5: validate    — dev-validate              (既存, Sonnet)
Phase 6: evaluate    — dev-evaluate              (新規, Opus, context:fork)
Phase 7: commit      — git-commit                (既存, 番号シフト)
Phase 8: pr          — git-pr                    (既存, 番号シフト)
```

### モデル配置

| ロール | スキル | モデル | 理由 |
|--------|--------|--------|------|
| Planner | dev-issue-analyze | Opus | 要件理解は高い推論力が必要 |
| Architect | dev-plan-impl | Opus | 設計判断は高い推論力が必要 |
| Generator | dev-implement | Sonnet | 計画に従う実装は Sonnet で十分、Evaluator が補完 |
| Tester | dev-validate | Sonnet | 機械的チェック（テスト/lint）は Sonnet で十分 |
| Evaluator | dev-evaluate | Opus | 品質判断は高い推論力が必要 |

### コスト構造

```
最悪ケース（全リトライが設計レベル）:
  Opus:   analyze(1) + plan-impl(5) + evaluate(5)
  Sonnet: implement(5) + validate(5)

典型ケース（1〜2回の実装レベルリトライ）:
  Opus:   analyze(1) + plan-impl(1) + evaluate(2〜3)
  Sonnet: implement(2〜3) + validate(2〜3)
```

### リトライループ

```
iteration = 0
max_iterations = 5  (skill-config.json で変更可能)

loop:
  Phase 3: dev-plan-impl (iteration > 0 かつ設計レベル feedback の場合)
  Phase 4: dev-implement (前回 feedback があれば渡す)
  Phase 5: dev-validate
  Phase 6: dev-evaluate  (Skill 呼び出し、context:fork で別コンテキスト)

  if verdict == "pass" → break
  if ++iteration >= max_iterations → break (警告付きで続行)

  Evaluator が feedback の種別を判定:
    設計レベル（アーキテクチャ、API設計、データモデル等）→ Phase 3 に戻る
    実装レベル（バグ、命名、エッジケース等）→ Phase 4 に戻る

Phase 7: git-commit
Phase 8: git-pr
```

### Evaluate Phase のエラーハンドリング

fork コンテキスト自体が失敗した場合（ツールエラー、タイムアウト、不正 JSON 等）:

1. 1回だけ evaluate phase をリトライ（同一イテレーション内）
2. 再度失敗 → 警告を出して evaluate をスキップし、git-commit に進む
3. kickoff.json に `"error": "evaluate fork failed"` を記録

品質ゲートを通過せず commit されるため、pr-iterate での確認が重要になる。

### リトライ時の Phase ステータス

リトライ時、Phase 3〜5 のステータスは最新のランの状態で上書きされる。
イテレーション履歴は `6_evaluate.iterations[]` に全て記録されるため、
個別 Phase の過去状態を保持する必要はない。

```
リトライ (feedback_level: implementation) の場合:
  Phase 3: done のまま（再実行しない）
  Phase 4: done → in_progress（再実装開始）
  Phase 5: done → pending（再検証待ち）
  Phase 6: done → pending（再評価待ち）

リトライ (feedback_level: design) の場合:
  Phase 3: done → in_progress（再計画開始）
  Phase 4: done → pending（再実装待ち）
  Phase 5: done → pending（再検証待ち）
  Phase 6: done → pending（再評価待ち）
```

### リトライループのオーケストレーション

リトライの判定・分岐は dev-kickoff の SKILL.md（LLM）が担当する。
Phase ステータスのリセットは `update-phase.sh` で行う。

理由: 「feedback_level が design か implementation か」の判断は LLM の文脈理解が必要であり、
スクリプトで決定論的に処理すべきでない。

### Parallel Mode（--task-id）での動作

| Phase | Single Mode | Parallel Mode (--task-id) |
|-------|-------------|--------------------------|
| 1_prepare | 実行 | スキップ（worktree 作成済み） |
| 2_analyze | 実行 | スキップ（issue 分析済み） |
| 3_plan_impl | 実行 | **実行**（サブタスクスコープでの計画） |
| 4_implement | 実行 | 実行 |
| 5_validate | 実行 | 実行 |
| 6_evaluate | 実行 | **実行**（サブタスクスコープで評価） |
| 7_commit | 実行 | 実行 |
| 8_pr | 実行 | スキップ（PR は統合後） |

Parallel Mode でも Evaluator は実行する。サブタスク単位での品質担保が
統合後の品質に直結するため。ただし issue 要件は flow.json の subtask 定義から取得。

## dev-evaluate スキル設計

### ディレクトリ構造

```
dev-evaluate/
├── SKILL.md
├── scripts/
│   └── detect-task-type.sh    # diff からタスクタイプを推定
└── references/
    ├── scoring-framework.md   # 共通スコア + タイプ別基準
    └── evaluation-strategies.md  # タイプ別評価戦略（Phase 2 拡張ポイント）
```

### Frontmatter

```yaml
---
name: dev-evaluate
description: |
  Evaluate implementation quality as independent agent (GAN-style Evaluator).
  Use when: (1) post-implementation quality gate, (2) dev-kickoff Phase 6,
  (3) keywords: evaluate, 評価, quality gate, レビュー
  Accepts args: <issue-number> --worktree <path>
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
model: opus
context: fork
agent: general-purpose
---
```

### 入力（fork コンテキストに渡す情報）

`context: fork` により別コンテキストで実行される。dev-implement の実装コンテキストは一切持たない。
dev-kickoff から `Skill: dev-evaluate <issue> --worktree <path>` で呼び出す:

| 入力 | ソース | 説明 |
|------|--------|------|
| issue 要件 | kickoff.json の analyze 結果 | 受入基準、要件サマリー |
| 実装計画 | dev-plan-impl の出力 | 設計意図、ファイル構成 |
| git diff | worktree 内で取得 | 実際の変更内容 |
| テスト結果 | dev-validate の出力 | pass/fail、カバレッジ |
| タスクタイプ | detect-task-type.sh | frontend/api/refactor/infrastructure/generic |
| iteration | kickoff.json | 何回目の評価か + 前回 feedback |

### 出力

評価結果は fork コンテキストの戻り値として返される（stdout に JSON 出力）。
呼び出し元の dev-kickoff が結果をパースし、`kickoff.json` の `6_evaluate.iterations[]` に書き込む。

```json
{
  "verdict": "pass | fail",
  "score": {
    "requirements": 8,
    "code_quality": 7,
    "edge_cases": 6,
    "type_specific": 7
  },
  "total": 7.0,
  "threshold": 7.0,
  "feedback": [
    "認証エラー時のレスポンス形式が未定義",
    "ページネーションのエッジケース（空リスト）未考慮"
  ],
  "feedback_level": "implementation | design",
  "task_type": "api"
}
```

## スコアリングフレームワーク

### 共通基準（全タスクタイプ）

| 基準 | 配点 | 評価内容 |
|------|------|----------|
| requirements | 1-10 | issue の受入基準をどの程度満たしているか |
| code_quality | 1-10 | 可読性、SOLID、命名、適切な抽象度 |
| edge_cases | 1-10 | 異常系・境界値の考慮 |

### タイプ別追加基準

| タスクタイプ | 追加基準 | 評価内容 |
|-------------|---------|----------|
| frontend | UI一貫性 | アクセシビリティ、レスポンシブ、UXパターン |
| api | API設計 | RESTful規約、エラーレスポンス、バリデーション |
| refactor | 安全性 | 振る舞い保持、テストカバレッジ維持、破壊的変更なし |
| infrastructure | 信頼性 | 冪等性、ロールバック可能性、設定の安全性 |
| generic | （なし） | 共通基準のみ |

### スコア算出

```
タイプ別基準がある場合:
  total = (共通3基準の平均 × 0.7) + (タイプ別基準 × 0.3)

generic (タイプ別基準なし):
  total = 共通3基準の平均
```

### 閾値

- デフォルト: 7.0
- `skill-config.json` で変更可能

### タスクタイプ検出 (detect-task-type.sh)

diff のファイルパス・拡張子パターンで推定:

| パターン | タイプ |
|----------|--------|
| `src/components/`, `*.tsx`, `*.vue`, `*.svelte` | frontend |
| `src/routes/`, `src/api/`, `*controller*`, `*handler*` | api |
| `Dockerfile`, `*.tf`, `*.yaml`(k8s), `*.toml`(infra) | infrastructure |
| 判定��能 | generic |

**補足**: diff パターンは一次推定のみ。dev-issue-analyze の出力に issue タイプ
（feat/fix/refactor/docs）が含まれる場合はそちらを優先し、diff パターンは補助的に使用する。
refactor の判定は issue タイプから取得する（diff パターンだけでは fix と区別不能なため）。

## dev-plan-impl スキル設計

### ディレクトリ構造

```
dev-plan-impl/
├── SKILL.md
└── references/
    └── plan-format.md   # 計画書フォーマット仕様
```

### Frontmatter

```yaml
---
name: dev-plan-impl
description: |
  Create implementation plan from issue analysis (Opus planner).
  Use when: (1) dev-kickoff Phase 3, (2) implementation planning before coding,
  (3) keywords: 実装計画, implementation plan, design plan
  Accepts args: <issue-number> --worktree <path>
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
model: opus
---
```

### 入力

| 入力 | ソース | 説明 |
|------|--------|------|
| issue 要件 | kickoff.json の analyze 結果 | 受入基準、要件サマリー |
| コードベース | worktree のファイル群 | 既存コード構造の把握 |
| feedback | 前回の dev-evaluate 結果（リトライ時） | 設計レベルの改善指示 |

### 出力

実装計画書（Markdown）を `$WORKTREE/.claude/impl-plan.md` に出力。
dev-implement はこのパスが存在すれば読み込み、計画に従って実装する。
リト���イ時は上書き（履歴は kickoff.json の iterations に記録済み）。

```markdown
# Implementation Plan

## Overview
[1-2文で何を実装するか]

## File Changes
| File | Action | Description |
|------|--------|-------------|
| src/models/user.ts | create | User モデル定義 |
| src/routes/auth.ts | modify | 認証エンドポイント追加 |

## Architecture Decisions
- [設計判断とその理由]

## Edge Cases
- [考慮すべきエッジケース]

## Dependencies
- [外部ライブラリ、内部モジュール依存]
```

## dev-implement 変更

### 変更点

1. **model**: `opus` → `sonnet` （skill-config.json で上書き可能）
2. **入力追加**: dev-plan-impl の計画書を参照して実装
3. **feedback 入力**: リトライ時は前回の Evaluator feedback を受け取る

### 動作変更

```
旧: issue 要件を読み、自分で計画 → 実装
新: dev-plan-impl の計画書に従い実装。計画にない判断が必要な場合は計画書の方針に沿う
```

## kickoff.json 変更

### Phase 構成

```json
{
  "phases": {
    "1_prepare": { "status": "pending" },
    "2_analyze": { "status": "pending" },
    "3_plan_impl": { "status": "pending" },
    "4_implement": { "status": "pending" },
    "5_validate": { "status": "pending" },
    "6_evaluate": {
      "status": "pending",
      "iterations": [],
      "current_iteration": 0,
      "max_iterations": 5
    },
    "7_commit": { "status": "pending" },
    "8_pr": { "status": "pending" }
  }
}
```

### iterations 記録

```json
{
  "iterations": [
    {
      "iteration": 1,
      "verdict": "fail",
      "total": 5.8,
      "feedback_level": "implementation",
      "feedback": ["エラーハンドリング不足", "..."],
      "timestamp": "2026-03-28T10:30:00Z"
    },
    {
      "iteration": 2,
      "verdict": "pass",
      "total": 7.5,
      "feedback": [],
      "timestamp": "2026-03-28T10:45:00Z"
    }
  ]
}
```

## skill-config.json 追加

```json
{
  "dev-evaluate": {
    "model": "opus",
    "threshold": 7.0,
    "max_iterations": 5
  },
  "dev-plan-impl": {
    "model": "opus"
  },
  "dev-implement": {
    "model": "sonnet"
  }
}
```

**`max_iterations` の優先度**: `skill-config.json` の値を dev-kickoff が読み取り、
kickoff.json 初期化時に `6_evaluate.max_iterations` に書き込む。
以降はその実行の kickoff.json が source of truth。

## スキーマバージョン

kickoff.json のスキーマバージョンを `"3.0.0"` に更新する（Phase 構成の破壊的変更のため）。
旧バージョン（2.0.0 以前）の kickoff.json との互換性はない。
worktree ベースのワークフローのため、旧バージョンの状態ファイルが残る場合は
worktree ごと再作成する（実害なし）。
```

## 拡張ポイント（Phase 2: Runtime 検証）

`references/evaluation-strategies.md` に各タスクタイプの評価戦略を定義:

```markdown
## Strategy Interface

| Field | Description |
|-------|-------------|
| type | タスクタイプ識別子 |
| static_review | コードレビューベースの評価指示（Phase 1、常に実行） |
| runtime_review | 実行環境での検証指示（Phase 2、オプション） |

## frontend
- static_review: コンポーネント構造、props設計、アクセシビリティ属性の確認
- runtime_review: null (Phase 2: Playwright でスクリーンショット + インタラクション検証)

## api
- static_review: エンドポイント設計、エラーハンドリング、バリデーション確認
- runtime_review: null (Phase 2: curl でレスポンス検証)

## refactor
- static_review: 振る舞い保持の diff 分析、テストカバレッジ確認
- runtime_review: null

## infrastructure
- static_review: 冪等性、セキュリティ設定の確認
- runtime_review: null
```

Phase 2 追加時は `runtime_review` を埋め、SKILL.md の `allowed-tools` を拡張するだけ。スキル本体の構造変更は不要。

## 影響範囲

| ファイル | 変更種別 | 内容 |
|----------|---------|------|
| `dev-evaluate/SKILL.md` | 新規 | Evaluator スキル定義 |
| `dev-evaluate/scripts/detect-task-type.sh` | 新規 | タスクタイプ検出 |
| `dev-evaluate/references/scoring-framework.md` | 新規 | スコアリング基準 |
| `dev-evaluate/references/evaluation-strategies.md` | 新規 | タイプ別戦略 |
| `dev-plan-impl/SKILL.md` | 新規 | 実装計画スキル定義 |
| `dev-plan-impl/references/plan-format.md` | 新規 | 計画書フォーマット |
| `dev-kickoff/SKILL.md` | 変更 | Phase 構成変更 + リトライループ |
| `dev-kickoff/scripts/init-kickoff.sh` | 変更 | 新 Phase 初期化 |
| `dev-kickoff/scripts/update-phase.sh` | 変更 | 新 Phase 対応 + ステータスリセット |
| `dev-kickoff/scripts/next-action.sh` | 変更 | 新 Phase の遷移ロジック |
| `dev-implement/SKILL.md` | 変更 | model 変更 + 計画書入力対応 |
| `skill-config.json` | 変更 | 新スキル設定追加 |
| `_lib/schemas/kickoff.schema.json` | 変更 | 新 Phase スキーマ |
