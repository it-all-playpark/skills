#!/usr/bin/env bash
# load-context.sh - Gather deterministic context for session initialization
# Usage: load-context.sh [--refresh]
#
# Output: JSON with loaded context summary

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Args
# ============================================================================

REFRESH=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --refresh) REFRESH=true; shift ;;
        -h|--help)
            echo "Usage: load-context.sh [--refresh]"
            exit 0
            ;;
        *) shift ;;
    esac
done

# ============================================================================
# 1. Sync agent skills
# ============================================================================

SYNCED_SKILLS=false
LINK_SCRIPT="$SKILLS_DIR/_lib/infra/link-agent-skills.sh"
if [[ -x "$LINK_SCRIPT" ]]; then
    if "$LINK_SCRIPT" &>/dev/null; then
        SYNCED_SKILLS=true
    fi
fi

# ============================================================================
# 2. Detect project name
# ============================================================================

PROJECT=""
GIT_ROOT=""
if GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    PROJECT="$(basename "$GIT_ROOT")"
fi

if [[ -z "$PROJECT" ]]; then
    # Fallback: use current directory name
    PROJECT="$(basename "$PWD")"
fi

# ============================================================================
# 3-4. Search memvid memories
# ============================================================================

PROJECT_MEMORIES="[]"
GLOBAL_MEMORIES="[]"

if command -v memvid &>/dev/null; then
    QUERY="$PROJECT 最近のセッション"

    # Project memories
    PROJECT_MV2=""
    if [[ -n "$GIT_ROOT" ]]; then
        PROJECT_MV2="$GIT_ROOT/.claude/memory/project.mv2"
    fi

    if [[ -n "$PROJECT_MV2" && -f "$PROJECT_MV2" ]]; then
        PROJECT_MEMORIES=$(memvid find "$PROJECT_MV2" \
            --query "$QUERY" \
            --mode sem --top-k 3 --json 2>/dev/null) || PROJECT_MEMORIES="[]"
    fi

    # Global memories
    GLOBAL_MV2="$HOME/.claude/memory/global.mv2"
    if [[ -f "$GLOBAL_MV2" ]]; then
        GLOBAL_MEMORIES=$(memvid find "$GLOBAL_MV2" \
            --query "$QUERY" \
            --mode sem --top-k 3 --json 2>/dev/null) || GLOBAL_MEMORIES="[]"
    fi
fi

# ============================================================================
# 5. Output JSON
# ============================================================================

cat <<EOF
{
  "project": $(json_str "$PROJECT"),
  "memories": {
    "project": $PROJECT_MEMORIES,
    "global": $GLOBAL_MEMORIES
  },
  "synced_skills": $SYNCED_SKILLS
}
EOF
