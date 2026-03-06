#!/usr/bin/env bash
# detect-stack.sh - Detect framework/tech stack and map to best-practice skills
# Usage: detect-stack.sh [project-dir]
# Output: JSON with detected frameworks and corresponding skill references

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common.sh"

DIR="${1:-.}"
cd "$DIR" || die_json "Cannot access directory: $DIR"

# Resolve skills directory for existence checks
: "${SKILLS_DIR:=$(cd "$SCRIPT_DIR/../.." && pwd)}"

# ============================================================================
# Detection helpers
# ============================================================================

FRAMEWORKS=()
SKILLS=()
RULES_PATHS=()

add_skill() {
    local framework="$1" skill="$2"
    # Only add if the skill directory actually exists (installed)
    if [[ -d "$SKILLS_DIR/$skill" ]]; then
        FRAMEWORKS+=("$framework")
        SKILLS+=("$skill")
        RULES_PATHS+=("$skill/SKILL.md")
    fi
}

# ============================================================================
# package.json detection
# ============================================================================

if [[ -f "package.json" ]] && has_jq; then
    deps=$(jq -r '(.dependencies // {}) + (.devDependencies // {}) | keys[]' package.json 2>/dev/null || true)

    # React / Next.js
    if echo "$deps" | grep -qE '^(next|@next/)'; then
        add_skill "next" "vercel-react-best-practices"
    elif echo "$deps" | grep -qE '^react$'; then
        add_skill "react" "vercel-react-best-practices"
    fi

    # Fastify
    if echo "$deps" | grep -qE '^fastify$'; then
        add_skill "fastify" "fastify-best-practices"
    fi

    # Remotion
    if echo "$deps" | grep -qE '^(remotion|@remotion/)'; then
        add_skill "remotion" "remotion-best-practices"
    fi

    # Prisma
    if echo "$deps" | grep -qE '^(@prisma/client|prisma)$'; then
        add_skill "prisma" "prisma-cli"
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
    add_skill "neon" "neon-postgres"
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
        --argjson skills "$(arr_to_jq_array "${SKILLS[@]+"${SKILLS[@]}"}")" \
        --argjson paths "$(arr_to_jq_array "${RULES_PATHS[@]+"${RULES_PATHS[@]}"}")" \
        '{
            frameworks: $frameworks,
            best_practice_skills: $skills,
            rules_paths: $paths
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
  "frameworks": $(to_json_array "${FRAMEWORKS[@]+"${FRAMEWORKS[@]}"}"),
  "best_practice_skills": $(to_json_array "${SKILLS[@]+"${SKILLS[@]}"}"),
  "rules_paths": $(to_json_array "${RULES_PATHS[@]+"${RULES_PATHS[@]}"}")
}
JSONEOF
fi
