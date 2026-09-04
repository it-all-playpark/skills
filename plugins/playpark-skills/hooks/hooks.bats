#!/usr/bin/env bats
# Tests for plugins/playpark-skills/hooks/hooks.json
# Pins: SessionStart(startup) launches zombie-kill.sh via ${CLAUDE_PLUGIN_ROOT}
# (no ~/.claude/skills absolute-path dependency).

setup() {
  PLUGIN_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  HOOKS_JSON="$PLUGIN_ROOT/hooks/hooks.json"
}

@test "hooks.json is valid JSON" {
  run jq -e . "$HOOKS_JSON"
  [ "$status" -eq 0 ]
}

@test "SessionStart matcher is startup" {
  run jq -r '.hooks.SessionStart[0].matcher' "$HOOKS_JSON"
  [ "$status" -eq 0 ]
  [ "$output" = "startup" ]
}

@test "command references CLAUDE_PLUGIN_ROOT zombie-kill.sh with --force --min-hours 48" {
  run jq -r '.hooks.SessionStart[0].hooks[0].command' "$HOOKS_JSON"
  [ "$status" -eq 0 ]
  [[ "$output" == *'${CLAUDE_PLUGIN_ROOT}/claude-zombie-kill/scripts/zombie-kill.sh'* ]]
  [[ "$output" == *"--force --min-hours 48"* ]]
}

@test "resolved zombie-kill.sh exists and is executable" {
  run jq -r '.hooks.SessionStart[0].hooks[0].command' "$HOOKS_JSON"
  [ "$status" -eq 0 ]
  resolved="${output//\$\{CLAUDE_PLUGIN_ROOT\}/$PLUGIN_ROOT}"
  [[ "$resolved" == *"$PLUGIN_ROOT/claude-zombie-kill/scripts/zombie-kill.sh"* ]]
  [ -x "$PLUGIN_ROOT/claude-zombie-kill/scripts/zombie-kill.sh" ]
}

@test "zombie-kill.sh passes bash syntax check" {
  run bash -n "$PLUGIN_ROOT/claude-zombie-kill/scripts/zombie-kill.sh"
  [ "$status" -eq 0 ]
}

@test "command does not depend on ~/.claude/skills or \$HOME" {
  run jq -r '.hooks.SessionStart[0].hooks[0].command' "$HOOKS_JSON"
  [ "$status" -eq 0 ]
  [[ "$output" != *'.claude/skills'* ]]
  [[ "$output" != *'$HOME'* ]]
}
