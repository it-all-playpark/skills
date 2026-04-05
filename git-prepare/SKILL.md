---
name: git-prepare
description: |
  Git worktree preparation for feature development. Creates isolated worktree for parallel development.
  Use when: starting new feature work, preparing isolated git environment for issue implementation.
  Accepts args: <issue-number> [--suffix <suffix>] [--base <branch>]
allowed-tools:
  - Bash
---

# Git Prepare

Prepare git worktree for isolated feature development.

## Constraints

❌ **NEVER**: `git worktree add` を直接実行
✅ **ALWAYS**: 下記スクリプトを使用

理由: スクリプトが正しいディレクトリ命名とブランチリンクを行う

## Execution

```bash
$SKILLS_DIR/git-prepare/scripts/git-prepare.sh <issue-number> [options]
```

**Output**: JSON with `worktree_path`, `branch`, `base`

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--suffix` | `m` | Branch suffix → `feature/issue-{N}-{suffix}` |
| `--base` | `dev` | Base branch |

## .env ファイルの自動コピー

`.worktreeinclude` と Claude Code hooks により、worktree 作成時に `.env` ファイルが自動コピーされる。
`git-prepare` は `.env` の管理を行わない（Claude Code に委譲）。

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log git-prepare success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log git-prepare failure \
  --error-category <category> --error-msg "<message>"
```
