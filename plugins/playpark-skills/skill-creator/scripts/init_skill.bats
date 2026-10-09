#!/usr/bin/env bats
# Tests for skill-creator/scripts/init_skill.py
#
# 生成先は plugins/playpark-skills/<name>/SKILL.md。template の相対リンクは
# skill-creator からではなく生成先から解決されるので、実際に生成した SKILL.md の
# リンクを生成先の位置で解決して実在を確かめる。
# init_skill.py は自身の位置から生成先を決めるため、skill-creator を一時ディレクトリの
# plugins/playpark-skills/ 配下へ複製して実行し、repo の作業ツリーには書かない。

setup() {
    REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../../../.." && pwd)"
    SKILL_CREATOR="$REPO_ROOT/plugins/playpark-skills/skill-creator"
    TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/init-skill-bats-XXXXXX")"
    mkdir -p "$TMP_ROOT/plugins/playpark-skills"
    cp -R "$SKILL_CREATOR" "$TMP_ROOT/plugins/playpark-skills/skill-creator"
}

teardown() {
    rm -rf "$TMP_ROOT"
}

@test "template から生成した SKILL.md の相対リンクはすべて生成先から実在するパスに解決される" {
    run python3 "$TMP_ROOT/plugins/playpark-skills/skill-creator/scripts/init_skill.py" link-probe
    [ "$status" -eq 0 ]

    skill_rel="plugins/playpark-skills/link-probe"
    generated="$TMP_ROOT/$skill_rel/SKILL.md"
    [ -f "$generated" ]

    links="$(grep -oE '\]\([^)]+\)' "$generated" | sed -E 's/^\]\(//; s/\)$//')"
    checked=0
    missing=()
    while IFS= read -r link; do
        [ -n "$link" ] || continue
        case "$link" in
            http://*|https://*|mailto:*|\#*) continue ;;
        esac
        target_rel="$(python3 -c 'import os, sys; print(os.path.normpath(os.path.join(sys.argv[1], sys.argv[2].split("#")[0])))' "$skill_rel" "$link")"
        # 生成先 skill 自身の配下は一時ツリー側、それ以外は repo 側で実在を確かめる
        case "$target_rel" in
            "$skill_rel"|"$skill_rel"/*) base="$TMP_ROOT" ;;
            *) base="$REPO_ROOT" ;;
        esac
        checked=$((checked + 1))
        [ -e "$base/$target_rel" ] || missing+=("$link -> $target_rel")
    done <<< "$links"

    printf 'missing: %s\n' "${missing[@]:-}"
    [ "$checked" -gt 0 ]
    [ "${#missing[@]}" -eq 0 ]
}
