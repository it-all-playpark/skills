#!/usr/bin/env bash
# common.sh - Shared utilities for skill scripts
# Source this file: source "$(dirname "$0")/../../_lib/common.sh"

[[ -n "${_SKILL_COMMON_LOADED:-}" ]] && return 0
_SKILL_COMMON_LOADED=1

# ============================================================================
# JSON Helpers
# ============================================================================

has_jq() {
    command -v jq &>/dev/null
}

# Escape string for JSON - strips trailing newlines
json_escape() {
    local str="${1%$'\n'}"  # Strip trailing newline
    if has_jq; then
        printf '%s' "$str" | jq -Rs .
    else
        str="${str//\\/\\\\}"
        str="${str//\"/\\\"}"
        str="${str//$'\n'/\\n}"
        str="${str//$'\t'/\\t}"
        echo "\"$str\""
    fi
}

json_str() {
    local val="${1%$'\n'}"  # Strip trailing newline
    if [[ -z "$val" ]]; then
        echo "null"
    else
        json_escape "$val"
    fi
}

json_array() {
    if has_jq; then
        jq -R . | jq -s '.'
    else
        local first=true
        echo -n "["
        while IFS= read -r line; do
            [[ "$first" == true ]] || echo -n ","
            first=false
            json_escape "$line" | tr -d '\n'
        done
        echo "]"
    fi
}

# ============================================================================
# Error Handling
# ============================================================================

die_json() {
    local msg="$1"
    local code="${2:-1}"
    echo "{\"status\":\"error\",\"error\":$(json_str "$msg"),\"exit_code\":$code}" >&2
    exit "$code"
}

err() { echo "Error: $1" >&2; }
warn() { echo "Warning: $1" >&2; }

# ============================================================================
# Requirement Checks
# ============================================================================

require_cmd() {
    local cmd="$1"
    local msg="${2:-Required command '$cmd' not found}"
    command -v "$cmd" &>/dev/null || die_json "$msg" 127
}

require_git_repo() {
    git rev-parse --git-dir &>/dev/null 2>&1 || die_json "Not a git repository" 128
}

require_gh_auth() {
    require_cmd "gh" "GitHub CLI (gh) not installed. Install: brew install gh"
    # Use 'gh auth token' instead of 'gh auth status' to check authentication
    # 'gh auth status' returns exit code 1 if ANY account is invalid, even if active account works
    # 'gh auth token' only checks if active account has a valid token
    gh auth token &>/dev/null || die_json "GitHub CLI not authenticated. Run: gh auth login" 129
}

require_cmds() {
    for cmd in "$@"; do require_cmd "$cmd"; done
}

# ============================================================================
# Git Helpers
# ============================================================================

git_current_branch() {
    git branch --show-current 2>/dev/null | tr -d '\n'
}

git_root() {
    git rev-parse --show-toplevel 2>/dev/null | tr -d '\n'
}

git_branch_exists() {
    git show-ref --verify --quiet "refs/heads/$1" 2>/dev/null
}

git_is_clean() {
    [[ -z "$(git status --porcelain 2>/dev/null)" ]]
}

# ============================================================================
# Timing
# ============================================================================

now_sec() { date +%s; }
duration_since() { echo $(($(now_sec) - $1)); }
