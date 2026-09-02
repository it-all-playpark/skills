#!/usr/bin/env bash
# tools/sync-agents.sh
#
# Syncs plugin-root agents/*.md from the canonical .claude/agents/*.md.
#
# Claude Code plugins load subagents from a plugin-root `agents/` directory
# (not from `.claude/agents/`, and not from a plugin.json "agents" key —
# `claude plugin details` confirmed 0 agents loaded when the manifest only
# declared "agents": [".claude/agents/*.md"], see issue #568 PR #575 review).
# `.claude/agents/` stays canonical because it's what the repo's own
# dev-flow Task/Agent tool calls resolve against; agents/ is a plugin-load
# mirror kept byte-identical via this script.
#
# Usage:
#   tools/sync-agents.sh --check   # CI: exit 1 if agents/ drifts from .claude/agents/
#   tools/sync-agents.sh --write   # regenerate agents/ from .claude/agents/ (default)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/.claude/agents"
DEST_DIR="$REPO_ROOT/agents"

MODE="write"
if [[ "${1:-}" == "--check" ]]; then
    MODE="check"
elif [[ "${1:-}" == "--write" ]]; then
    MODE="write"
fi

if [[ ! -d "$SRC_DIR" ]]; then
    echo "[sync-agents] $SRC_DIR not found." >&2
    exit 1
fi

if [[ "$MODE" == "check" ]]; then
    STATUS=0
    if [[ ! -d "$DEST_DIR" ]]; then
        echo "[sync-agents] $DEST_DIR is missing." >&2
        exit 1
    fi
    DIFF_TMP="$(mktemp)"
    if ! diff -rq "$SRC_DIR" "$DEST_DIR" >"$DIFF_TMP" 2>&1; then
        cat "$DIFF_TMP" >&2
        STATUS=1
    fi
    rm -f "$DIFF_TMP"
    if [[ "$STATUS" -ne 0 ]]; then
        echo "[sync-agents] agents/ is out of sync with .claude/agents/. Run: tools/sync-agents.sh --write" >&2
        exit 1
    fi
    echo "[sync-agents] agents/ matches .claude/agents/."
    exit 0
fi

mkdir -p "$DEST_DIR"
# Remove stale files in DEST_DIR that no longer exist in SRC_DIR.
for existing in "$DEST_DIR"/*.md; do
    [[ -e "$existing" ]] || continue
    base="$(basename "$existing")"
    if [[ ! -f "$SRC_DIR/$base" ]]; then
        rm -f "$existing"
    fi
done

for src in "$SRC_DIR"/*.md; do
    [[ -e "$src" ]] || continue
    cp "$src" "$DEST_DIR/$(basename "$src")"
done

echo "[sync-agents] agents/ synced from .claude/agents/."
