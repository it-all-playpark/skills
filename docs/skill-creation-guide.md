# Skill Creation Guide

Claude Code Skills のベストプラクティス集。

## Skill ディレクトリ構造

```
skill-name/
├── SKILL.md              # Frontmatter + ワークフロー（必須）
├── scripts/              # 決定論的処理（bash/python）
│   └── *.sh / *.py
└── references/           # Progressive disclosure 用の詳細ドキュメント
    └── *.md
```

## SKILL.md Frontmatter

```yaml
---
name: skill-name                    # slash-command 識別子
description: |                      # 常にコンテキスト注入される（簡潔に）
  One-line summary.
  Use when: (1) trigger condition, (2) another condition,
  (3) keywords: keyword1, keyword2, keyword3
  Accepts args: <required> [--optional value]
allowed-tools:                      # 許可ツール（省略時はデフォルト）
  - Bash
  - Skill
  - Task
model: sonnet                       # 実行モデル（省略可）
effort: max                         # 推論深度（省略時 session 設定を継承）
context: fork                       # fork で別コンテキスト（省略可）
agent: general-purpose              # context:fork 時のエージェント型（省略可）
disable-model-invocation: false     # true で自動呼び出し禁止
user-invocable: true                # false でメニュー非表示（background knowledge 専用）
---
```

### Frontmatter 全11フィールド

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | 表示名・slash-command 識別子 |
| `description` | Yes | autocomplete・auto-discovery に使用。**常にコンテキスト消費**するため簡潔に |
| `argument-hint` | No | autocomplete ヒント |
| `allowed-tools` | No | 許可ツールリスト |
| `model` | No | 実行モデル指定（`haiku` / `sonnet` / `opus`） |
| `effort` | No | 推論深度（`low` / `medium` / `high` / `xhigh` / `max`）。session 設定を override |
| `context` | No | `fork` で分離サブエージェント |
| `agent` | No | `context:fork` 時のサブエージェントタイプ |
| `hooks` | No | ライフサイクルフック |
| `disable-model-invocation` | No | `true` で自動呼び出し禁止（危険スキル向け） |
| `user-invocable` | No | `false` でメニュー非表示（background knowledge 専用） |

### effort の選び方

`effort` は skill 実行時の推論深度（reasoning depth）を指定する。省略時は session の
`effortLevel`（settings.json）を継承。Opus 4.7 は 5 段階全対応、Opus 4.6 / Sonnet 4.6 は
`xhigh` 非対応で fallback する。

| 値 | 用途 | 例 |
|---|------|-----|
| `low` | 決定論的処理・CLI wrapper・フォーマット変換 | `image-convert`, `repo-export` |
| `medium` | 軽度の判断を伴う処理 | `blog-schedule-overview` |
| `high` | 標準的なコード生成・通常ワークフロー | デフォルト推奨 |
| `xhigh` | 長時間 agentic / 大規模コーディング（Opus 4.7 限定） | 複雑な実装タスク |
| `max` | 計画・レビュー・批判的分析など**熟考が必要な処理** | `dev-plan-impl`, `dev-plan-review`, `dev-evaluate`, `pr-review`, `bug-hunt`, `code-audit-team`, `seo-strategy`, `incident-response` |

**判断基準**: 推論の質が出力品質を決定する skill（planning, review, critique, strategy）は `max`。
決定論的 tool wrapper は `low`。迷ったら省略して session 設定に委ねる。

参照: [Claude Code docs — effort](https://code.claude.com/docs/en/skills#frontmatter-reference) /
[model-config](https://code.claude.com/docs/en/model-config#adjust-effort-level)

### description の書き方

description は**常にコンテキストに注入される**（character budget デフォルト 15,000 文字）。

```yaml
# Good: トリガー条件・キーワード・引数を含む簡潔な記述
description: |
  Generate SNS posts from blog content.
  Use when: (1) SNS告知文が必要, (2) keywords: SNS告知, 投稿文, announce
  Accepts args: <source> [--platforms LIST]

# Bad: 長すぎる説明、実装詳細の記述
description: |
  This skill reads MDX files, extracts metadata, generates platform-specific
  posts for X (280 chars), LinkedIn (1300 chars), and Facebook (1500 chars),
  with hashtag optimization and scheduling support...
```

## SKILL.md 本文構造

```markdown
# Skill Title

One-line description.

## Usage

```
/skill-name <required> [--optional value]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<required>` | required | 説明 |
| `--optional` | `default` | 説明 |

## Workflow

```
Step 1 → Step 2 → Step 3
```

## Step N: Title

具体的な手順。スクリプト呼び出しは `$SKILLS_DIR/skill-name/scripts/` を使用。

## References

- [Detail Doc](references/detail.md) - 詳細説明
```

### Progressive Disclosure パターン

SKILL.md はワークフロー概要のみ。詳細は `references/` に分離。

```markdown
## Step Summary

| Step | Action | Complete When |
|------|--------|---------------|
| 1 | `Skill: analyze` | Analysis done |
| 2 | `scripts/process.sh` | Output generated |

Details: [Step Details](references/step-detail.md)
```

## Scripts ディレクトリ

決定論的処理（LLM に任せるべきでない処理）はスクリプトに抽出する。

```bash
# スクリプト呼び出しパターン
$SKILLS_DIR/skill-name/scripts/script-name.sh [args]
```

### スクリプト化すべき処理

- ファイル検索・パターンマッチング
- JSON/YAML の読み書き
- git 操作
- API 呼び出し（curl ベース）
- 状態管理（state ファイルの読み書き）

### スクリプト化すべきでない処理

- 文脈を考慮した判断
- コード生成・レビュー
- 自然言語の生成・分析

## 共有リソース

```
_shared/
├── references/      # 共有ドキュメント
└── scripts/         # 共有スクリプト

_lib/
├── common.sh        # 共有 bash ユーティリティ
├── config.py        # 共有 Python 設定
├── scripts/         # 共有インフラスクリプト
└── templates/       # 共有テンプレート
```

## Skill / Agent / Command の使い分け

| 種別 | 用途 | 自動呼び出し | コンテキスト |
|------|------|-------------|-------------|
| **Skill** | 再利用可能手順、progressive disclosure | Yes | inline |
| **Agent** | 自律マルチステップ、永続メモリ | Yes（別コンテキスト） | fork |
| **Command** | オーケストレーション、ユーザー起動 | No | inline |

**優先順位**: Skill（最軽量）> Agent（別コンテキスト）> Command（自動不可）

### オーケストレーションパターン

```
User triggers /command
  → Command orchestrates
  → Command invokes Agent (別コンテキスト)
    → Agent uses preloaded Skill (ドメイン知識)
  → Command invokes Skill (inline 出力生成)
```

## 設計原則

1. **機能特化**: 汎用ロール（QA engineer 等）ではなく機能特化スキルを作る
2. **Progressive Disclosure**: description は簡潔に、詳細は references/ に分離
3. **決定論的処理の分離**: LLM に任せるべきでない処理はスクリプトに抽出
4. **Namespace 命名**: `dev-*`, `blog-*`, `git-*` 等のプレフィックスで整理
5. **小タスクは vanilla**: 小さいタスクは素の Claude Code の方が優秀
6. **Journal Logging**: ワークフロー完了時に skill-retrospective 経由でログ記録
7. **後方互換 scaffolding を作らない (no-backcompat)**:
   内製スキル間の schema 変更や API 変更で **legacy fallback / version enum 分岐 / dual-path 実装は禁止**。
   旧形式は schema error で reject し、新形式のみ受理する。
   - 例: `flow.schema.json` の `version: "2.0.0"` const を使い、`"1.0.0"` 受信時は明示 error
   - 例: dev-kickoff `--task-id` のような廃止フラグは `die_json` で即時 error
   - 理由: 内製スキルは monorepo 内で同期更新できるため、互換 scaffolding は技術的負債にしかならない
   - 外部 API (gh CLI, jq, Claude Code 自身) との接合面は当然互換性を維持する

### Architectural pattern: child-split over DAG

依存関係を持つ複数タスクの coordination が必要な場合、**任意 DAG (depends_on) ではなく
layered linear batch 配列 + child-issue 分割** を選ぶ。

| | DAG (subtask depends_on) | child-split (v2) |
|--|--|--|
| coordination 単位 | 内部 subtask | 外部 GitHub child issue |
| merge 戦略 | Kahn 法 topological merge (最終 N-way) | integration branch への incremental merge |
| 並列性表現 | 任意 DAG | layered linear (serial / parallel batch) |
| 表現力 | 100% | ~90% (実務 case) |
| 実装複雑度 | 高 (topo-sort, contract branch, shared_findings) | 低 (gh issue + batch loop) |
| 中間 CI | 全 subtask で走る | child PR は draft で CI skip |
| audit history | 1 merge commit に N branch | child PR ごとに merge commit |

10% の "残り" DAG case は **親 issue 自体を分けて対応** する。コーディネーション
コストよりメンテコストの方が低い設計を選ぶ。詳細は parent issue #93 を参照。

## Subagent Dispatch Rules

Skill が `Task` / `Agent` tool 経由で subagent を呼び出す場合、以下の規約を**必ず遵守**する。
[Anthropic: Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) によれば delegation の品質で +90% が決まる。曖昧な委譲は重複作業・過剰呼び出し・誤った tool 選択を招く。

### 必須5要素

Subagent を呼び出すプロンプトには、以下5要素を**必ず含める**：

1. **Objective** — 単一の明確なゴール（「X を調べる」ではなく「Y が A か B かを判定する」）
2. **Output format** — 期待する構造（JSON schema / Markdown section 構成 / 語数上限）
3. **Tools** — 使用可能 tool と禁止 tool を明示
4. **Boundary** — 触ってはいけないファイル / commit 禁止 / ネットワーク禁止 等
5. **Token cap** — 「1500 語以内で」「上位 10 件まで」等の計測可能な上限

```markdown
Task(
  subagent_type: "general-purpose",
  prompt: """
  ## Objective
  [単一の明確なゴール]

  ## Output format
  [JSON schema / Markdown section / 語数上限]

  ## Tools
  - 使用可: Read, Grep, Glob
  - 禁止: Bash, Write, Edit

  ## Boundary
  - 除外: vendor/, node_modules/
  - 禁止: commit, git 操作, ネットワーク

  ## Token cap
  - 1500 語以内、最大 20 ファイル
  """
)
```

### Routing Rule Table

タスク性質に応じて subagent 種別を選択する：

| タスク性質 | 推奨 subagent | model | 理由 |
|------------|--------------|-------|------|
| 探索 heavy（Read/Grep/Glob 多用、summary のみ欲しい） | `Explore` agent / Haiku 系 | haiku | token-heavy な探索をメイン context から隔離 |
| 実装系（コード生成・編集・リファクタ） | `general-purpose` | sonnet | バランス型、tool 制約が緩い |
| plan 系（設計・計画立案） | `Plan` agent | opus | 推論品質重視 |
| review 系（コードレビュー・critique） | `code-reviewer` agent | opus | 批判的観点の品質 |
| 並列調査（複数仮説検証） | `general-purpose` × N（並列） | sonnet | 独立タスクの並列化 |

**判断基準**: 出力が大きい → Explore/Haiku、副作用あり → general-purpose/sonnet、推論深度重要 → Plan/opus または code-reviewer/opus。

### 参照

- **詳細規約・呼び出しテンプレート・失敗モード**: [`_shared/references/subagent-dispatch.md`](../_shared/references/subagent-dispatch.md)
- **チェックリスト**: 新規 skill で `Task` / `Agent` を呼ぶ前に 5要素 + routing を確認すること

## skill-config.json

スキル固有の設定は `skill-config.json`（リポジトリルート）に集約。

```json
{
  "skill-name": {
    "setting_key": "value"
  }
}
```

### Config 解決順序

**グローバル**: `$SKILL_CONFIG_PATH` > `~/.config/skills/config.json` > `~/.claude/skill-config.json`

**プロジェクト**: `$git_root/skill-config.json` > `$git_root/.claude/skill-config.json`

スクリプトからは `_lib/common.sh` の `load_skill_config` / `merge_config` を使用。
LLM からは Read ツールで `skill-config.json` を直接読み取る。
