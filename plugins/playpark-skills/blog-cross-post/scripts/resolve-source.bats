#!/usr/bin/env bats
# Tests for blog-cross-post/scripts/resolve-source.sh
#
# CTA の会社名・URL は skill-config.json の blog-cross-post セクションから来る（issue #900）。
# 本 repo は public なので、特定の会社の URL を script / template に固定しない。
# HOME を差し替えて global config 層を遮断し、project 層は $BATS_TEST_TMPDIR の使い捨て git repo に置く。

setup() {
    SKILLS_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_DIR/blog-cross-post/scripts/resolve-source.sh"
    STRATEGY="$SKILLS_DIR/blog-cross-post/references/cross-post-strategy.md"
    QIITA_GUIDE="$SKILLS_DIR/qiita-publish/references/content-guide.md"

    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"
    unset SKILL_CONFIG_PATH

    PROJECT="$BATS_TEST_TMPDIR/project"
    mkdir -p "$PROJECT/content/blog"
    git -C "$PROJECT" init -q
    printf -- '---\ntitle: "Example"\ncategory: "tech-tips"\n---\nbody\n' \
        > "$PROJECT/content/blog/2026-01-02-example-slug.mdx"
    cd "$PROJECT"
}

@test "blog-cross-post の company_name / contact_url / base_url の設定値が出力に反映される" {
    cat > "$PROJECT/skill-config.json" << 'EOF'
{"blog-cross-post": {
  "base_url": "https://blog.example.test",
  "blog_path_prefix": "/articles/",
  "company_name": "Example Corp",
  "contact_url": "https://example.test/contact"
}}
EOF
    run bash "$SCRIPT" example-slug
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$(jq -r '.company_name' <<< "$output")" = "Example Corp" ]
    [ "$(jq -r '.contact_url' <<< "$output")" = "https://example.test/contact" ]
    [ "$(jq -r '.base_url' <<< "$output")" = "https://blog.example.test" ]
    [ "$(jq -r '.blog_url' <<< "$output")" = "https://blog.example.test/articles/" ]
    [ "$(jq -r '.original_url' <<< "$output")" = "https://blog.example.test/articles/example-slug" ]
}

@test "global config の company_name / contact_url も project 未設定なら出力に反映される" {
    mkdir -p "$HOME/.config/skills"
    echo '{"blog-cross-post": {"company_name": "Global Inc", "contact_url": "https://global.test/contact"}}' \
        > "$HOME/.config/skills/config.json"
    run bash "$SCRIPT" example-slug
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$(jq -r '.company_name' <<< "$output")" = "Global Inc" ]
    [ "$(jq -r '.contact_url' <<< "$output")" = "https://global.test/contact" ]
}

@test "company_name / contact_url 未設定なら空文字を返す（会社名・URL を既定値で埋めない）" {
    run bash "$SCRIPT" example-slug
    echo "$output"
    [ "$status" -eq 0 ]
    [ "$(jq -r '.company_name' <<< "$output")" = "" ]
    [ "$(jq -r '.contact_url' <<< "$output")" = "" ]
}

@test "cross-post-strategy.md の Init結果 由来の変数は resolve-source.sh の出力キーに実在し、CTA 変数を含む" {
    run bash "$SCRIPT" example-slug
    [ "$status" -eq 0 ]
    keys="$(jq -r 'keys[]' <<< "$output")"
    fields="$(grep -E '^\| `\{[A-Z_]+\}` \| Init結果 \| `[a-z_]+` \|' "$STRATEGY" | grep -oE '`[a-z_]+` \|$' | grep -oE '[a-z_]+')"
    echo "fields=[$fields]"
    [ -n "$fields" ]
    while IFS= read -r f; do
        grep -qx "$f" <<< "$keys" || { echo "resolve-source.sh の出力に無い: $f"; return 1; }
    done <<< "$fields"
    grep -qx company_name <<< "$fields"
    grep -qx contact_url <<< "$fields"
}

@test "Qiita の企業紹介 CTA は Init結果 の {COMPANY_NAME} / {CONTACT_URL} で埋める" {
    cta="$(grep -E '^:link: \[お問い合わせ\]' "$QIITA_GUIDE")"
    echo "$cta"
    [ -n "$cta" ]
    while IFS= read -r line; do
        [ "$line" = ':link: [お問い合わせ]({CONTACT_URL}) | [ブログ]({BLOG_URL})' ]
    done <<< "$cta"
    grep -qxF '### {COMPANY_NAME} について' "$QIITA_GUIDE"
}
