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

Two steps: fetch the issue JSON with `gh`, then run the pure-transform script against that file.

```bash
gh issue view <issue-number> --json body,title,labels,assignees,milestone,state,comments > $TMPDIR/issue-<issue-number>.json
$SKILLS_DIR/dev-issue-analyze/scripts/analyze-issue.sh <issue-number> --issue-json $TMPDIR/issue-<issue-number>.json [--depth LEVEL|--contract]
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--depth` | `standard` | Analysis depth |

## Depth Levels

| Level | Output |
|-------|--------|
| `minimal` | title, type, labels, state, breaking_keyword_scan, comment_count |
| `standard` | + AC, requirements, body preview, comments[{author,created_at,body}], ac_heading_near_miss, warnings |
| `comprehensive` | + affected files, components |

`breaking_keyword_scan` is a **決定論的な keyword scan** (`breaking\|incompatible\|migration\|破壊的\|非互換`、
title + body 全文、大文字小文字無視) が全 depth の JSON に含まれる。dev-flow の shape floor / merge tier HOLD の
breaking 判定入力の一つ（`req.breaking_change`（LLM 構造化判定）との OR）として使われる決定論 floor。

## Contract Mode (`--contract`)

T1/T2 契約準拠 issue の決定論 parse。T1 = AC 見出し（`## 受け入れ基準` / `受け入れ条件` / `受入基準` /
`受入条件` / `Acceptance Criteria` 等、h1〜h6）+ checkbox 項目 1 件以上。T2 = 同見出し + 素の箇条書き
（`- `/`* `/番号付き）1 件以上。

出力 JSON:

| Key | Description |
|-----|-------------|
| `contract` | `t1` / `t2` / `none` |
| `eligible` | boolean |
| `ineligible_reason` | 不合格理由（該当時のみ） |
| `issue_number` | issue 番号 |
| `title` | issue title |
| `issue_type` | `feat`/`fix`/`docs`/`refactor`/`chore`/`test`/`perf`/`ci`（title prefix → label fallback） |
| `acceptance_criteria` | marker 除去済み、最大 20 件 |
| `scope` | AC 節を除く body 全文 head -c 4000 |
| `estimated_change_file_count` | スコープ節のファイルパス数。導出不能時はキー省略（dev-flow 側 classifyShape の complex floor 安全則がそのまま働く） |
| `breaking_keyword_scan` | 決定論 keyword scan の結果 |
| `comment_count` | issue comments 件数（常時出力） |
| `ac_heading_near_miss` | 許容表記に一致しない AC 風見出し行（見出し全文、常時出力・0 件でも `[]`） |

**Eligibility**: `contract` ∈ `{t1, t2}` かつ `issue_type` ∈ `{feat, fix, docs, refactor, chore, test, perf, ci}`
（title prefix → label fallback。`style:` 等 out-of-enum prefix は不合格）かつ title に `!` breaking marker なし かつ
`breaking_keyword_scan === false` かつ `comment_count === 0`（comments がある issue は body/comment 突合が
決定論では判定できないため sonnet analyze へ fallback）。不合格は exit 0 + `eligible:false`（dev-flow が
sonnet analyze へ fallback）。

**残余リスク**: light path（`--contract` 採用時）は LLM 構造化 breaking 判定を行わない。keyword hit 時は
eligibility で sonnet へ回すため、残余は keyword を含まない実質 breaking issue のみで、事後の danger-grep on
realized diff / merge tier が補償する（意図的な設計判断）。

## Output

```json
{
  "issue_number": 123,
  "title": "...",
  "type": "feat|fix|refactor|docs|chore|test|perf|ci",
  "state": "open|closed",
  "labels": ["bug", "enhancement"],
  "acceptance_criteria": ["- [ ] AC1", "- [ ] AC2"],
  "requirements": ["Req1", "Req2"],
  "affected_files": ["src/foo.ts"],
  "components": ["AuthService"],
  "breaking_keyword_scan": false,
  "comment_count": 2,
  "comments": [{"author": "alice", "created_at": "2026-01-01T00:00:00Z", "body": "訂正: 30 箇所"}],
  "ac_heading_near_miss": ["## 受入れ要件"],
  "warnings": ["acceptance_criteria is empty (no checkbox/numbered items found in body)"],
  "ambiguities": ["確信を持って AC 化できなかった点"]
}
```

`ambiguities` は dev-flow の Analyze phase が要求する任意フィールド。issue から確信を持って受入条件化できなかった重要な曖昧点のみ列挙する（推測で安全に埋められる軽微な点は含めない）。dev-flow は `acceptance_criteria` が空、または `ambiguities` が閾値（2 件）を超えると `status: 'needs_clarification'` で早期 return し、呼び出し元セッションが AskUserQuestion で人間に確認する。

issue comments は body と同じく要件抽出の入力。comment が body を明示的に訂正している場合は comment 側を採用し
`comment_overrides` に列挙、どちらが有効か確定できない矛盾は `comment_conflicts` に列挙する（dev-flow は
`comment_conflicts` 非空で needs_clarification に終端する）。黙って片方を採ってはならない。

## Type Detection

| Label Pattern | Type |
|---------------|------|
| bug | fix |
| enhancement, feature | feat |
| refactor | refactor |
| doc | docs |
| (default) | feat |

## Tech Stack & Best Practice Context

Framework best-practice の供給は Implement phase で行う（dev-flow.js が implementer の spawn prompt に
条件付き context7 参照規約を注入し、`_lib/scripts/detect-stack.sh`（`{"frameworks": [...]}` を返す決定論
的門番）で該当 framework が検出された場合のみ引く）。Analyze phase では stack 検出も best-practice 読み込
みも行わない — plan-reviewer の入力を決定論的に保つため（issue #497）。

## Examples

```bash
gh issue view 123 --json body,title,labels,assignees,milestone,state,comments > $TMPDIR/issue-123.json
scripts/analyze-issue.sh 123 --issue-json $TMPDIR/issue-123.json

gh issue view 45 --json body,title,labels,assignees,milestone,state,comments > $TMPDIR/issue-45.json
scripts/analyze-issue.sh 45 --issue-json $TMPDIR/issue-45.json --depth minimal

gh issue view 67 --json body,title,labels,assignees,milestone,state,comments > $TMPDIR/issue-67.json
scripts/analyze-issue.sh 67 --issue-json $TMPDIR/issue-67.json --depth comprehensive
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
