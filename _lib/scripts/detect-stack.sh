#!/usr/bin/env bash
# detect-stack.sh - Detect framework/tech stack of a project
# Usage: detect-stack.sh [project-dir]
# Output: JSON {"frameworks": [...]} — framework 名のみ
#
# なぜ framework 検出を残すか: Implement phase で implementer が context7 を
# 呼ぶかどうかを判定する決定論的門番 (issue #497)。vendored skill への
# マッピング (best_practice_skills / rules_paths) は出力しない。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common.sh"

DIR="${1:-.}"
cd "$DIR" || die_json "Cannot access directory: $DIR"

# ============================================================================
# Detection helpers
# ============================================================================

FRAMEWORKS=()

add_framework() {
    FRAMEWORKS+=("$1")
}

# ============================================================================
# package.json detection
# ============================================================================

if [[ -f "package.json" ]] && has_jq; then
    deps=$(jq -r '(.dependencies // {}) + (.devDependencies // {}) | keys[]' package.json 2>/dev/null || true)

    # React / Next.js
    if echo "$deps" | grep -qE '^(next|@next/)'; then
        add_framework "next"
    elif echo "$deps" | grep -qE '^react$'; then
        add_framework "react"
    fi

    # Fastify
    if echo "$deps" | grep -qE '^fastify$'; then
        add_framework "fastify"
    fi

    # Remotion
    if echo "$deps" | grep -qE '^(remotion|@remotion/)'; then
        add_framework "remotion"
    fi

    # Prisma
    if echo "$deps" | grep -qE '^(@prisma/client|prisma)$'; then
        add_framework "prisma"
    fi
fi

# ============================================================================
# Neon Postgres detection (env files / connection strings)
# ============================================================================

detect_neon() {
    local files=(.env .env.local .env.development .env.production)
    for f in "${files[@]}"; do
        if [[ -f "$f" ]] && grep -q 'neon\.tech' "$f" 2>/dev/null; then
            return 0
        fi
    done
    # Also check for neon in package.json (e.g. @neondatabase/serverless)
    if [[ -f "package.json" ]] && grep -q 'neondatabase' package.json 2>/dev/null; then
        return 0
    fi
    return 1
}

if detect_neon; then
    add_framework "neon"
fi

# ============================================================================
# Output JSON
# ============================================================================

arr_to_jq_array() {
    if [[ $# -eq 0 ]]; then
        echo "[]"
    else
        printf '%s\n' "$@" | jq -R . | jq -s .
    fi
}

if has_jq; then
    jq -n \
        --argjson frameworks "$(arr_to_jq_array "${FRAMEWORKS[@]+"${FRAMEWORKS[@]}"}")" \
        '{
            frameworks: $frameworks
        }'
else
    # Fallback: manual JSON construction
    to_json_array() {
        local first=true
        echo -n "["
        for item in "$@"; do
            [[ "$first" == true ]] || echo -n ","
            first=false
            echo -n "\"$item\""
        done
        echo -n "]"
    }
    cat <<JSONEOF
{
  "frameworks": $(to_json_array "${FRAMEWORKS[@]+"${FRAMEWORKS[@]}"}")
}
JSONEOF
fi
