#!/usr/bin/env bash
# detect-worker.sh — Detect whether the dev-kickoff-worker subagent path is usable.
#
# Usage: detect-worker.sh
# Output: JSON object with at least `available` and `reason` fields.
# Exit code: 0 if worker is available, 1 if any check fails (caller should fall back to legacy git-prepare).
#
# Three checks performed in order:
#   1. .claude/agents/dev-kickoff-worker.md exists (relative to git toplevel)
#   2. `claude --version` returns a parseable semver
#   3. Parsed version >= MIN_VERSION (subagent isolation:worktree shipped in 2.1.63)

set -euo pipefail

MIN_VERSION="2.1.63"

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -z "$REPO_ROOT" ]]; then
    echo "{\"available\":false,\"reason\":\"not_a_git_repo\",\"min_version\":\"$MIN_VERSION\"}"
    exit 1
fi

AGENT_FILE="$REPO_ROOT/.claude/agents/dev-kickoff-worker.md"

# Check 1: agent definition file
if [[ ! -f "$AGENT_FILE" ]]; then
    echo "{\"available\":false,\"reason\":\"agent_missing\",\"min_version\":\"$MIN_VERSION\",\"agent_path\":\"$AGENT_FILE\"}"
    exit 1
fi

# Check 2: claude CLI version
CLAUDE_VERSION=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [[ -z "$CLAUDE_VERSION" ]]; then
    echo "{\"available\":false,\"reason\":\"claude_not_found\",\"min_version\":\"$MIN_VERSION\"}"
    exit 1
fi

# Check 3: version >= MIN_VERSION (sort -V -C: 0 if input is sorted ascending)
if ! printf '%s\n%s\n' "$MIN_VERSION" "$CLAUDE_VERSION" | sort -V -C; then
    echo "{\"available\":false,\"reason\":\"version_too_old\",\"min_version\":\"$MIN_VERSION\",\"claude_version\":\"$CLAUDE_VERSION\"}"
    exit 1
fi

echo "{\"available\":true,\"min_version\":\"$MIN_VERSION\",\"claude_version\":\"$CLAUDE_VERSION\",\"agent_path\":\"$AGENT_FILE\"}"
exit 0
