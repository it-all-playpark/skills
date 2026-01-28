---
name: git-prepare
description: |
  Git worktree preparation for feature development. Creates isolated worktree for parallel development.
  Use when: starting new feature work, preparing isolated git environment for issue implementation.
  Accepts args: <issue-number> [--suffix <suffix>] [--base <branch>] [--env-mode hardlink|symlink|copy|none]
allowed-tools:
  - Bash
---

# Git Prepare

Prepare git worktree for isolated feature development.

## Constraints

❌ **NEVER**: `git worktree add` を直接実行
✅ **ALWAYS**: 下記スクリプトを使用

理由: スクリプトが .env* ハードリンク処理と正しいディレクトリ命名を行う

## Execution

```bash
~/.claude/skills/git-prepare/scripts/git-prepare.sh <issue-number> [options]
```

**Output**: JSON with `worktree_path`, `branch`, `base`, `env_mode`, `env_files`

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--suffix` | `m` | Branch suffix → `feature/issue-{N}-{suffix}` |
| `--base` | `dev` | Base branch |
| `--env-mode` | `hardlink` | Env file handling |

## Env Modes

| Mode | Docker | Sync | Cross-FS |
|------|--------|------|----------|
| `hardlink` | ✅ | ✅ bidirectional | ❌ (fallback to copy) |
| `symlink` | ❌ | ✅ bidirectional | ✅ |
| `copy` | ✅ | ❌ | ✅ |
| `none` | - | - | - |
