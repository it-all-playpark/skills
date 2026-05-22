# Phase 0: symlink subdir discovery smoke test

issue #110 の Phase 0 設計判断 (Q5 / EC1) に基づく実機検証記録。

## 目的

`~/.claude/skills/<skill>` が `<repo>/.build/skills/<skill>/` を指す per-skill symlink
において、`SKILL.md` と同階層の `references/`・`scripts/` 等 subdir を
absolute symlink で `<repo>/<skill>/<subdir>/` に張った場合に
Claude Code session 内の `Read` ツールがそれらを解決できるかを検証する。

## 検証結果 (2026-05-22)

### 環境

- Claude Code 上の worktree isolation (agent-af06b164300bd0429)
- macOS Darwin 25.5.0

### 手順と結果

```
# tmp build dir を作成
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/.build/skills/dummy-skill"

# dev-plan-review/references を参照先とした absolute symlink を生成
REPO=/Users/naramotoyuuji/ghq/github.com/it-all-playpark/skills
ln -s "$REPO/dev-plan-review/references" "$TMPDIR/.build/skills/dummy-skill/references"

# SKILL.md 実体ファイルを配置
cat > "$TMPDIR/.build/skills/dummy-skill/SKILL.md" << 'EOF'
---
name: dummy-skill
description: |
  Dummy skill for Phase 0 smoke test.
---
# Dummy Skill
EOF

# per-skill symlink を ~/.claude/skills/dummy-skill → tmpdir に張る
ln -sfn "$TMPDIR/.build/skills/dummy-skill" ~/.claude/skills/dummy-skill

# Claude Code session 内から Read で references/ 配下のファイルを確認
# → review-checklist.md が正常に読めることを確認
```

**結果**: `references/review-checklist.md` が `Read` ツールで問題なく解決された。
absolute symlink 経由で `references/` 配下のファイルを Claude Code が辿れることを確認。

### 結論

**subdir strategy: `symlink` を採用**

absolute symlink で `references/`・`scripts/` 等 subdir を
`<repo>/<skill>/<subdir>/` へ張る方式が動作する。
`copy` fallback (EC1) は今回不要。

## 設計反映

- `build-skill-overlay.sh --subdir-strategy symlink` を default とする
- `--subdir-strategy copy` は EC1 の fallback として引数経由で選択可能にする
- `_shared/references/portable-coordinator.md § 6` に wiring 経路を反映済み
