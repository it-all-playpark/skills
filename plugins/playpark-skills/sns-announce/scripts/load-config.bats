#!/usr/bin/env bats
# Tests for sns-announce/scripts/load-config.sh
#
# The project layer is resolved from the git root of the CWD (no argument).
# HOME / SKILL_CONFIG_PATH are isolated so the global layer never leaks in.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/sns-announce/scripts/load-config.sh"

    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"
    unset SKILL_CONFIG_PATH

    PROJECT="$BATS_TEST_TMPDIR/project"
    mkdir -p "$PROJECT/content/blog"
    git -C "$PROJECT" init -q
}

@test "no args: reads skill-config.json from the git root of the CWD" {
    echo '{"sns-announce":{"base_url":"https://example.com","default_lang":"en"}}' > "$PROJECT/skill-config.json"
    cd "$PROJECT/content/blog"
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$(jq -r '.base_url' <<< "$output")" = "https://example.com" ]
    [ "$(jq -r '.default_lang' <<< "$output")" = "en" ]
    [ "$(jq -r '._config_source' <<< "$output")" = "skill-config.json" ]
    [ "$(jq -r '._found' <<< "$output")" = "true" ]
    # defaults are kept for keys the project does not override
    [ "$(jq -r '.platforms.x.char_limit' <<< "$output")" = "280" ]
}

@test "no args: falls back to defaults when the git root has no sns-announce section" {
    cd "$PROJECT"
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$(jq -r '._found' <<< "$output")" = "false" ]
    [ "$(jq -r '.default_lang' <<< "$output")" = "ja" ]
}
