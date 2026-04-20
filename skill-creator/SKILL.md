---
name: skill-creator
description: |
  Create new skills for this repository following repo conventions (namespace prefix,
  _shared/_lib, skill-config.json, skill-retrospective integration, subagent dispatch rules).
  Use when: (1) creating a new skill from scratch, (2) keywords: new skill, skill 作成,
  skill 新規, create skill, bootstrap skill
  Accepts args: <skill-name>
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Skill
model: opus
effort: max
---

# Skill Creator

当リポジトリ規約に沿った新規 skill を作成するワークフロー。canonical な規約は [`docs/skill-creation-guide.md`](../docs/skill-creation-guide.md) にあり、本 SKILL.md は作成手順のみを定める。

## Usage

```
/skill-creator <skill-name>
```

`<skill-name>` は hyphen-case（例: `blog-analyzer`, `dev-review`）。当リポジトリ規約の namespace prefix（`dev-`, `blog-`, `git-`, `sns-` 等）に従うこと。

## Workflow

```
Step 1: 要件ヒアリング → Step 2: init_skill.py 実行
  → Step 3: SKILL.md 編集 → Step 4: スクリプト/リソース追加
  → Step 5: lint 検証
```

## Step 1: 要件ヒアリング

以下を確認する（全て一度に聞かない）：

1. **Trigger**: どんなユーザー発話でこの skill を起動するか（keywords）
2. **Args**: 必須/任意引数
3. **Scripts**: 決定論的処理（LLM に任せるべきでない処理）の有無
4. **Subagent dispatch**: `Task` / `Agent` tool を呼ぶか

Subagent を呼ぶ場合は [`_shared/references/subagent-dispatch.md`](../_shared/references/subagent-dispatch.md) の5要素を事前に書き起こす。

## Step 2: init_skill.py 実行

```bash
$SKILLS_DIR/skill-creator/scripts/init_skill.py <skill-name>
```

これにより `skill-creator/assets/skill-template.md` をコピーして `<skill-name>/SKILL.md` と `scripts/`, `references/` ディレクトリを生成する。

## Step 3: SKILL.md 編集

template の placeholder を埋める：

- `{{ONE_LINE_SUMMARY}}` — 1行サマリ
- `{{TRIGGER_1}}`, `{{TRIGGER_2}}` — 起動条件
- `{{KEYWORD_LIST}}` — keywords（日本語/英語混在可）
- `{{ARGS_SPEC}}` — `<required> [--optional value]` 形式

**Subagent を呼ばない skill は、template の `## Subagent Dispatch Rules` セクションを丸ごと削除する**。

description は簡潔に（15,000 char budget を意識）。詳細は [`docs/skill-creation-guide.md`](../docs/skill-creation-guide.md) の「description の書き方」を参照。

## Step 4: スクリプト/リソース追加

- **決定論的処理**（ファイル検索、JSON 操作、git 操作、API 呼び出し）は `scripts/` に抽出
- **共有可能なロジック**は `_shared/scripts/` または `_lib/common.sh` を利用・追加
- **詳細ドキュメント**は `references/` に分離（progressive disclosure）

## Step 5: lint 検証

```bash
# subagent dispatch 規約（該当 skill のみ）
tests/subagent-dispatch-lint.sh

# frontmatter 構造
head -30 <skill-name>/SKILL.md | yq -e '.name, .description'
```

## Journal Logging

```bash
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log skill-creator success --skill <name>
```

## References

- [Skill Creation Guide](../docs/skill-creation-guide.md) - canonical 規約
- [Subagent Dispatch Rules](../_shared/references/subagent-dispatch.md) - subagent 呼び出し規約
- [Repo Conventions](references/repo-conventions.md) - 当リポジトリ固有サマリ
