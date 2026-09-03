#!/usr/bin/env bats
# plugin-manifest.bats - Regression tests for the 3-plugin marketplace layout
# (playpark-core / dev-flow / playpark-skills, issue #571).
#
# Invariants pinned here:
#   - marketplace.json lists exactly the 3 plugins, each sourced from
#     ./plugins/<name>, so they can be installed independently.
#   - Each plugin.json is valid, its name matches its directory, its
#     version matches the marketplace entry, skills is ["./"], and there
#     is no "agents" key (plugin subagents are only ever loaded from
#     plugin-root agents/, never from a plugin.json "agents" key -
#     measured: Agents (0)).
#   - dev-flow is the only plugin that ships workflows (the 5 dynamic
#     workflow scripts) and it declares a dependency on playpark-core
#     (cross-plugin bin/_lib resolution requires playpark-core's bin/ on
#     PATH - see _lib/common.sh locator).
#   - dev-flow/agents/ stays a REAL directory (not a symlink): git checks
#     out a mode-120000 entry as a plain text file wherever symlinks are
#     unavailable (Windows without Developer Mode, core.symlinks=false),
#     so putting the symlink on agents/ would make a consumer's install
#     silently degrade to Agents (0) while skills still load - measured,
#     not theoretical. dev-flow/.claude/agents stays the symlink (only
#     affects developing this repo, never consuming it).
#   - the old single-plugin root manifest (.claude-plugin/plugin.json) is
#     gone; the repo is no longer a plugin itself.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
MARKETPLACE_JSON="$REPO_ROOT/.claude-plugin/marketplace.json"
ROOT_PLUGIN_JSON="$REPO_ROOT/.claude-plugin/plugin.json"

PLUGIN_NAMES=(playpark-core dev-flow playpark-skills)

plugin_json_path() {
    echo "$REPO_ROOT/plugins/$1/.claude-plugin/plugin.json"
}

@test "marketplace.json が存在する" {
    [ -f "$MARKETPLACE_JSON" ]
}

@test "marketplace.json は valid JSON" {
    run jq empty "$MARKETPLACE_JSON"
    [ "$status" -eq 0 ]
}

@test "root の .claude-plugin/plugin.json は存在しない（repo 自体は plugin ではない）" {
    [ ! -f "$ROOT_PLUGIN_JSON" ]
}

@test "marketplace.json の plugins は 3 件である" {
    run jq -r '.plugins | length' "$MARKETPLACE_JSON"
    [ "$status" -eq 0 ]
    [ "$output" = "3" ]
}

@test "marketplace.json の plugins[].name が playpark-core/dev-flow/playpark-skills に完全一致する" {
    run jq -r '[.plugins[].name] | sort | join(",")' "$MARKETPLACE_JSON"
    [ "$status" -eq 0 ]
    [ "$output" = "dev-flow,playpark-core,playpark-skills" ]
}

@test "marketplace.json の各 plugins[].source が ./plugins/<name> である" {
    for name in "${PLUGIN_NAMES[@]}"; do
        run jq -r --arg n "$name" '.plugins[] | select(.name == $n) | .source' "$MARKETPLACE_JSON"
        [ "$status" -eq 0 ]
        [ "$output" = "./plugins/$name" ]
    done
}

@test "各 plugins/<name>/.claude-plugin/plugin.json が存在し valid JSON である" {
    for name in "${PLUGIN_NAMES[@]}"; do
        pj="$(plugin_json_path "$name")"
        [ -f "$pj" ]
        run jq empty "$pj"
        [ "$status" -eq 0 ]
    done
}

@test "各 plugin.json の name はディレクトリ名と一致する" {
    for name in "${PLUGIN_NAMES[@]}"; do
        pj="$(plugin_json_path "$name")"
        run jq -r '.name' "$pj"
        [ "$status" -eq 0 ]
        [ "$output" = "$name" ]
    done
}

@test "各 plugin.json の skills は [\"./\"] に完全一致する" {
    for name in "${PLUGIN_NAMES[@]}"; do
        pj="$(plugin_json_path "$name")"
        run jq -c '.skills' "$pj"
        [ "$status" -eq 0 ]
        [ "$output" = '["./"]' ]
    done
}

@test "各 plugin.json に agents キーが存在しない（plugin-root agents/ ディレクトリ規約を使う）" {
    for name in "${PLUGIN_NAMES[@]}"; do
        pj="$(plugin_json_path "$name")"
        run jq -r 'has("agents")' "$pj"
        [ "$status" -eq 0 ]
        [ "$output" = "false" ]
    done
}

@test "各 plugin.json の version が marketplace.json の対応 plugins[].version と一致する" {
    for name in "${PLUGIN_NAMES[@]}"; do
        pj="$(plugin_json_path "$name")"
        plugin_version="$(jq -r '.version' "$pj")"
        marketplace_version="$(jq -r --arg n "$name" '.plugins[] | select(.name == $n) | .version' "$MARKETPLACE_JSON")"
        [ -n "$plugin_version" ]
        [ "$plugin_version" = "$marketplace_version" ]
    done
}

@test "各 plugin.json の version は 0.2.0 より上の semver である" {
    for name in "${PLUGIN_NAMES[@]}"; do
        pj="$(plugin_json_path "$name")"
        run jq -r '.version' "$pj"
        [ "$status" -eq 0 ]
        [ "$output" != "0.2.0" ]
        [[ "$output" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
    done
}

@test "dev-flow の plugin.json の workflows は [\"./.claude/workflows\"] に完全一致する" {
    pj="$(plugin_json_path dev-flow)"
    run jq -c '.workflows' "$pj"
    [ "$status" -eq 0 ]
    [ "$output" = '["./.claude/workflows"]' ]
}

@test "dev-flow の workflows ディレクトリに 5 本の js が存在する" {
    dir="$REPO_ROOT/plugins/dev-flow/.claude/workflows"
    [ -f "$dir/dev-flow.js" ]
    [ -f "$dir/pr-iterate.js" ]
    [ -f "$dir/dev-improve.js" ]
    [ -f "$dir/dev-flow-canary.js" ]
    [ -f "$dir/dev-flow-canary-child.js" ]
}

@test "dev-flow の plugin.json の dependencies は [\"playpark-core\"] に完全一致する" {
    pj="$(plugin_json_path dev-flow)"
    run jq -c '.dependencies' "$pj"
    [ "$status" -eq 0 ]
    [ "$output" = '["playpark-core"]' ]
}

@test "playpark-skills の plugin.json の dependencies は [\"playpark-core\"] に完全一致する" {
    pj="$(plugin_json_path playpark-skills)"
    run jq -c '.dependencies' "$pj"
    [ "$status" -eq 0 ]
    [ "$output" = '["playpark-core"]' ]
}

@test "playpark-core / playpark-skills の plugin.json に workflows キーが存在しない" {
    for name in playpark-core playpark-skills; do
        pj="$(plugin_json_path "$name")"
        run jq -r 'has("workflows")' "$pj"
        [ "$status" -eq 0 ]
        [ "$output" = "false" ]
    done
}

@test "dev-flow/agents は実ファイルのディレクトリである（symlink にしない）" {
    dir="$REPO_ROOT/plugins/dev-flow/agents"
    [ -d "$dir" ]
    [ ! -L "$dir" ]
    run git -C "$REPO_ROOT" ls-files -s plugins/dev-flow/agents
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    [[ "$output" != *"120000 "* ]]
}

@test "dev-flow/.claude/agents は ../agents への symlink で、git 上も mode 120000 である" {
    link="$REPO_ROOT/plugins/dev-flow/.claude/agents"
    [ -L "$link" ]
    run readlink "$link"
    [ "$status" -eq 0 ]
    [ "$output" = "../agents" ]
    run git -C "$REPO_ROOT" ls-files -s plugins/dev-flow/.claude/agents
    [ "$status" -eq 0 ]
    [[ "$output" == 120000\ * ]]
}

@test "dev-flow/.claude/agents 経由で agents/*.md が解決でき、同一集合である" {
    real_dir="$REPO_ROOT/plugins/dev-flow/agents"
    link_dir="$REPO_ROOT/plugins/dev-flow/.claude/agents"
    listed="$(cd "$real_dir" && /bin/ls -1 *.md | sort)"
    via_symlink="$(cd "$link_dir" && /bin/ls -1 *.md | sort)"
    [ -n "$listed" ]
    [ "$listed" = "$via_symlink" ]
}

@test "dev-flow の manifest の description が謳う agent 数は実際の agents/*.md 件数と一致する" {
    real_dir="$REPO_ROOT/plugins/dev-flow/agents"
    actual="$(cd "$real_dir" && /bin/ls -1 *.md | wc -l | tr -d ' ')"
    pj="$(plugin_json_path dev-flow)"
    for desc in "$(jq -r '.description' "$pj")" \
                "$(jq -r '.plugins[] | select(.name=="dev-flow") | .description' "$MARKETPLACE_JSON")"; do
        claimed="$(echo "$desc" | grep -oE '[0-9]+ dev-flow agents' | grep -oE '^[0-9]+' || true)"
        if [ -n "$claimed" ]; then
            [ "$claimed" = "$actual" ]
        fi
    done
}

@test "claude CLI が dev-flow plugin から agent を実際に読み込める（実挙動の pin）" {
    command -v claude >/dev/null 2>&1 || skip "claude CLI not available"
    real_dir="$REPO_ROOT/plugins/dev-flow/agents"
    actual="$(cd "$real_dir" && /bin/ls -1 *.md | wc -l | tr -d ' ')"
    run claude --plugin-dir "$REPO_ROOT/plugins/dev-flow" plugin details dev-flow
    [ "$status" -eq 0 ]
    [[ "$output" == *"Agents ($actual)"* ]]
}
