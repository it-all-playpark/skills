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

## Paste, Don't Link

Subagent に渡したい task / context は **prompt 内に verbatim paste** すること。
「`impl-plan.md` を Read してください」「`docs/foo.md` を読んで」といった**ファイル参照の指示で代替してはならない**。

### なぜ paste するか

| 失敗モード | 原因 | 対策 |
|---|---|---|
| Context 浪費 | 大型 plan を N worker × 全文 Read | 該当 task 本文のみを paste |
| 曖昧参照誤読 | 「Task 1 と同様」「上述の通り」を worker が誤解釈 | task 本文を self-contained に書き verbatim paste |
| Drift | plan が更新されても worker context が古い | dispatch 時点の snapshot を paste で固定 |

### 規約

1. **dev-kickoff / dev-kickoff-worker は worker spawn 時に `task_body` を prompt 内に verbatim paste する**。
   worker は `impl-plan.md` 全体を Read しない（boundary 違反）。
2. **dev-plan-impl は各 task を self-contained に書く**。「Task N と同様」「上述の通り」「前述」等の
   曖昧参照は禁止。dev-plan-review はこのパターンを `findings` (severity: major) として flag する。
3. **dev-implement は `task_body` paste がある場合はそれを真実の source とし、`impl-plan.md` を Read しない**。
   `task_body` が無い standalone 実行の場合のみ `impl-plan.md` fallback を使用。

### 推奨 paste フォーマット

worker prompt 内に以下のような明確な区切りで `task_body` を埋め込む:

```
## task_body (verbatim from parent orchestrator)

<<<TASK_BODY_BEGIN>>>
[該当 task のフル本文。File Changes / Test Plan / Acceptance / Notes 含む]
<<<TASK_BODY_END>>>
```

worker 側は `<<<TASK_BODY_BEGIN>>>` / `<<<TASK_BODY_END>>>` の delimiter で task 本文を抽出する。
任意の文字列 hash や TASK_ID を埋め込むことで integrity check も可能。

## 4 値 Status Enum

Generator-Verifier ループ（dev-implement → dev-evaluate）で worker が返す `status` フィールドは
**4 値**のいずれかを取る。dev-implement / dev-kickoff / dev-evaluate / dev-flow-doctor は
本セクションを中央定義として参照する（個別 SKILL.md には簡易表だけ書き、詳細はここに集約）。

| status | 必須追加フィールド | dev-kickoff orchestrator の挙動 |
|---|---|---|
| `DONE` | (なし) | Phase 6 (dev-evaluate) へ進む |
| `DONE_WITH_CONCERNS` | `concerns: string[]` (>= 1 要素) | Phase 6 に `focus_areas = concerns[]` を渡して重点監査 |
| `BLOCKED` | `blocking_reason: string` (非空、>= 10 文字) | **同アプローチ retry 禁止**、Phase 3 に reset し `blocking_reason` を `findings[]` 形式 (`severity: critical`, `dimension: approach_mismatch`) に正規化して `plan-review-feedback.json` に書き込む。詳細整形ルール: [`dev-kickoff/references/evaluate-retry.md`](../../dev-kickoff/references/evaluate-retry.md#blocked-feedback-の整形) |
| `NEEDS_CONTEXT` | `missing_context: string[]` (>= 1 要素) | Phase 4 に再 dispatch、`missing_context[]` を補足 paste。連続 2 回 NEEDS_CONTEXT で human escalate |

ベース必須フィールド: `status`, `branch`, `worktree_path`, `commit_sha`。任意: `pr_url`, `phase_failed`, `error`。

詳細サンプル JSON は [`dev-implement/references/return-contract.md`](../../dev-implement/references/return-contract.md) を参照。

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
