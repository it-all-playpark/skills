#!/usr/bin/env bash
# AC2: dev-kickoff/scripts/detect-worker.sh の 3 stage 検知ロジックを検証
# Cases: 通常 (agent + claude >= 2.1.63) / agent_missing / claude_not_found
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/dev-kickoff/scripts/detect-worker.sh"
AGENT_FILE="$REPO_ROOT/.claude/agents/dev-kickoff-worker.md"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

# Case 1: script exists and is executable
[[ -x "$SCRIPT" ]] || fail "Case 1: $SCRIPT not found or not executable"
pass "Case 1: detect-worker.sh exists and executable"

# Case 2: agent file present + claude version recent → exit 0 + JSON
[[ -f "$AGENT_FILE" ]] || fail "Case 2 prereq: agent file should exist"
# Detect current claude version (skip if claude CLI not available)
CURRENT_VERSION=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "")
if [[ -z "$CURRENT_VERSION" ]]; then
    echo "SKIP: Case 2 (claude CLI not available in test env)"
else
    # current >= 2.1.63 ?
    if printf '2.1.63\n%s\n' "$CURRENT_VERSION" | sort -V -C; then
        # current >= 2.1.63
        OUTPUT=$("$SCRIPT" 2>&1)
        echo "$OUTPUT" | jq -e '.available == true' >/dev/null \
            || fail "Case 2: should return available:true with agent + claude $CURRENT_VERSION"
        pass "Case 2: agent + claude $CURRENT_VERSION → available:true"
    else
        echo "SKIP: Case 2 (current claude $CURRENT_VERSION < 2.1.63)"
    fi
fi

# Case 3: agent file missing → exit 1, reason=agent_missing
AGENT_BAK="$AGENT_FILE.bak.$$"
mv "$AGENT_FILE" "$AGENT_BAK"
restore_agent() { [[ -f "$AGENT_BAK" ]] && mv "$AGENT_BAK" "$AGENT_FILE" 2>/dev/null || true; }
trap restore_agent EXIT

if "$SCRIPT" >/dev/null 2>&1; then
    restore_agent; fail "Case 3: should exit 1 when agent missing"
fi
OUTPUT=$("$SCRIPT" 2>&1 || true)
echo "$OUTPUT" | jq -e '.available == false and .reason == "agent_missing"' >/dev/null \
    || { restore_agent; fail "Case 3: should report reason=agent_missing, got: $OUTPUT"; }
pass "Case 3: agent_missing → exit 1, reason=agent_missing"

restore_agent
trap - EXIT

# Case 4: claude CLI not in PATH → exit 1, reason=claude_not_found
# (use restricted PATH to simulate missing CLI; keep coreutils available)
RESTRICTED_PATH="/usr/bin:/bin"
if env -i PATH="$RESTRICTED_PATH" HOME="$HOME" command -v claude >/dev/null 2>&1; then
    echo "SKIP: Case 4 (claude in $RESTRICTED_PATH, cannot simulate)"
else
    OUTPUT=$(env -i PATH="$RESTRICTED_PATH" HOME="$HOME" "$SCRIPT" 2>&1 || true)
    echo "$OUTPUT" | jq -e '.available == false and .reason == "claude_not_found"' >/dev/null \
        || fail "Case 4: should report reason=claude_not_found, got: $OUTPUT"
    pass "Case 4: claude not in PATH → reason=claude_not_found"
fi

echo "OK: tests/detect-worker.sh"
