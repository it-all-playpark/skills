#!/usr/bin/env bats
# Invariant (#570): 非 dev-flow skill の SKILL.md / references に ~/.claude/skills/
# 絶対パス記述を残さない（plugin install 形態に依存しない表現にするため）。
# git grep で tracked ファイルのみを検査し、repo root の gitignored な外部 skill
# symlink（gsc 等）を構造的に対象外にする。

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
}

@test "非dev-flow skillのSKILL.md/referencesに~/.claude/skills/絶対パス記述が残っていない" {
    run git -C "$REPO_ROOT" grep -nIF \
        -e '~/.claude/skills/' \
        -e '$HOME/.claude/skills/' \
        -- '*SKILL.md' '*skill.md' '*references/*.md' \
        ':(exclude)dev-flow/' \
        ':(exclude)dev-flow-doctor/' \
        ':(exclude)dev-flow-improve/' \
        ':(exclude)dev-issue-analyze/' \
        ':(exclude)pr-iterate/' \
        ':(exclude).claude/'
    echo "$output"
    [ "$status" -ne 0 ]
}
