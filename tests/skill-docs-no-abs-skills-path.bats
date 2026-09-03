#!/usr/bin/env bats
# Invariant (#570, #571): 全 skill の SKILL.md / references に ~/.claude/skills/
# 絶対パス記述を残さない（plugin install 形態に依存しない表現にするため）。
# #571 で skills symlink 自体を撤去したため dev-flow の除外は外した — plugin 配下は
# ${CLAUDE_PLUGIN_ROOT} 相対か bin/ の bare 名で表現する。
# git grep で tracked ファイルのみを検査し、repo root の gitignored な外部 skill
# symlink（gsc 等）を構造的に対象外にする。

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
}

@test "全skillのSKILL.md/referencesに~/.claude/skills/絶対パス記述が残っていない" {
    run git -C "$REPO_ROOT" grep -nIF \
        -e '~/.claude/skills/' \
        -e '$HOME/.claude/skills/' \
        -- '*SKILL.md' '*skill.md' '*references/*.md' \
        ':(exclude).claude/'
    echo "$output"
    [ "$status" -ne 0 ]
}

# $SKILLS_DIR は _lib/common.sh を source した script の中でだけ定義される（core plugin root）。
# SKILL.md / references の実行例は agent の素の Bash shell で走るため未定義に展開され、
# symlink 撤去後は解決先も無い。journal は core bin/ の bare 名、それ以外は
# ${CLAUDE_PLUGIN_ROOT} 相対で書く。
#
# playpark-skills 配下（約20 skill / 約40行）は本 PR 以前からの規約で同じ形が残っており、
# 一括置換は別 issue に切り出してある。ここでは dev-flow / playpark-core と
# skill-creator の template を pin し、退行を防ぐ。
@test "dev-flow/playpark-core のSKILL.md/referencesに\$SKILLS_DIR 実行例が残っていない" {
    run git -C "$REPO_ROOT" grep -nIF \
        -e '$SKILLS_DIR/' \
        -e '${SKILLS_DIR}/' \
        -- 'plugins/dev-flow/*SKILL.md' 'plugins/dev-flow/*references/*.md' \
           'plugins/playpark-core/*SKILL.md' \
           'plugins/playpark-skills/skill-creator/assets/skill-template.md'
    echo "$output"
    [ "$status" -ne 0 ]
}

@test "skill script(*.sh/*.py)に~/.claude/skills絶対パス参照が残っていない" {
    run git -C "$REPO_ROOT" grep -nIF \
        -e '~/.claude/skills/' \
        -e '$HOME/.claude/skills/' \
        -e '${HOME}/.claude/skills/' \
        -e 'Path.home() / ".claude/skills' \
        -- '*.sh' '*.py' ':(exclude)tests/'
    echo "$output"
    [ "$status" -ne 0 ]
}
