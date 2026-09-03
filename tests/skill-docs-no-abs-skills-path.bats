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
# symlink 撤去後は解決先も無い。journal は core bin/ の bare 名、skill 内スクリプトは
# 各 plugin bin/ の bare 名（`<skill>-<action>`）、SKILL.md 内のドキュメント参照のみ
# ${CLAUDE_PLUGIN_ROOT} 相対で書く。
@test "全pluginのSKILL.md/referencesに\$SKILLS_DIR 実行例が残っていない" {
    run git -C "$REPO_ROOT" grep -nIF \
        -e '$SKILLS_DIR/' \
        -e '${SKILLS_DIR}/' \
        -- '*SKILL.md' '*skill.md' '*references/*.md' \
           ':(exclude).claude/'
    echo "$output"
    [ "$status" -ne 0 ]
}

# references/*.md は Read tool で素読みされるため ${CLAUDE_PLUGIN_ROOT} が展開されない
# （skills#567 実測）。references からの script 呼び出しは bin/ の bare 名で書く。
# SKILL.md / agents/*.md は content として展開されるので対象外。
@test "全pluginのreferencesに\${CLAUDE_PLUGIN_ROOT} 参照が残っていない" {
    run git -C "$REPO_ROOT" grep -nIF \
        -e '${CLAUDE_PLUGIN_ROOT}' \
        -e '$CLAUDE_PLUGIN_ROOT' \
        -- '*references/*.md' \
           ':(exclude).claude/'
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
