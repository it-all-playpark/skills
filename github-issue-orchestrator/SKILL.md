---
name: github-issue-orchestrator
description: |
  Create GitHub issues from prior discussions with multi-role technical investigation and adversarial planning review.
  Use when: (1) user finished ideation in skills like plan-brainstorm/plan-workflow and now wants a concrete implementation issue,
  (2) user asks to turn discussion notes into an issue with frontend/backend/infra viewpoints,
  (3) user wants a devil's-advocate pass before posting issue.
  Accepts args: [discussion-source] [--repo owner/repo] [--title "TITLE"] [--labels a,b] [--assignees a,b] [--milestone name] [--max-review-rounds N] [--lang ja|en] [--dry-run]
allowed-tools:
  - Bash
model: opus
effort: max
---

# GitHub Issue Orchestrator

## Overview

Turn brainstorming output into an implementation-ready GitHub issue through:
1) domain specialist investigation, 2) plan synthesis, 3) devil's-advocate review loop, and 4) final issue creation.

## Usage

```bash
/github-issue-orchestrator [discussion-source] [--repo owner/repo] [--title "TITLE"] [--labels a,b] [--assignees a,b] [--milestone name] [--max-review-rounds N] [--lang ja|en] [--dry-run]
```

| Arg | Description |
|-----|-------------|
| `discussion-source` | Optional path to notes/markdown exported from brainstorming |
| `--repo` | Target repository (`owner/repo`); omit to use current repo |
| `--title` | Explicit issue title |
| `--labels` | Comma-separated labels |
| `--assignees` | Comma-separated GitHub usernames |
| `--milestone` | Milestone name |
| `--max-review-rounds` | Max devil's-advocate loops (default: `3`) |
| `--lang` | Issue language (default: `ja`) |
| `--dry-run` | Build issue body only, do not create issue |

## Language Policy

- デフォルトは日本語で issue を作成する（タイトル・本文・サマリーすべて）。
- `--lang en` が指定された場合のみ英語で作成する。
- リポジトリ固有の英語ラベル名・技術用語（API, CI, SQL など）はそのまま維持してよい。
- 言語指定がない場合は必ず `ja` として扱う。

## Preconditions

1. Ensure discussion context exists in the conversation or as a file.
2. Ensure `gh` CLI is installed and authenticated for non-dry-run execution.
3. If key constraints are missing (deadline, non-goals, ownership), ask focused follow-up questions before planning.

## Workflow

| Phase | Action | Complete When |
|-------|--------|---------------|
| 1 | Normalize input context | Problem statement, goals, constraints are explicit |
| 2 | Specialist investigation | Frontend/backend/infra findings are documented |
| 3 | Draft implementation plan | Plan includes phases, dependencies, AC, risks |
| 4 | Devil's-advocate review loop | No blocking gaps remain |
| 5 | Compose final issue body | Template is fully filled |
| 6 | Create issue | `gh issue create` returns issue URL |

### Phase 1: Normalize Input

Summarize discussion into:
- objective
- target user/system
- in-scope / out-of-scope
- explicit constraints
- unknowns and assumptions

If input is ambiguous, resolve ambiguity before continuing.

### Phase 2: Specialist Investigation

Analyze from these lenses:
1. `frontend` - UX impact, component boundaries, state/data flow, accessibility, client test strategy.
2. `backend` - API contract, data model changes, migration impact, auth/security, server test strategy.
3. `infra` - deployment/runtime impact, observability, rollback path, cost/reliability, operational risks.

If a lens is not relevant, record `Not applicable` with reason.

If subagents are available, run analyses in parallel; otherwise run the same lenses sequentially.

### Phase 3: Draft Implementation Plan

Generate an actionable plan containing:
- phased tasks with ownership (`frontend` / `backend` / `infra`)
- dependency order
- acceptance criteria (testable)
- risk register
- rollout and rollback strategy
- open questions requiring user decision

Use `references/issue-template.md` as the output structure.

### Phase 4: Devil's-Advocate Review Loop

Apply the checklist in `references/devils-advocate-checklist.md`.

Loop rules:
1. Run devil's-advocate review on current plan.
2. Classify findings as `blocking` or `non-blocking`.
3. Revise the plan to resolve all blocking findings.
4. Repeat until no blocking findings or max rounds reached.

Do not create a GitHub issue while blocking findings remain.

### Phase 5: Compose Final Issue Body

Write full issue markdown to a temp file, for example:

```bash
cat > /tmp/github-issue-orchestrator-body.md <<'MD'
... issue body ...
MD
```

Ensure the body includes:
- specialist summaries (frontend/backend/infra)
- devil's-advocate history (resolved concerns)
- final implementation plan and acceptance criteria

When `--lang` is omitted, write this body in Japanese.

#### AC Lint Self-Check

After the body file is written, run the shared AC contract lint against it:

```bash
bash $SKILLS_DIR/_lib/scripts/ac-lint.sh /tmp/github-issue-orchestrator-body.md
```

The script returns a single-line JSON `{"ok":true,"verdict":"t1|t2|non_compliant",...}` on
stdout and signals the result via exit code (`0` = t1/t2, `3` = non_compliant, `1` = usage/IO
error). Apply this policy based on `verdict`:

| Verdict | Policy |
|---------|--------|
| `t1` | AC セクションが `- [ ]` checkbox 形式に準拠。そのまま Phase 6 へ進む。 |
| `t2` | **自動整形**。AC セクション内の箇条書き（`- `/`* `/番号リスト）を `- [ ]` checkbox 形式に書き換え、`ac-lint.sh` を再実行して `t1` になったことを確認してから Phase 6 へ進む。 |
| `non_compliant` | **自動整形を試み、不能なら abort**。以下いずれか該当する救済手順を適用してから `ac-lint.sh` を再実行する: (a) checkbox または箇条書きは存在するが AC 見出しが無い場合、当該リストブロックの直上に `## 受け入れ基準（Acceptance Criteria）` を挿入する（既存項目の文言は一切変えない）。(b) AC 項目自体が存在しない場合、Phase 3 に戻り検証可能な受け入れ基準を作成してから本文を再構成する。(c) (a)(b) のいずれも適用できない場合、issue を作成せず abort し、`ac-lint.sh` が返した JSON verdict をそのままユーザーへ報告する。 |

### Phase 6: Create Issue

`create_issue.py` は同じ `ac-lint.sh` を決定論ゲートとして内蔵しており、body が
`non_compliant` の場合は（`--dry-run` を含め）exit 1 で abort する。`t2` は警告付きで
通過する（advisory）。Phase 5 の AC Lint Self-Check を通していれば、この Phase 6 で
abort することはない。

Run:

```bash
python3 $SKILLS_DIR/github-issue-orchestrator/scripts/create_issue.py \
  --title "$TITLE" \
  --body-file /tmp/github-issue-orchestrator-body.md \
  [--repo owner/repo] \
  [--labels a,b] \
  [--assignees a,b] \
  [--milestone name] \
  [--dry-run]
```

Capture and return:
- final issue title
- issue URL (or dry-run notice)
- unresolved non-blocking concerns (if any)

## Output Contract

Always return this summary after execution:

```markdown
## Issue Creation Result
- 言語: ja/en
- タイトル: ...
- リポジトリ: ...
- URL: ... (or Dry-run)

## Plan Quality Gate
- Devil's-advocate review rounds: N
- Blocking findings resolved: yes/no
- Remaining non-blocking concerns:
  - ...
```

## References

- `references/issue-template.md`
- `references/devils-advocate-checklist.md`
- `scripts/create_issue.py`
- `_lib/scripts/ac-lint.sh` (shared)

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log github-issue-orchestrator success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log github-issue-orchestrator failure \
  --error-category <category> --error-msg "<message>"
```
