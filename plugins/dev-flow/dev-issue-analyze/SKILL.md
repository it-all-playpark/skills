---
name: dev-issue-analyze
description: |
  Fetch and analyze GitHub issue for implementation planning.
  Use when: understanding issue requirements, extracting acceptance criteria, planning implementation.
  Accepts args: <issue-number> [--repo owner/repo] [--depth minimal|standard|comprehensive]
---

# Issue Analyze

Fetch and parse GitHub issue for implementation planning.

## Execution

One bare command. The script fetches the issue itself (`gh issue view <n> [--repo R] --json ...`
in-process) and emits the analysis JSON on stdout. Do not fetch the issue beforehand and do not
append a redirect, pipe, `cd`/`bash`/env prefix or `&&` chain to the command.

```bash
analyze-issue <issue-number> [--repo <owner/repo>] [--depth LEVEL|--contract] [--dump-body "${TMPDIR:-/tmp}/issue-<issue-number>-body.md"]
```

`--depth standard|comprehensive` で呼ぶときは `--dump-body <path>` を付ける。出力 JSON の
`scope_truncated` / `body_preview_truncated` / `issue_body_truncated` のいずれかが true のときだけ
script が body 全文を `<path>` へ書き出し、実際に書いた絶対パスを `body_dump_path` に返す
（切断なしなら `body_dump_path: null`、ファイルは作らない）。切断時は `body_dump_path` のファイルを
Read してから要件抽出する — issue の再取得はしない。

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--repo` | (cwd の repo) | `gh issue view --repo` へそのまま渡す `owner/repo`。dev-flow は `REPO` を渡して cwd 非依存にする |
| `--depth` | `standard` | Analysis depth |
| `--dump-body` | (none) | 切断時のみ body 全文を書き出すファイルパス（standard / comprehensive のみ有効） |

## Depth Levels

| Level | Output |
|-------|--------|
| `minimal` | title, type, labels, state, breaking_keyword_scan, comment_count, issue_author |
| `standard` | + AC, requirements, scope, scope_truncated, scope_total_chars, issue_body, issue_body_truncated, body_dump_path, body_preview, body_preview_truncated, body_total_chars, comments[{author,author_association,created_at,body}], issue_author, ac_heading_near_miss, warnings |
| `comprehensive` | + affected files, components |

`author_association` は `gh` の `authorAssociation`（`OWNER`/`MEMBER`/`COLLABORATOR`/`NONE` 等）を
verbatim 転写する。`issue_author` は issue 報告者の login（`gh` の `author.login`）。両方とも
dev-flow の prerun（`prerun-analyze.sh`）が `comment_overrides` の採用可否判定（issue 報告者本人 または
OWNER/MEMBER/COLLABORATOR に限定。判定自体は決定論、comment の意味分類は Jev）に使う決定論入力で、
本 repo が public であるため任意の外部コメントで要件を上書きさせない fail-closed の一部
（issue #573 review on PR #578）。
`author` / `author_association` / `issue_author` は取得できない場合も文字列 `""` を返す（`null` にしない）。
空文字列は「不明」であって一致ではないため、override 採用の判定材料にはならない。

`breaking_keyword_scan` is a **決定論的な keyword scan** (`breaking\|incompatible\|migration\|破壊的\|非互換`、
title + body 全文、大文字小文字無視) が全 depth の JSON に含まれる。dev-flow の shape floor / merge tier HOLD の
breaking 判定入力の一つ（`req.breaking_change`（LLM 構造化判定）との OR）として使われる決定論 floor。

## Contract Mode (`--contract`)

T1/T2 契約準拠 issue の決定論 parse。T1 = AC 見出し（`## 受け入れ基準` / `受け入れ条件` /
`Acceptance Criteria` / `完了条件`、h2〜h6）+ checkbox 項目 1 件以上。T2 = 同見出し + 素の箇条書き
（`- `/`* `/番号付き）1 件以上。`受入基準` / `受入条件`（「け」「え」を欠く表記）は AC_HEADING_LINE_RE の
許容表記に含まれない。h1（`# 受け入れ基準`）も `ac-lint.sh` の HEADING_RE が h2〜h6 のみを
受理するため AC 見出しとして扱わない（いずれも `ac-lint.sh` との整合、issue #573 review on PR #578） —
一致しない場合は `ac_heading_near_miss` として near-miss 報告され、`acceptance_criteria` は空のまま
dev-flow の Analyze ゲート（AC 空）が needs_clarification に倒す。

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
| `scope` | AC 節を除く body の先頭 4000 字。超過時は末尾に `[TRUNCATED: scope shows the first 4000 of N chars ...]` マーカーを付加（silent に切らない。issue #596） |
| `scope_truncated` | boolean、常時出力。`scope` がマーカー付きで切断されたか |
| `scope_total_chars` | 整数、常時出力。AC 節を除く body の総文字数（切断前の実サイズ） |
| `issue_body` | body 全文（AC 節を含む）の先頭 4000 字。超過時は `scope` と同じ `[TRUNCATED: issue_body ...]` マーカーを付加。dev-flow の Implement phase が plan+impl 統合 implementer（dev-implement-fable）へ issue 本文として渡す（issue #668） |
| `issue_body_truncated` | boolean、常時出力。`issue_body` がマーカー付きで切断されたか |
| `breaking_keyword_scan` | 決定論 keyword scan の結果 |
| `title_breaking_marker` | boolean、常時出力。title の conventional prefix に `!`（`feat!:` 等）があるか |
| `comment_count` | issue comments 件数（常時出力） |
| `issue_author` | issue 報告者の login（常時出力。不明は `""`） |
| `comments` | `[{author, author_association, created_at, body}]`（先頭 50 件、常時出力・0 件でも `[]`） |
| `ac_heading_near_miss` | 許容表記に一致しない AC 風見出し行（見出し全文、常時出力・0 件でも `[]`） |

**Eligibility**: `contract` ∈ `{t1, t2}` かつ `issue_type` ∈ `{feat, fix, docs, refactor, chore, test, perf, ci}`
（title prefix → label fallback）かつ title に `!` breaking marker なし かつ `breaking_keyword_scan === false`
かつ `comment_count === 0`。`eligible` は最初に不合格になった 1 理由だけを `ineligible_reason` に載せる
要約フラグで、dev-flow の prerun（`prerun-analyze.sh`）はこれではなく上記の生シグナル
（`acceptance_criteria` / `breaking_keyword_scan` / `title_breaking_marker` / `comment_count` / `comments` /
`issue_author`）を読み、決定論で解けない 2 理由（breaking keyword hit / comments present）だけを Jev の
有界判定に回す（issue #690）。不合格でも exit 0。

**残余リスク**: breaking keyword を含まない実質 breaking issue は Jev にも回らず、事後の danger-grep on
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
  "comments": [{"author": "alice", "author_association": "NONE", "created_at": "2026-01-01T00:00:00Z", "body": "訂正: 30 箇所"}],
  "issue_author": "reporter-login",
  "ac_heading_near_miss": ["## 受入れ要件"],
  "warnings": ["acceptance_criteria is empty (no checkbox/numbered items found in body)"],
  "body_preview": "...",
  "body_preview_truncated": false,
  "body_total_chars": 320,
  "scope": "...",
  "scope_truncated": false,
  "scope_total_chars": 280,
  "body_dump_path": null,
  "ambiguities": ["確信を持って AC 化できなかった点"]
}
```

`ambiguities` は dev-flow の Analyze phase が要求する任意フィールド。issue から確信を持って受入条件化できなかった重要な曖昧点のみ列挙する（推測で安全に埋められる軽微な点は含めない）。dev-flow は `acceptance_criteria` が空、または `ambiguities` が閾値（2 件）を超えると `status: 'needs_clarification'` で早期 return し、呼び出し元セッションが AskUserQuestion で人間に確認する。

`scope` / `body_preview` の 4000 字 / 500 字上限は context 予算の意図的な設計で、値自体は変えない。以前はこの切断が
silent で、issue 末尾に書かれた確定仕様が抜粋の外へ落ち、それを読めない analyze が `needs_clarification` を返し
続ける事故があった（issue #596）。人間が回答を追記するほど末尾に押し出されて悪化する。切断時は必ず本文末尾へ
`[TRUNCATED: ...]` マーカーを付け、`scope_truncated` / `body_preview_truncated` boolean と `scope_total_chars` /
`body_total_chars` を常時出力する — マーカー文字列を見ない下流（boolean だけを見る決定論ゲート）にも切断の事実が届く。

issue comments は body と同じく要件抽出の入力。dev-flow では prerun が comment ごとに Jev の choice
`{override, conflict, unrelated}` を取り、override かつ権限あり（報告者本人 or OWNER/MEMBER/COLLABORATOR）
なら `comment_overrides`、override だが権限なし / conflict / 低確信なら `comment_conflicts` に列挙する
（dev-flow は `comment_conflicts` 非空で needs_clarification に終端する）。黙って片方を採ってはならない。

## Type Detection

| Label Pattern | Type |
|---------------|------|
| bug | fix |
| enhancement, feature | feat |
| refactor | refactor |
| doc | docs |
| (default) | feat |

## Tech Stack & Best Practice Context

Analyze では stack 検出も best-practice 読み込みも行わない。stack 検出は run 前に wrapper skill が
実行する `dev-flow-prerun`（detect-stack を内包し `args.setup.stack.frameworks` で渡る）が担い、
Next.js 検出時のみ Turbopack fallback 規約を注入する。

## Examples

```bash
analyze-issue 123 --repo acme/skills --dump-body "${TMPDIR:-/tmp}/issue-123-body.md"
analyze-issue 45 --depth minimal
analyze-issue 67 --repo acme/skills --depth comprehensive --dump-body "${TMPDIR:-/tmp}/issue-67-body.md"
analyze-issue 89 --repo acme/skills --contract
```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
journal log dev-issue-analyze success \
  --issue $ISSUE --duration-turns $TURNS

# On failure (issue not found, API error, etc.)
journal log dev-issue-analyze failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>"
```
