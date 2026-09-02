#!/usr/bin/env bats
# plugin-manifest.bats - Regression tests for .claude-plugin/{plugin,marketplace}.json.
#
# Pins the invariants required by issue #568: the repo is distributed as a
# single Claude Code plugin, skills stay flat at repo root, and the
# "workflows" key is never added (reserved for #569).
#
# Agent definitions live in the plugin-root agents/ directory as REAL FILES,
# with .claude/agents as a symlink pointing back at it. Both halves matter:
#
#   - plugin subagents are only ever loaded from plugin-root agents/. A
#     plugin.json "agents" key is not a substitute (measured: Agents (0)).
#   - agents/ must be the real directory, not the symlink. git checks out a
#     mode-120000 entry as a plain text file wherever symlinks are
#     unavailable (Windows without Developer Mode, core.symlinks=false), so
#     putting the symlink on agents/ makes a consumer's install silently
#     degrade to Agents (0) while skills still load — measured, not
#     theoretical. With this direction the same environment only loses
#     .claude/agents, which affects developing this repo, never consuming it.
#   - keeping .claude/agents as a symlink (rather than a copy) means the
#     definitions exist exactly once; a mirror drifts the moment one side is
#     edited alone.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
PLUGIN_JSON="$REPO_ROOT/.claude-plugin/plugin.json"
MARKETPLACE_JSON="$REPO_ROOT/.claude-plugin/marketplace.json"
PLUGIN_AGENTS_DIR="$REPO_ROOT/agents"
CANONICAL_AGENTS_DIR="$REPO_ROOT/.claude/agents"

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

@test "plugin.json に agents キーが存在しない（plugin-root agents/ ディレクトリ規約を使う）" {
    run jq -r 'has("agents")' "$PLUGIN_JSON"
    [ "$status" -eq 0 ]
    [ "$output" = "false" ]
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

@test "plugin root の agents は実ファイルのディレクトリである（symlink にしない）" {
    # symlink にすると core.symlinks=false の環境で plain file に化け、
    # consumer の install が Agents (0) に silent degrade する
    [ -d "$PLUGIN_AGENTS_DIR" ]
    [ ! -L "$PLUGIN_AGENTS_DIR" ]
    run git -C "$REPO_ROOT" ls-files -s agents
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    [[ "$output" != *"120000 "* ]]
}

@test ".claude/agents は ../agents への symlink で、git 上も mode 120000 である" {
    [ -L "$CANONICAL_AGENTS_DIR" ]
    run readlink "$CANONICAL_AGENTS_DIR"
    [ "$status" -eq 0 ]
    [ "$output" = "../agents" ]
    run git -C "$REPO_ROOT" ls-files -s .claude/agents
    [ "$status" -eq 0 ]
    [[ "$output" == 120000\ * ]]
}

@test ".claude/agents 経由で agents/*.md が解決でき、同一集合である" {
    listed="$(cd "$PLUGIN_AGENTS_DIR" && /bin/ls -1 *.md | sort)"
    via_symlink="$(cd "$CANONICAL_AGENTS_DIR" && /bin/ls -1 *.md | sort)"
    [ -n "$listed" ]
    [ "$listed" = "$via_symlink" ]
}

@test "manifest の description が謳う agent 数は実際の agents/*.md 件数と一致する" {
    # description に数を書く以上、agent 追加時に silent drift させない
    actual="$(cd "$PLUGIN_AGENTS_DIR" && /bin/ls -1 *.md | wc -l | tr -d ' ')"
    for desc in "$(jq -r '.description' "$PLUGIN_JSON")" \
                "$(jq -r '.description' "$MARKETPLACE_JSON")" \
                "$(jq -r '.plugins[0].description' "$MARKETPLACE_JSON")"; do
        claimed="$(echo "$desc" | grep -oE '[0-9]+ dev-flow agents' | grep -oE '^[0-9]+' || true)"
        if [ -n "$claimed" ]; then
            [ "$claimed" = "$actual" ]
        fi
    done
}

@test "claude CLI が plugin から agent を実際に読み込める（実挙動の pin）" {
    command -v claude >/dev/null 2>&1 || skip "claude CLI not available"
    actual="$(cd "$PLUGIN_AGENTS_DIR" && /bin/ls -1 *.md | wc -l | tr -d ' ')"
    run claude --plugin-dir "$REPO_ROOT" plugin details playpark-skills
    [ "$status" -eq 0 ]
    [[ "$output" == *"Agents ($actual)"* ]]
}
