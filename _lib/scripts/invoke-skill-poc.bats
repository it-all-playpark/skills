#!/usr/bin/env bats
# invoke-skill-poc.bats — regression for the portable adapter pattern.
#
# Live agent calls are gated by RUN_PORTABLE_POC_TESTS=1 (each call consumes
# subscription quota). Non-gated tests cover dry-run argument handling and
# runtime selection only.

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="$REPO_ROOT/_lib/scripts/invoke-skill-poc.sh"
  TEST_PROMPT='Reply ONLY this exact JSON, no markdown, no explanation: {"test":"ok","value":42}'
  EXPECTED='{"test":"ok","value":42}'
}

# --- dry checks (no API call) ---

@test "usage error when called without arguments" {
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
}

@test "exit 4 for unsupported AGENT_RUNTIME" {
  AGENT_RUNTIME=invalid run bash "$SCRIPT" "$TEST_PROMPT"
  [ "$status" -eq 4 ]
  [[ "$output" == *"Unsupported AGENT_RUNTIME"* ]]
}

# --- live agent calls (gated, consume quota) ---

@test "claude --bg returns expected JSON" {
  if [ "${RUN_PORTABLE_POC_TESTS:-0}" != "1" ]; then
    skip "set RUN_PORTABLE_POC_TESTS=1 to run live API tests"
  fi
  command -v claude >/dev/null || skip "claude CLI not installed"

  AGENT_RUNTIME=claude run bash "$SCRIPT" "$TEST_PROMPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"$EXPECTED"* ]]
}

@test "codex exec returns expected JSON" {
  if [ "${RUN_PORTABLE_POC_TESTS:-0}" != "1" ]; then
    skip "set RUN_PORTABLE_POC_TESTS=1 to run live API tests"
  fi
  command -v codex >/dev/null || skip "codex CLI not installed"

  AGENT_RUNTIME=codex run bash "$SCRIPT" "$TEST_PROMPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"$EXPECTED"* ]]
}

@test "agy -p returns expected JSON" {
  if [ "${RUN_PORTABLE_POC_TESTS:-0}" != "1" ]; then
    skip "set RUN_PORTABLE_POC_TESTS=1 to run live API tests"
  fi
  command -v agy >/dev/null || skip "agy CLI not installed"

  AGENT_RUNTIME=agy run bash "$SCRIPT" "$TEST_PROMPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"$EXPECTED"* ]]
}
