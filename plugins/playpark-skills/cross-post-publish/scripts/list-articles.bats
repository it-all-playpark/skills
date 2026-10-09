#!/usr/bin/env bats
# Tests for cross-post-publish/scripts/list-articles.sh
#
# cross_post_categories は skill-config.json の cross-post-publish セクションから読む（issue #900。
# README も同じセクションに記載する）。HOME を差し替えて global config 層を遮断し、
# project 層は $BATS_TEST_TMPDIR の使い捨て git repo に置く。

setup() {
    SKILLS_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_DIR/cross-post-publish/scripts/list-articles.sh"

    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"
    unset SKILL_CONFIG_PATH

    PROJECT="$BATS_TEST_TMPDIR/project"
    mkdir -p "$PROJECT/content/blog"
    git -C "$PROJECT" init -q
    printf -- '---\ntitle: "Tips"\ncategory: "tech-tips"\n---\n' > "$PROJECT/content/blog/2020-01-01-tips.mdx"
    printf -- '---\ntitle: "Case"\ncategory: "case-studies"\n---\n' > "$PROJECT/content/blog/2020-01-02-case.mdx"
    cd "$PROJECT"
}

@test "cross-post-publish.cross_post_categories の設定値が対象カテゴリと記事の絞り込みに反映される" {
    echo '{"cross-post-publish": {"cross_post_categories": ["case-studies"]}}' > "$PROJECT/skill-config.json"
    run bash "$SCRIPT"
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$(jq -c '.valid_categories' <<< "$output")" = '["case-studies"]' ]
    [ "$(jq -r '[.articles[].slug] | join(",")' <<< "$output")" = "case" ]
    [ "$(jq -r '[.skipped[].slug] | join(",")' <<< "$output")" = "tips" ]
}

@test "cross_post_categories 未設定なら tech-tips / lab-reports を対象にする" {
    run bash "$SCRIPT"
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$(jq -c '.valid_categories' <<< "$output")" = '["tech-tips","lab-reports"]' ]
    [ "$(jq -r '[.articles[].slug] | join(",")' <<< "$output")" = "tips" ]
}
