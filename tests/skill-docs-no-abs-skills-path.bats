#!/usr/bin/env bats
# Invariant (#570): 非 dev-flow skill の SKILL.md / references に ~/.claude/skills/
# 絶対パス記述を残さない（plugin install 形態に依存しない表現にするため）。
# git grep で tracked ファイルのみを検査し、repo root の gitignored な外部 skill
# symlink（gsc 等）を構造的に対象外にする。
#
# bug-hunt / code-audit-team / incident-response の allowed-tools は例外。
# #574 レビュー指摘: ${CLAUDE_PLUGIN_ROOT} は plugin 実行時のみ展開され、現行の
# symlink dual distribution（#139）では未展開のまま何にも一致せず script 事前許可
# が失われる。plugin manifest 導入で layout が確定するまで ~/.claude/skills/ 併記
# を残す。この exclude の撤去は #576 で追跡する（frontmatter allowed-tools での
# ${CLAUDE_PLUGIN_ROOT} 展開可否が #567 で未実測のため、実測が sunset の前提）。

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
        ':(exclude)bug-hunt/' \
        ':(exclude)code-audit-team/' \
        ':(exclude)incident-response/' \
        ':(exclude).claude/'
    echo "$output"
    [ "$status" -ne 0 ]
}
