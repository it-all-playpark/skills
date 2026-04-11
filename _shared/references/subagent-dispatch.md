# Subagent Dispatch Rules

Subagent（`Task` / `Agent` tool 経由）を呼び出す際の共通規約。

**出典**: [Anthropic: Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) は「delegation の品質で成否の +90% が決まる」と報告している。曖昧な委譲は重複作業・過剰呼び出し・誤った tool 選択を招く。本規約は全 skill で subagent 品質を統一するために必須。

## 必須5要素

Subagent を呼び出す際は、プロンプトに以下5要素を**必ず含める**こと。

### 1. Objective（単一の明確なゴール）

- **Good**: 「`src/auth/` 配下のファイルで `jwt.verify` を呼ぶ箇所を特定し、それぞれが `try/catch` で囲まれているか判定する」
- **Bad**: 「JWT の使い方を調べる」

「X を調べる」ではなく「Y が A か B かを判定する」「Z のリストを返す」といった**完了条件が自明なゴール**にすること。

### 2. Output format（期待する構造）

- **Good**: 「JSON で `{ files: [{ path, has_try_catch, line }] }` 形式」「Markdown の H2 セクション 3つ（Findings / Risk / Recommendation）で 500 語以内」
- **Bad**: 「結果を報告してください」

JSON schema、Markdown のセクション構成、語数上限などを明示する。

### 3. Tools（使用可能 tool と禁止 tool）

- **Good**: 「Read/Grep/Glob のみ使用可。Bash は禁止。WebFetch は禁止」
- **Bad**: （指定なし）

特に **探索 heavy なタスクでは Bash/Write/Edit を禁止**し、副作用を防ぐ。

### 4. Boundary（触ってはいけない境界）

- **Good**: 「`vendor/`・`node_modules/`・`dist/` は参照しない。コミットしない。`git` コマンドは禁止。ネットワークアクセス禁止」
- **Bad**: （指定なし）

ファイル/ディレクトリの除外、commit 禁止、ネットワーク禁止などを明記する。

### 5. Token cap（トークン上限）

- **Good**: 「1500 語以内で要約」「上位 10 件まで」「最大 5 ファイルまで開く」
- **Bad**: 「簡潔に」

語数・件数・ファイル数など**計測可能な上限**を明示する。

## Subagent Routing Rules

タスク性質に応じて適切な subagent 種別を選ぶ。

| タスク性質 | 推奨 subagent | model | 理由 |
|------------|--------------|-------|------|
| 探索 heavy（Read/Grep/Glob 多用、結果 summary のみ欲しい） | `Explore` agent または Haiku 系 | haiku | token-heavy な探索をメインコンテキストから隔離 |
| 実装系（コード生成・編集・リファクタ） | `general-purpose` | sonnet | バランス型、tool 制約が緩い |
| plan 系（設計・計画立案） | `Plan` agent | opus | 推論品質重視 |
| review 系（コードレビュー・critique） | `code-reviewer` agent | opus | 批判的観点の品質 |
| 並列調査（複数仮説検証） | `general-purpose` × N（並列 dispatch） | sonnet | 独立タスクの並列化 |

### Routing 判断基準

1. **出力サイズが大きいか？** → Yes なら Explore/Haiku に隔離し、summary のみメインに戻す
2. **副作用を伴うか？** → Yes（Write/Edit/Bash）なら general-purpose / sonnet
3. **推論深度が重要か？** → Yes なら Plan/opus または code-reviewer/opus
4. **複数仮説を並列検証したいか？** → Yes なら同一 message 内で複数 Task 呼び出し

## 呼び出しテンプレート

```markdown
Task(
  subagent_type: "general-purpose",
  description: "Short 3-5 word description",
  prompt: """
  ## Objective
  [単一の明確なゴール]

  ## Output format
  [JSON schema / Markdown section / 語数上限]

  ## Tools
  - 使用可: Read, Grep, Glob
  - 禁止: Bash, Write, Edit, WebFetch

  ## Boundary
  - 除外: vendor/, node_modules/, dist/
  - 禁止: commit, git 操作, ネットワーク
  - scope: <対象ファイル/ディレクトリ>

  ## Token cap
  - 出力: 1500 語以内
  - 最大探索ファイル数: 20
  """
)
```

## 失敗モードと対策（Anthropic 事例）

| 失敗モード | 原因 | 対策 |
|------------|------|------|
| 重複作業 | Objective が曖昧 | 完了条件を明確化 |
| 過剰 subagent | routing ルール欠如 | simple query はメインで処理、複雑タスクのみ委譲 |
| 誤った情報選択 | Output format 未指定 | 欲しい構造を先に定義 |
| トークン浪費 | Token cap 未指定 | 語数・件数上限を明示 |

## Skill 著者向けチェックリスト

新規 skill で Task/Agent を呼ぶ前に確認：

- [ ] Objective は「判定・列挙・生成」のいずれかで完了条件が自明か
- [ ] Output format に JSON schema または Markdown 構造を指定したか
- [ ] Tools の使用可/禁止を明示したか
- [ ] Boundary（除外・禁止操作）を明示したか
- [ ] Token cap（語数/件数）を明示したか
- [ ] Routing ルールに沿った subagent 種別を選んだか
