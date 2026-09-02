#!/usr/bin/env bats
# plugin-manifest.bats - Regression tests for .claude-plugin/{plugin,marketplace}.json.
#
# Pins the invariants required by issue #568: repo is distributed as a
# single Claude Code plugin, skills stay flat at repo root, agents are
# loaded from the plugin-root agents/ directory — a symlink to the canonical
# .claude/agents/, so the agent definitions exist exactly once (`claude
# plugin details` confirmed both that a plugin.json "agents" key pointing at
# .claude/agents/ loads 0 agents, and that the agents -> .claude/agents
# symlink loads all 11) — and the "workflows" key is never added
# (reserved for #569).
#
# agents/ must stay a symlink, not a copy: a byte-identical mirror silently
# drifts the moment one side is edited alone, and .claude/agents/ has to stay
# the real directory because the repo's own dev-flow Task/Agent calls resolve
# against it.

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

@test "plugin root の agents は .claude/agents への symlink である（実体の二重化を防ぐ）" {
    [ -L "$PLUGIN_AGENTS_DIR" ]
    run readlink "$PLUGIN_AGENTS_DIR"
    [ "$status" -eq 0 ]
    [ "$output" = ".claude/agents" ]
}

@test "agents は git 上も symlink (mode 120000) として記録されている" {
    run git -C "$REPO_ROOT" ls-files -s agents
    [ "$status" -eq 0 ]
    [[ "$output" == 120000\ * ]]
}

@test "agents/ 経由で *.md が 11 件解決でき、.claude/agents/ と一致する" {
    [ -d "$PLUGIN_AGENTS_DIR" ]
    listed="$(cd "$PLUGIN_AGENTS_DIR" && /bin/ls -1 *.md | sort)"
    actual="$(cd "$CANONICAL_AGENTS_DIR" && /bin/ls -1 *.md | sort)"
    count="$(echo "$listed" | wc -l | tr -d ' ')"
    [ "$count" = "11" ]
    [ "$listed" = "$actual" ]
}
