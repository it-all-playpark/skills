#!/usr/bin/env bats
# plugin-manifest.bats - Regression tests for .claude-plugin/{plugin,marketplace}.json.
#
# Pins the invariants required by issue #568: repo is distributed as a
# single Claude Code plugin, skills stay flat at repo root, agents are
# pulled from .claude/agents/, and the "workflows" key is never added
# (reserved for #569).

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
PLUGIN_JSON="$REPO_ROOT/.claude-plugin/plugin.json"
MARKETPLACE_JSON="$REPO_ROOT/.claude-plugin/marketplace.json"

@test "plugin.json が存在する" {
    [ -f "$PLUGIN_JSON" ]
}

@test "marketplace.json が存在する" {
    [ -f "$MARKETPLACE_JSON" ]
}

@test "plugin.json は valid JSON" {
    run jq empty "$PLUGIN_JSON"
    [ "$status" -eq 0 ]
}

@test "marketplace.json は valid JSON" {
    run jq empty "$MARKETPLACE_JSON"
    [ "$status" -eq 0 ]
}

@test "plugin.json の name は playpark-skills" {
    run jq -r '.name' "$PLUGIN_JSON"
    [ "$status" -eq 0 ]
    [ "$output" = "playpark-skills" ]
}

@test "plugin.json の skills は [\"./\"] に完全一致する" {
    run jq -c '.skills' "$PLUGIN_JSON"
    [ "$status" -eq 0 ]
    [ "$output" = '["./"]' ]
}

@test "plugin.json の agents は .claude/agents/ 配下の *.md ファイルパス配列である" {
    # `claude plugin validate` の実測により、agents フィールドはディレクトリや
    # glob を受理せず、実在する *.md ファイルパスの配列のみを受理することを
    # 確認済み（issue の想定と異なる実挙動）。ここではそのファイルパス形式を
    # invariant として pin する。
    run jq -r '.agents[]' "$PLUGIN_JSON"
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    while IFS= read -r entry; do
        [[ "$entry" == ./.claude/agents/*.md ]]
    done <<< "$output"
}

@test "plugin.json に workflows キーが存在しない（invariant pin）" {
    run jq -r 'has("workflows")' "$PLUGIN_JSON"
    [ "$status" -eq 0 ]
    [ "$output" = "false" ]
}

@test "marketplace.json の name は playpark" {
    run jq -r '.name' "$MARKETPLACE_JSON"
    [ "$status" -eq 0 ]
    [ "$output" = "playpark" ]
}

@test "marketplace.json の plugins は 1 件" {
    run jq -r '.plugins | length' "$MARKETPLACE_JSON"
    [ "$status" -eq 0 ]
    [ "$output" = "1" ]
}

@test "marketplace.json の plugins[0].name は playpark-skills" {
    run jq -r '.plugins[0].name' "$MARKETPLACE_JSON"
    [ "$status" -eq 0 ]
    [ "$output" = "playpark-skills" ]
}

@test "marketplace.json の plugins[0].source は ./" {
    run jq -r '.plugins[0].source' "$MARKETPLACE_JSON"
    [ "$status" -eq 0 ]
    [ "$output" = "./" ]
}

@test "plugin.json と marketplace.json の version が一致する" {
    plugin_version="$(jq -r '.version' "$PLUGIN_JSON")"
    marketplace_version="$(jq -r '.plugins[0].version' "$MARKETPLACE_JSON")"
    [ -n "$plugin_version" ]
    [ "$plugin_version" = "$marketplace_version" ]
}

@test "plugin.json の agents は 11 件で、全ファイルが実在する" {
    count="$(jq -r '.agents | length' "$PLUGIN_JSON")"
    [ "$count" = "11" ]

    while IFS= read -r entry; do
        [ -f "$REPO_ROOT/${entry#./}" ]
    done < <(jq -r '.agents[]' "$PLUGIN_JSON")
}

@test "plugin.json の agents 列挙は .claude/agents/*.md と完全一致する（drift 検知）" {
    listed="$(jq -r '.agents[]' "$PLUGIN_JSON" | xargs -n1 basename | sort)"
    actual="$(cd "$REPO_ROOT/.claude/agents" && /bin/ls -1 *.md | sort)"
    [ "$listed" = "$actual" ]
}
