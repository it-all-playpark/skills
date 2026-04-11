---
name: {{skill_name}}
description: |
  {{ONE_LINE_SUMMARY}}
  Use when: (1) {{TRIGGER_1}}, (2) {{TRIGGER_2}},
  (3) keywords: {{KEYWORD_LIST}}
  Accepts args: {{ARGS_SPEC}}
allowed-tools:
  - Bash
  - Skill
---

# {{skill_title}}

{{ONE_LINE_SUMMARY}}

## Usage

```
/{{skill_name}} {{ARGS_SPEC}}
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<required>` | required | TODO |

## Workflow

```
Step 1 → Step 2 → Step 3
```

## Step 1: TODO

具体的な手順。スクリプト呼び出しは `$SKILLS_DIR/{{skill_name}}/scripts/` を使用。

## Journal Logging

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log {{skill_name}} success

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log {{skill_name}} failure \
  --error-category <category> --error-msg "<message>"
```

## Subagent Dispatch Rules

<!--
このセクションは `Task` / `Agent` tool を呼び出す skill のみ残す。
呼び出さない skill はセクションごと削除して良い。
詳細: ../_shared/references/subagent-dispatch.md
-->

この skill が subagent を呼び出す場合、[Subagent Dispatch Rules](../_shared/references/subagent-dispatch.md) を遵守する。呼び出し時のプロンプトには以下5要素を**必ず含める**：

1. **Objective** — 単一の明確なゴール（判定・列挙・生成のいずれか）
2. **Output format** — JSON schema / Markdown section / 語数上限
3. **Tools** — 使用可 tool と禁止 tool の明示
4. **Boundary** — 触ってはいけないファイル / commit 禁止 / ネットワーク禁止
5. **Token cap** — 語数・件数・ファイル数の計測可能な上限

**Routing**: タスク性質に応じて subagent 種別を選択（詳細は上記 reference）：

| タスク性質 | 推奨 subagent | model |
|-----------|--------------|-------|
| 探索 heavy | `Explore` / haiku 系 | haiku |
| 実装系 | `general-purpose` | sonnet |
| plan 系 | `Plan` | opus |
| review 系 | `code-reviewer` | opus |

## References

- [Repo Conventions](references/repo-conventions.md) - 当リポジトリ固有規約のサマリ
- [Skill Creation Guide](../docs/skill-creation-guide.md) - canonical source
