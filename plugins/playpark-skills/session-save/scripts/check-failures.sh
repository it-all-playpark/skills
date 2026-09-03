#!/usr/bin/env bash
# check-failures.sh - Check for unanalyzed journal failures
# Usage: check-failures.sh
#
# Output: JSON with failure count

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

# ============================================================================
# Query journal for failures
# ============================================================================

JOURNAL_SCRIPT="$SKILLS_DIR/skill-retrospective/scripts/journal.sh"
FAILURE_COUNT=0

if [[ -x "$JOURNAL_SCRIPT" ]]; then
    RESULT=$("$JOURNAL_SCRIPT" query --outcome failure --limit 100 2>/dev/null) || RESULT="[]"
    if command -v jq &>/dev/null; then
        FAILURE_COUNT=$(echo "$RESULT" | jq 'length' 2>/dev/null) || FAILURE_COUNT=0
    fi
fi

# ============================================================================
# Output JSON
# ============================================================================

cat <<EOF
{"failure_count": $FAILURE_COUNT}
EOF
