---
name: git-prepare
description: |
  Git worktree preparation for feature development. Creates isolated worktree for parallel development.
  Use when: starting new feature work, preparing isolated git environment for issue implementation.
  Accepts args: <issue-number> [--suffix <suffix>] [--base <branch>] [--local]
allowed-tools:
  - Bash
---

# Git Prepare

Prepare git worktree for isolated feature development.

## Constraints

- **NEVER**: `git worktree add` を直接実行
- **ALWAYS**: 下記スクリプトを使用

理由: スクリプトが `.worktreeinclude` の自動生成と正しいディレクトリ命名を行う

## Execution

```bash
$SKILLS_DIR/git-prepare/scripts/git-prepare.sh <issue-number> [options]
```

**Output**: JSON with `worktree_path`, `branch`, `base`

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--suffix` | `m` | Branch suffix -> `feature/issue-{N}-{suffix}` |
| `--base` | `dev` | Base branch |
| `--local` | false | Skip `gh issue develop`, keep branch local-only |

## .env File Handling

`.env` ファイルのコピーは `.worktreeinclude` で管理される。

- `.worktreeinclude` が存在すれば、Claude Code が `git worktree add` 時にパターンマッチしたファイルを自動コピー
- `.worktreeinclude` が存在しない場合、`git-prepare.sh` が `generate-worktreeinclude.sh` を呼び出して自動生成

詳細: [worktreeinclude hook セットアップ](../_lib/references/worktreeinclude-hook-setup.md)

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
