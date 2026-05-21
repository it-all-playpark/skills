# Phase 3: E2E Manual Verification Placeholder

issue #110 の AC12 (manual smoke test) の記録プレースホルダー。

## 検証目的

`make setup` + `make install-link` 実行後に `/dev-plan-review` を Claude Code session で
起動し、`context: fork` subagent が正しく立ち上がることを確認する。

## 事前条件

1. `make setup` を実行 (core.hooksPath = .githooks + make skills)
2. `make install-link` を実行 (~/.claude/skills real dir 化 + per-skill symlink 構築)
3. `~/.claude/skills/dev-plan-review → <repo>/.build/skills/dev-plan-review/` を確認

## 検証手順 (未実施)

```bash
# 1. make setup
make setup

# 2. make install-link
make install-link

# 3. symlink 確認
ls -la ~/.claude/skills/dev-plan-review
# 期待: → <repo>/.build/skills/dev-plan-review

# 4. merged artifact 確認
cat ~/.claude/skills/dev-plan-review/SKILL.md | head -20
# 期待: model: opus / effort: max / context: fork / allowed-tools が含まれる

# 5. Claude Code session から /dev-plan-review を起動
# → subagent (context: fork) が起動することを確認
```

## 判定基準

- `~/.claude/skills/dev-plan-review/SKILL.md` に `context: fork` が含まれる: OK
- `/dev-plan-review` 起動時に subagent context が fork される: OK
- portable `dev-plan-review/SKILL.md` に Claude 拡張が含まれていないまま動作する: OK

## 状態

**未実施** — Phase 4 merge 後に開発者が手動で実行する。
結果は PR description の "Manual verification" セクションに記載する。
