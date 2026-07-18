---
name: dev-issue-analyze
description: |
  Fetch and analyze GitHub issue for implementation planning.
  Use when: understanding issue requirements, extracting acceptance criteria, planning implementation.
  Accepts args: <issue-number> [--depth minimal|standard|comprehensive]
---

# Issue Analyze

Fetch and parse GitHub issue for implementation planning.

## Execution

```bash
$SKILLS_DIR/dev-issue-analyze/scripts/analyze-issue.sh <issue-number> [--depth LEVEL]
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--depth` | `standard` | Analysis depth |

## Depth Levels

| Level | Output |
|-------|--------|
| `minimal` | title, type, labels, state, breaking_keyword_scan |
| `standard` | + AC, requirements, body preview |
| `comprehensive` | + affected files, components |

`breaking_keyword_scan` is a **決定論的な keyword scan** (`breaking\|incompatible\|migration\|破壊的\|非互換`、
title + body 全文、大文字小文字無視) が全 depth の JSON に含まれる。dev-flow の shape floor / merge tier HOLD の
breaking 判定入力の一つ（`req.breaking_change`（LLM 構造化判定）との OR）として使われる決定論 floor。

## Contract Mode (`--contract`)

T1/T2 契約準拠 issue の決定論 parse。T1 = AC 見出し（`## 受け入れ基準` / `Acceptance Criteria` 等、h1〜h6）+
checkbox 項目 1 件以上。T2 = 同見出し + 素の箇条書き（`- `/`* `/番号付き）1 件以上。

出力 JSON:

| Key | Description |
|-----|-------------|
| `contract` | `t1` / `t2` / `none` |
| `eligible` | boolean |
| `ineligible_reason` | 不合格理由（該当時のみ） |
| `issue_number` | issue 番号 |
| `title` | issue title |
| `issue_type` | `feat`/`fix`/`docs`/`refactor`（title prefix → label fallback） |
| `acceptance_criteria` | marker 除去済み、最大 20 件 |
| `scope` | AC 節を除く body 全文 head -c 4000 |
| `estimated_change_file_count` | スコープ節のファイルパス数。導出不能時はキー省略（dev-flow 側 classifyShape の complex floor 安全則がそのまま働く） |
| `breaking_keyword_scan` | 決定論 keyword scan の結果 |

**Eligibility**: `contract` ∈ `{t1, t2}` かつ `issue_type` ∈ `{feat, fix, docs, refactor}`（title prefix → label
fallback。`chore:` 等 out-of-enum prefix は不合格）かつ title に `!` breaking marker なし かつ
`breaking_keyword_scan === false`。不合格は exit 0 + `eligible:false`（dev-flow が sonnet analyze へ fallback）。

**残余リスク**: light path（`--contract` 採用時）は LLM 構造化 breaking 判定を行わない。keyword hit 時は
eligibility で sonnet へ回すため、残余は keyword を含まない実質 breaking issue のみで、事後の danger-grep on
realized diff / merge tier が補償する（意図的な設計判断）。

## Output

```json
{
  "issue_number": 123,
  "title": "...",
  "type": "feat|fix|refactor|docs",
  "state": "open|closed",
  "labels": ["bug", "enhancement"],
  "acceptance_criteria": ["- [ ] AC1", "- [ ] AC2"],
  "requirements": ["Req1", "Req2"],
  "affected_files": ["src/foo.ts"],
  "components": ["AuthService"],
  "breaking_keyword_scan": false,
  "ambiguities": ["確信を持って AC 化できなかった点"]
}
```

`ambiguities` は dev-flow の Analyze phase が要求する任意フィールド。issue から確信を持って受入条件化できなかった重要な曖昧点のみ列挙する（推測で安全に埋められる軽微な点は含めない）。dev-flow は `acceptance_criteria` が空、または `ambiguities` が閾値（2 件）を超えると `status: 'needs_clarification'` で早期 return し、呼び出し元セッションが AskUserQuestion で人間に確認する。

## Type Detection

| Label Pattern | Type |
|---------------|------|
| bug | fix |
| enhancement, feature | feat |
| refactor | refactor |
| doc | docs |
| (default) | feat |

## Tech Stack & Best Practice Context

After issue analysis, detect the project's tech stack and load relevant best practices
into context. This ensures implementation planning is informed by framework guidelines.

1. Run `$SKILLS_DIR/_lib/scripts/detect-stack.sh` to detect frameworks
2. For each detected skill in `rules_paths`, Read the corresponding SKILL.md
3. Keep loaded — downstream dev-flow phases (dev-planner / implementer agents) benefit from
   the best-practice context already present in the conversation

## Examples

```bash
scripts/analyze-issue.sh 123
scripts/analyze-issue.sh 45 --depth minimal
scripts/analyze-issue.sh 67 --depth comprehensive
```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-issue-analyze success \
  --issue $ISSUE --duration-turns $TURNS

# On failure (issue not found, API error, etc.)
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-issue-analyze failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>"
```
