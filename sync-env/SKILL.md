---
name: sync-env
description: |
  [DEPRECATED] .worktreeinclude + Claude Code hooks に移行済み。
  dotfiles/claude-code/hooks/generate-worktreeinclude.sh が自動生成する .worktreeinclude により、
  worktree 作成時に .env ファイルが自動コピーされる。
  このスキルは後方互換のため残存。新規利用は非推奨。
allowed-tools:
  - Bash
---

# Sync Env [DEPRECATED]

> **⚠️ このスキルは非推奨です。**
> `.worktreeinclude` + Claude Code hooks による自動コピーに移行しました。
> 詳細: dotfiles/claude-code/hooks/generate-worktreeinclude.sh

## 移行先

1. `dotfiles/claude-code/hooks/generate-worktreeinclude.sh` が `.worktreeinclude` を自動生成
2. Claude Code v2.1.x が worktree 作成時に `.worktreeinclude` のパターンに従い自動コピー
3. `**/.env*` glob でサブディレクトリもカバー

## レガシー使用法

スクリプト自体は残っているため、`.worktreeinclude` 非対応環境では引き続き使用可能:

```bash
scripts/sync-env.sh --worktree <path> [--mode hardlink|symlink|copy] [--source <path>] [--force]
```
