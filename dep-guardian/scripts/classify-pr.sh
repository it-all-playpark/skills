#!/usr/bin/env bash
# classify-pr.sh - Classify a single PR's risk level
# Usage: classify-pr.sh --title "PR_TITLE" --body "PR_BODY" [--is-dev-dep]
# Output: JSON with risk level and details

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Args
# ============================================================================

TITLE=""
BODY=""
IS_DEV_DEP=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --title) TITLE="$2"; shift 2 ;;
        --body) BODY="$2"; shift 2 ;;
        --is-dev-dep) IS_DEV_DEP=true; shift ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

[[ -n "$TITLE" ]] || die_json "Missing required --title" 1

# ============================================================================
# Version Parsing
# ============================================================================

PACKAGE=""
FROM_VER=""
TO_VER=""

# Renovate format: "Update dependency package to vX.Y.Z" or "package X.Y.Z → A.B.C"
# Dependabot format: "Bump package from X.Y.Z to A.B.C"
parse_versions() {
    local title="$1"

    # Dependabot: "Bump <package> from <ver> to <ver>"
    if [[ "$title" =~ [Bb]ump[[:space:]]+([^[:space:]]+)[[:space:]]+from[[:space:]]+v?([0-9]+\.[0-9]+\.[0-9]+[^[:space:]]*)[[:space:]]+to[[:space:]]+v?([0-9]+\.[0-9]+\.[0-9]+[^[:space:]]*) ]]; then
        PACKAGE="${BASH_REMATCH[1]}"
        FROM_VER="${BASH_REMATCH[2]}"
        TO_VER="${BASH_REMATCH[3]}"
        return 0
    fi

    # Renovate: "Update dependency <package> to vX.Y.Z" (no from version)
    if [[ "$title" =~ [Uu]pdate[[:space:]]+dependency[[:space:]]+([^[:space:]]+)[[:space:]]+to[[:space:]]+v?([0-9]+\.[0-9]+\.[0-9]+[^[:space:]]*) ]]; then
        PACKAGE="${BASH_REMATCH[1]}"
        TO_VER="${BASH_REMATCH[2]}"
        return 0
    fi

    # Renovate arrow format: "<package> X.Y.Z → A.B.C" or "X.Y.Z -> A.B.C"
    if [[ "$title" =~ ([^[:space:]]+)[[:space:]]+v?([0-9]+\.[0-9]+\.[0-9]+[^[:space:]]*)[[:space:]]+(→|->)[[:space:]]+v?([0-9]+\.[0-9]+\.[0-9]+[^[:space:]]*) ]]; then
        PACKAGE="${BASH_REMATCH[1]}"
        FROM_VER="${BASH_REMATCH[2]}"
        TO_VER="${BASH_REMATCH[4]}"
        return 0
    fi

    return 1
}

# ============================================================================
# Risk Classification
# ============================================================================

classify_risk() {
    local from="$1"
    local to="$2"

    # Extract major.minor.patch
    local from_major from_minor from_patch
    local to_major to_minor to_patch

    IFS='.' read -r to_major to_minor to_patch <<< "${to%%[-+]*}"

    if [[ -z "$from" ]]; then
        # No from version (e.g., renovate "Update dependency X to vY")
        # Cannot determine bump type, default to minor
        echo "minor"
        return
    fi

    IFS='.' read -r from_major from_minor from_patch <<< "${from%%[-+]*}"

    if [[ "$from_major" != "$to_major" ]]; then
        echo "major"
    elif [[ "$from_minor" != "$to_minor" ]]; then
        echo "minor"
    else
        echo "patch"
    fi
}

check_breaking_keywords() {
    local body="$1"
    local body_lower
    body_lower=$(echo "$body" | tr '[:upper:]' '[:lower:]')

    if [[ "$body_lower" == *"breaking change"* ]] || \
       [[ "$body_lower" == *"breaking"* && "$body_lower" == *"migration"* ]] || \
       [[ "$body" == *"BREAKING"* ]]; then
        return 0
    fi
    return 1
}

# ============================================================================
# Main
# ============================================================================

if ! parse_versions "$TITLE"; then
    echo "{\"risk\":\"unknown\",\"package\":null,\"from\":null,\"to\":null,\"is_dev_dep\":$IS_DEV_DEP,\"error\":\"Could not parse version from title\"}"
    exit 0
fi

RISK="unknown"
if [[ -n "$TO_VER" ]]; then
    RISK=$(classify_risk "$FROM_VER" "$TO_VER")
fi

# Check for breaking change keywords in body
if [[ -n "$BODY" ]] && check_breaking_keywords "$BODY"; then
    RISK="breaking"
fi

echo "{\"risk\":$(json_str "$RISK"),\"package\":$(json_str "$PACKAGE"),\"from\":$(json_str "$FROM_VER"),\"to\":$(json_str "$TO_VER"),\"is_dev_dep\":$IS_DEV_DEP}"
