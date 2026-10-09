#!/usr/bin/env bats
# readme-facts.bats - README.md の記述を repo の実体と照合する（issue #899）。
#
# README は marketplace 利用者が最初に読む文書で、実体とずれると「載っている skill が
# 無い」「手順どおりに動かない」になる。ここでは実体から導ける事実だけを照合する:
#   - スキル一覧 = plugin 配下の自作 skill（SKILL.md / skill.md）+ skills-lock.json の外部 skill
#   - 件数は書かない（skill / agent / wrapper の数は増減で腐る。manifest の件数は
#     plugin-manifest.bats が実数と照合する）
#   - License は LICENSE / plugin.json の license と一致させ、外部 skill は上流 license に従うと書く
#   - Python 例の import は実際の script が使う形と同じ
#   - ほかの agent から使う節は locator が要求する PATH と ${CLAUDE_PLUGIN_ROOT} の前提を書く
#   - README / .gitignore は作者個人の環境（dotfiles repo・home-manager・rip）を前提にしない

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
    README="$REPO_ROOT/README.md"
    LOCK="$REPO_ROOT/plugins/playpark-skills/skills-lock.json"
}

# README の `## <title>` 節（次の `## ` 見出しの手前まで）を出力する
readme_h2_section() {
    awk -v t="## $1" '$0 == t {on=1; next} on && /^## / {exit} on {print}' "$README"
}

# README の `### <title>` 節（次の `##` / `###` 見出しの手前まで）を出力する
readme_h3_section() {
    awk -v t="### $1" '$0 == t {on=1; next} on && /^##+ / {exit} on {print}' "$README"
}

@test "README のスキル一覧は自作 skill と skills-lock.json の外部 skill に過不足なく一致する" {
    listed="$(readme_h2_section 'スキル一覧' | grep -oE '^\| `[a-z0-9-]+` \|' | grep -oE '[a-z0-9-]+' | sort -u)"
    own="$(git -C "$REPO_ROOT" ls-files -- 'plugins/*' | grep -iE '^plugins/[^/]+/[^/]+/skill\.md$' | cut -d/ -f3)"
    external="$(jq -r '.skills | keys[]' "$LOCK")"
    actual="$(printf '%s\n%s\n' "$own" "$external" | sort -u)"
    [ -n "$listed" ]
    echo "listed=[$listed]"
    echo "actual=[$actual]"
    [ "$listed" = "$actual" ]
}

@test "README のスキル一覧で 🔗（外部 skill）を付けた行は skills-lock.json の skill と一致する" {
    marked="$(readme_h2_section 'スキル一覧' | grep -E '^\| `[a-z0-9-]+` \|.*🔗' | grep -oE '^\| `[a-z0-9-]+`' | grep -oE '[a-z0-9-]+' | sort)"
    external="$(jq -r '.skills | keys[]' "$LOCK" | sort)"
    echo "marked=[$marked]"
    echo "external=[$external]"
    [ "$marked" = "$external" ]
}

@test "README は skill / agent / bin wrapper の件数を書かない" {
    run grep -nE '[0-9]+\+? ?([A-Za-z-]+ )?(skills?|agents?)([^A-Za-z/._-]|$)|wrapper（[0-9]+|[0-9]+ ?本' "$README"
    echo "$output"
    [ "$status" -eq 1 ]
}

@test "README の License 節は LICENSE と各 plugin.json の license を書き、外部 skill の扱いを書く" {
    section="$(readme_h2_section 'License')"
    head -1 "$REPO_ROOT/LICENSE" | grep -qx 'MIT License'
    for pj in "$REPO_ROOT"/plugins/*/.claude-plugin/plugin.json; do
        license="$(jq -r '.license' "$pj")"
        [ "$license" = "MIT" ]
    done
    [[ "$section" == *"MIT"* ]]
    [[ "$section" == *"LICENSE"* ]]
    [[ "$section" == *"skills-lock.json"* ]]
}

@test "README の Python 例の sys.path / import 行は playpark-skills の実 script と同じ形である" {
    py="$(awk '/^```python$/ {on=1; next} on && /^```$/ {on=0} on {print}' "$README")"
    [ -n "$py" ]
    lines="$(echo "$py" | grep -E '^(sys\.path\.insert|from |import )')"
    [ -n "$lines" ]
    while IFS= read -r line; do
        git -C "$REPO_ROOT" grep -qF -e "$line" -- 'plugins/playpark-skills/*.py' || {
            echo "README の Python 例の行が実 script に無い: $line"
            return 1
        }
    done <<< "$lines"
    [[ "$lines" == *"from config import load_skill_config"* ]]
}

@test "README のほかの agent から使う節は locator が要求する PATH と \${CLAUDE_PLUGIN_ROOT} の前提を書く" {
    section="$(readme_h3_section 'ほかの agent（Codex 等）から使う')"
    [ -n "$section" ]
    # common.sh locator は PATH 上の journal を探す（tests/common-sh-locator.bats）
    [ -x "$REPO_ROOT/plugins/playpark-core/bin/journal" ]
    [[ "$section" == *"plugins/playpark-core/bin"* ]]
    [[ "$section" == *"plugins/playpark-skills/bin"* ]]
    if git -C "$REPO_ROOT" grep -qF '${CLAUDE_PLUGIN_ROOT}' -- 'plugins/playpark-skills/*SKILL.md'; then
        [[ "$section" == *'${CLAUDE_PLUGIN_ROOT}'* ]]
        [[ "$section" == *'export CLAUDE_PLUGIN_ROOT='* ]]
    fi
    [[ "$section" == *"Claude Code 専用"* ]]
}

@test "README は外部 skill gsc に依存する seo-strategy / blog-seo-improve が marketplace install では揃わないことを書く" {
    run grep -nE '`seo-strategy`.*`blog-seo-improve`.*`gsc`' "$README"
    [ "$status" -eq 0 ]
    line="${output%%:*}"
    note="$(sed -n "${line},$((line + 3))p" "$README")"
    [[ "$note" == *"/plugin install playpark-skills@playpark"* ]]
    jq -e '.skills | has("gsc")' "$LOCK" >/dev/null
}

@test "README と .gitignore は作者個人の環境（dotfiles repo・home-manager・rip）を前提にしない" {
    run grep -nE 'dotfiles|home-manager|(^|[^a-z])rip ' "$README" "$REPO_ROOT/.gitignore"
    echo "$output"
    [ "$status" -eq 1 ]
    # ~/.claude/skills が本 repo を指す構成は撤去済み（plugin install に移行）で、.gitignore が前提にしない
    run grep -nF '~/.claude/skills' "$REPO_ROOT/.gitignore"
    echo "$output"
    [ "$status" -eq 1 ]
}
