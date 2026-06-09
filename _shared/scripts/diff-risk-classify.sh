#!/usr/bin/env bash
# diff-risk-classify.sh - dev-flow W1 deterministic danger-grep on realized diff.
#
# Purpose: Grep the REALIZED git diff (actual written changes, not proposed/issue text)
# between a base ref and HEAD for 7 danger classes and print hit files as a JSON array
# to stdout. Called directly from workflow JS. Ungameable critical floor -- severity is
# ALWAYS "critical" and cannot be lowered by any flag or input.
#
# Usage: diff-risk-classify.sh <base-ref>
# Output: JSON array of {file, class, severity:"critical"} objects (stdout)
# Exit: 0 on success (even with empty hits), non-zero via die_json on error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=../../_lib/common.sh
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Args
# ============================================================================

BASE="${1:-}"
if [[ -z "$BASE" ]]; then
    die_json "<base-ref> required" 2
fi

require_git_repo

# Validate the base ref resolves to a commit.
# Use set +e / RC capture instead of "if \!" to avoid history-expansion issues
# and set -e interactions across bash invocations.
set +e
git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1
_BASE_RC=$?
set -e
if [[ "$_BASE_RC" -ne 0 ]]; then
    die_json "invalid base ref: $BASE" 2
fi

# ============================================================================
# Collect changed files
# ============================================================================

files="$(git diff --name-only "${BASE}...HEAD" 2>/dev/null)" || files=""

if [[ -z "$files" ]]; then
    printf '%s\n' "[]"
    exit 0
fi

# ============================================================================
# Classification: 7 fixed-order danger classes
# ============================================================================
# Each class checks filename and/or added-line content with grep -Eiq.
# A file may match multiple classes -> one object per matched class.
# hits: newline-separated "file\tclass" records

hits=""

while IFS= read -r file; do
    [[ -z "$file" ]] && continue

    # Get added lines for this file (^+ lines, excluding +++ header)
    added="$(git diff "${BASE}...HEAD" -- "$file" 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' || true)"

    # 1. auth
    if echo "$file" | grep -Eiq 'auth' || \
       echo "$added" | grep -Eiq 'authoriz|authenticat|requireAuth|isAdmin|hasPermission|jwt|session|login|logout|bearer'; then
        hits="${hits}${file}"$'\t'"auth"$'\n'
    fi

    # 2. crypto
    if echo "$added" | grep -Eiq 'crypto\.|createHash|createCipher|bcrypt|scrypt|randomBytes|pbkdf2|hmac|aes-|rsa'; then
        hits="${hits}${file}"$'\t'"crypto"$'\n'
    fi

    # 3. config
    if echo "$file" | grep -Eiq '(^|/)\.env($|\.)' || \
       echo "$file" | grep -Eiq 'config/.*\.(ya?ml|json|toml)$' || \
       echo "$added" | grep -Eiq 'process\.env\.|[A-Z_]{3,}_(KEY|TOKEN|SECRET|PASSWORD)[[:space:]]*='; then
        hits="${hits}${file}"$'\t'"config"$'\n'
    fi

    # 4. data-migration
    if echo "$file" | grep -Eiq 'migrations?/|/migrate' || \
       echo "$added" | grep -Eiq 'ALTER TABLE|DROP TABLE|CREATE TABLE|ADD COLUMN|DROP COLUMN|RENAME COLUMN'; then
        hits="${hits}${file}"$'\t'"data-migration"$'\n'
    fi

    # 5. public-api
    if echo "$added" | grep -Eiq 'export (default |async )?(function|class|const)|module\.exports|@(Get|Post|Put|Delete|Patch)\(|openapi|paths:'; then
        hits="${hits}${file}"$'\t'"public-api"$'\n'
    fi

    # 6. exec-sink
    if echo "$added" | grep -Eiq 'eval\(|child_process|exec(Sync|File)?\(|spawn\(|pickle\.loads|yaml\.load\(|Function\(|new Function|deserialize|Marshal\.load'; then
        hits="${hits}${file}"$'\t'"exec-sink"$'\n'
    fi

    # 7. dependency
    if echo "$file" | grep -Eiq '(^|/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|Pipfile|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile|Gemfile\.lock|composer\.json)$'; then
        hits="${hits}${file}"$'\t'"dependency"$'\n'
    fi

done <<< "$files"

# ============================================================================
# JSON emission
# ============================================================================

# Remove trailing newline from hits
hits="${hits%$'\n'}"

if [[ -z "$hits" ]]; then
    printf '%s\n' "[]"
    exit 0
fi

if has_jq; then
    # Use jq to build the array deterministically (compact output, no spaces)
    printf '%s\n' "$hits" | \
        jq -c -R -n '[inputs | split("\t") | {file:.[0], class:.[1], severity:"critical"}]'
else
    # Fallback: build JSON array with json_escape
    result="["
    first=true
    while IFS=$'\t' read -r f c; do
        [[ -z "$f" ]] && continue
        if [[ "$first" == true ]]; then
            first=false
        else
            result="${result},"
        fi
        escaped_file="$(json_escape "$f")"
        result="${result}{\"file\":${escaped_file},\"class\":\"${c}\",\"severity\":\"critical\"}"
    done <<< "$hits"
    result="${result}]"
    printf '%s\n' "$result"
fi

exit 0
