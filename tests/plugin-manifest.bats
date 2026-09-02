#!/usr/bin/env bats
# plugin-manifest.bats - Regression tests for .claude-plugin/{plugin,marketplace}.json.
#
# Pins the invariants required by issue #568: repo is distributed as a
# single Claude Code plugin, skills stay flat at repo root, agents are
# loaded from the plugin-root agents/ directory (a byte-identical mirror of
# .claude/agents/ maintained by tools/sync-agents.sh — `claude plugin
# details` confirmed a plugin.json "agents" key pointing at .claude/agents/
# loads 0 agents, see PR #575 review), and the "workflows" key is never
# added (reserved for #569).

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
    # `claude --plugin-dir . plugin details playpark-skills` の実測により、
    # plugin.json の "agents" キーに .claude/agents/*.md へのパスを列挙しても
    # Agents (0) にしかならないことを確認済み（issue の想定と異なる実挙動）。
    # 実際に読み込まれるのは plugin root の agents/ ディレクトリ規約のみ
    # (実測: agents/ を追加した状態で Agents (11) を確認)。
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

@test "plugin root の agents/ ディレクトリが存在し、*.md が 11 件ある" {
    [ -d "$PLUGIN_AGENTS_DIR" ]
    count="$(cd "$PLUGIN_AGENTS_DIR" && /bin/ls -1 *.md | wc -l | tr -d ' ')"
    [ "$count" = "11" ]
}

@test "plugin root の agents/*.md は .claude/agents/*.md とファイル名が完全一致する（drift 検知）" {
    listed="$(cd "$PLUGIN_AGENTS_DIR" && /bin/ls -1 *.md | sort)"
    actual="$(cd "$CANONICAL_AGENTS_DIR" && /bin/ls -1 *.md | sort)"
    [ "$listed" = "$actual" ]
}

@test "plugin root の agents/*.md は .claude/agents/*.md と内容が byte-identical（tools/sync-agents.sh --check）" {
    run "$REPO_ROOT/tools/sync-agents.sh" --check
    [ "$status" -eq 0 ]
}
