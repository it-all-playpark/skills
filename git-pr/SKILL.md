---
name: git-pr
description: |
  Create GitHub Pull Request from worktree with structured description.
  Supports `--draft` for low-CI child PRs in dev-flow child-split mode.
  Use when: creating PR after implementation, pushing changes to remote.
  Accepts args: <issue-number> [--base <branch>] [--draft] [--worktree <path>] [--lang ja|en]
allowed-tools:
  - Bash
  - Skill
---

# Create PR

Push changes and create GitHub Pull Request from worktree.

## 言語ルール

**PR本文（title, body）は必ず日本語で記述すること。**
- `--lang ja`（デフォルト）の場合、PR title・bodyの全テキストを日本語で記述
- Summary、Changes、Motivation等のセクション内容も日本語
- 技術用語・コード識別子・ファイルパスはそのまま
- `create-pr.sh` が生成するテンプレートは最低限の構造のみ。エージェントが実装内容に基づいて詳細な日本語本文を `gh pr edit --body` で上書きすること

## Workflow

```
1. Stage & commit (via commit skill) → 2. Push to remote → 3. Create PR → 4. Edit PR body (日本語) → 5. Report
```

## Execution

### Step 1: Commit (if needed)

```
Skill(skill: "commit", args: "--all --worktree <path>")
```

### Step 2: Push

```bash
git push -u origin "$BRANCH_NAME"
```

### Step 3: Create PR

```bash
$SKILLS_DIR/create-pr/scripts/create-pr.sh <issue-number> [options]
```

**Output**: JSON with `pr_url`, `title`, `branch`, `base`, `worktree`

### Step 4: PR本文を日本語で更新

`create-pr.sh` はテンプレートのみ生成する。実装内容に基づき、以下の構造で日本語の詳細本文を `gh pr edit --body` で設定すること:

```markdown
## 概要
Closes #$ISSUE
- 変更点を日本語で箇条書き

## 動機
なぜこの変更が必要か

## 変更内容
| ファイル | 変更内容 |
|---------|----------|
| `path` | 説明 |

## テスト計画
- [x] テスト結果
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `<issue-number>` | required | Related GitHub issue |
| `--base` | `dev` | Base branch for PR |
| `--draft` | false | Create as draft PR (CI を抑制したい child PR で使用) |
| `--title` | auto | Override PR title |
| `--lang` | `ja` | PR body language (ja/en) |
| `--worktree` | cwd | Worktree path |

### `--draft` Usage

dev-flow child-split mode では各 child PR を `--draft` で作成し、
`integration/issue-*` への merge までの間 CI を抑制する。最終 integration →
dev/main PR では `--draft` を **指定しない**（full CI を走らせる）。

CI workflow 側で draft / `integration/**` の skip を設定するレシピは
[`docs/ci-skip-recipe.md`](../docs/ci-skip-recipe.md) を参照。

## PR Title Prefix (Auto)

| Label | Prefix |
|-------|--------|
| `bug` | 🐛 fix: |
| `enhancement` | ✨ feat: |
| `refactor` | ♻️ refactor: |
| `docs` | 📝 docs: |
| default | ✨ |

## Output Format

```
================================================================================
✅ PR Created
================================================================================
📎 URL: https://github.com/org/repo/pull/XXX
🌳 Branch: feature/issue-XXX-m → dev
🎯 Issue: #XXX
📂 Worktree: $WORKTREE_PATH

================================================================================
📋 To continue working in this worktree:
================================================================================

cd $WORKTREE_PATH

================================================================================
```

**CRITICAL**: Always display `cd` command for worktree navigation.

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log git-pr success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log git-pr failure \
  --error-category <category> --error-msg "<message>"
```
