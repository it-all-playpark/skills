#!/usr/bin/env bats
# Tests for validate-skill-frontmatter.sh, invoked via the hooks.json
# PreToolUse(Write) command exactly as Claude Code would run it.

setup() {
  PLUGIN_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  CMD=$(jq -r '.hooks.PreToolUse[] | select(.matcher=="Write") | .hooks[0].command' "$PLUGIN_ROOT/hooks/hooks.json")
}

run_hook() {
  jq -n --arg c "$1" '{tool_name:"Write",tool_input:{file_path:"/x/SKILL.md",content:$c}}' \
    | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash -c "$CMD"
}

@test "hooks.json Write entry is scoped to SKILL.md via if" {
  run jq -r '.hooks.PreToolUse[] | select(.matcher=="Write") | .hooks[0].if' "$PLUGIN_ROOT/hooks/hooks.json"
  [ "$status" -eq 0 ]
  [ "$output" = "Write(*/SKILL.md)" ]
}

@test "content without frontmatter passes through (exit 0, no output)" {
  run run_hook $'# title\n\nno frontmatter here.'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "missing name is blocked" {
  run run_hook $'---\ndescription: x\n---'
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "block"'
  echo "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason' | grep -q "name"
}

@test "empty description is blocked" {
  run run_hook $'---\nname: foo\ndescription:\n---'
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "block"'
}

@test "invalid model is blocked" {
  run run_hook $'---\nname: foo\ndescription: does x\nmodel: foo\n---'
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "block"'
  echo "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason' | grep -q "Invalid model"
}

@test "invalid effort is blocked" {
  run run_hook $'---\nname: foo\ndescription: does x\neffort: turbo\n---'
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.permissionDecision == "block"'
  echo "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason' | grep -q "Invalid effort"
}

@test "valid frontmatter passes through (exit 0, no output)" {
  run run_hook $'---\nname: foo\ndescription: does x\nmodel: haiku\neffort: low\n---'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
