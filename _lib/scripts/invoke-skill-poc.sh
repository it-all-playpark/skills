#!/usr/bin/env bash
# invoke-skill-poc.sh — portable skill invocation across coding agents.
#
# Wraps the agent-specific spawn syntax behind a single function so a bash
# coordinator can target any of: Claude Code, Codex CLI, Antigravity (agy).
#
# This is the smoke-build that validates the adapter pattern documented in
# issue #103 (SKILL.md portable subset). Each agent ends up exposing the
# same surface: `AGENT_RUNTIME=<name> bash invoke-skill-poc.sh '<prompt>'`
# emits raw LLM response on stdout, progress on stderr.
#
# Usage:
#   AGENT_RUNTIME=claude bash invoke-skill-poc.sh '<prompt>'
#   AGENT_RUNTIME=codex  bash invoke-skill-poc.sh '<prompt>'
#   AGENT_RUNTIME=agy    bash invoke-skill-poc.sh '<prompt>'
#
# Env:
#   AGENT_RUNTIME  claude | codex | agy   (default: claude)
#   TIMEOUT_SEC    seconds                (default: 300)
#
# Exit codes:
#   0  success
#   1  invalid usage
#   2  agent runtime error (spawn/parse/etc)
#   3  timeout
#   4  unsupported AGENT_RUNTIME

set -euo pipefail

AGENT_RUNTIME="${AGENT_RUNTIME:-claude}"
TIMEOUT_SEC="${TIMEOUT_SEC:-300}"

usage() {
  cat <<EOF >&2
Usage: AGENT_RUNTIME=<claude|codex|agy> bash $0 '<prompt>'

Env:
  AGENT_RUNTIME  claude | codex | agy   (default: claude)
  TIMEOUT_SEC    timeout in seconds     (default: 300)

Output:
  stdout: raw LLM response
  stderr: progress / errors

Exit:
  0=success  1=usage  2=agent_error  3=timeout  4=unsupported_runtime
EOF
  exit 1
}

[ $# -eq 0 ] && usage
PROMPT="$1"

# resolve timeout binary across OS (macOS uses gtimeout from coreutils)
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
fi

run_with_timeout() {
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "${TIMEOUT_SEC}s" "$@"
  else
    # no timeout binary — best effort, run without enforced limit
    "$@"
  fi
}

#--- Claude Code: spawn via --bg, poll state.json, read timeline.jsonl ---
invoke_claude() {
  local prompt="$1"
  local spawn_out short_id
  spawn_out=$(claude --bg "$prompt" 2>&1)
  short_id=$(echo "$spawn_out" | grep -oE 'backgrounded · [a-f0-9]+' | awk '{print $3}' || true)

  if [ -z "$short_id" ]; then
    echo "[claude] spawn failed: $spawn_out" >&2
    return 2
  fi
  echo "[claude] spawned: $short_id" >&2

  local state_file="$HOME/.claude/jobs/$short_id/state.json"
  local timeline_file="$HOME/.claude/jobs/$short_id/timeline.jsonl"
  local max_iter=$(( TIMEOUT_SEC / 2 ))
  local iter=0
  local state="unknown"

  while [ "$iter" -lt "$max_iter" ]; do
    state=$(jq -r '.state' "$state_file" 2>/dev/null || echo "unknown")
    case "$state" in
      done) break ;;
      blocked|stopped|failed)
        local detail
        detail=$(jq -r '.detail' "$state_file" 2>/dev/null || echo "unknown")
        echo "[claude] state=$state: $detail" >&2
        return 2
        ;;
    esac
    sleep 2
    iter=$((iter + 1))
  done

  if [ "$state" != "done" ]; then
    echo "[claude] timeout after ${TIMEOUT_SEC}s (last state=$state)" >&2
    return 3
  fi

  if [ -f "$timeline_file" ]; then
    tail -1 "$timeline_file" | jq -r '.text'
  else
    echo "[claude] no timeline.jsonl (session may have been empty)" >&2
    return 2
  fi
}

#--- Codex CLI: codex exec --json --output-last-message <file>, sandbox read-only ---
invoke_codex() {
  local prompt="$1"
  local out
  out=$(mktemp -t codex-poc.XXXXXX)
  # shellcheck disable=SC2064
  trap "rm -f '$out'" RETURN

  echo "[codex] running exec (sandbox=read-only)" >&2
  if ! run_with_timeout codex exec \
      --json \
      --output-last-message "$out" \
      --sandbox read-only \
      "$prompt" >/dev/null 2>&1; then
    local rc=$?
    echo "[codex] exec failed (exit $rc)" >&2
    return 2
  fi

  if [ ! -s "$out" ]; then
    echo "[codex] empty output file" >&2
    return 2
  fi
  cat "$out"
}

#--- Antigravity (agy): agy -p, raw stdout ---
invoke_agy() {
  local prompt="$1"
  echo "[agy] running -p" >&2
  if ! run_with_timeout agy -p "$prompt"; then
    local rc=$?
    echo "[agy] -p failed (exit $rc)" >&2
    return 2
  fi
}

case "$AGENT_RUNTIME" in
  claude) invoke_claude "$PROMPT" ;;
  codex)  invoke_codex  "$PROMPT" ;;
  agy)    invoke_agy    "$PROMPT" ;;
  *)
    echo "Unsupported AGENT_RUNTIME: $AGENT_RUNTIME" >&2
    echo "Supported: claude, codex, agy" >&2
    exit 4
    ;;
esac
