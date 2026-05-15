#!/usr/bin/env bash
# integration-branch.sh - Create / cleanup integration branches for child-split mode
#
# An integration branch (`integration/issue-{N}-{slug}`) is used as the merge
# target for child PRs in dev-flow child-split mode. Child PRs are merged into
# this branch (with `--admin` allowed by auto-merge-guard), and the final
# integration branch is later promoted to `dev` / `main` via a regular PR.
#
# Subcommands:
#   create  --issue N --base BRANCH [--slug SLUG]
#       Create `integration/issue-N-slug` from `base`. Idempotent if exists.
#       slug is auto-derived from `gh issue view` title when unspecified.
#       Output: {status: created|exists, branch, base, slug}
#
#   cleanup --issue N [--base BRANCH | --flow-state PATH] [--force]
#       Delete the integration branch (local + remote). Refuses to delete if
#       the branch has commits unmerged into ALL of the candidate base
#       branches. --base (or --flow-state's integration_branch.base) is
#       checked first; otherwise origin/main, origin/dev, main, dev are tried.
#       --force overrides the safety check.
#       Output: {status: cleaned|skipped, branch, reason}
#
#   name    --issue N [--slug SLUG]
#       Compute the branch name only (no side effects). Useful for callers
#       that just need the name string.
#       Output: {branch, slug, issue}
#
# All subcommands print JSON to stdout and use non-zero exit on error.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../common.sh"

require_cmd jq

# ============================================================================
# slugify - convert issue title to kebab-case slug (max 30 chars)
# ============================================================================

slugify() {
    local title="$1"
    # Lowercase, replace non-alphanumeric with hyphens, collapse repeats, trim.
    local s
    s=$(echo "$title" \
        | tr '[:upper:]' '[:lower:]' \
        | LC_ALL=C sed 's/[^a-z0-9]/-/g' \
        | LC_ALL=C sed 's/--*/-/g' \
        | LC_ALL=C sed 's/^-//; s/-$//')
    # Truncate to 30 chars, then trim trailing dash if cut mid-word
    s="${s:0:30}"
    s="${s%-}"
    [[ -z "$s" ]] && s="x"
    echo "$s"
}

# ============================================================================
# Resolve slug from issue title via gh if not given
# ============================================================================

resolve_slug() {
    local issue="$1"
    local explicit="${2:-}"
    if [[ -n "$explicit" ]]; then
        slugify "$explicit"
        return
    fi
    require_cmd gh
    local title
    title=$(gh issue view "$issue" --json title -q '.title' 2>/dev/null || echo "")
    if [[ -z "$title" ]]; then
        die_json "Could not resolve title for issue #$issue (provide --slug)" 1
    fi
    slugify "$title"
}

# ============================================================================
# Subcommand dispatch
# ============================================================================

[[ $# -ge 1 ]] || die_json "Subcommand required: create|cleanup|name" 1

SUBCMD="$1"; shift

ISSUE=""
BASE=""
SLUG=""
FORCE=false
FLOW_STATE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --issue) ISSUE="$2"; shift 2 ;;
        --base) BASE="$2"; shift 2 ;;
        --slug) SLUG="$2"; shift 2 ;;
        --force) FORCE=true; shift ;;
        --flow-state) FLOW_STATE="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,30p' "$0"
            exit 0
            ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

# If --flow-state is given, derive --base from integration_branch.base when
# the caller didn't pass it explicitly. This lets `cleanup` know which base
# branch the integration branch was created from (authoritative source).
if [[ -n "$FLOW_STATE" && -f "$FLOW_STATE" && -z "$BASE" ]]; then
    BASE=$(jq -r '.integration_branch.base // empty' "$FLOW_STATE" 2>/dev/null || echo "")
fi

[[ -n "$ISSUE" ]] || die_json "--issue is required" 1
[[ "$ISSUE" =~ ^[0-9]+$ ]] || die_json "--issue must be a positive integer" 1

# ============================================================================
# Helpers used by subcommands
# ============================================================================

compute_branch_name() {
    local slug
    slug=$(resolve_slug "$ISSUE" "$SLUG")
    echo "integration/issue-${ISSUE}-${slug}|${slug}"
}

# ============================================================================
# Subcommand: name
# ============================================================================

cmd_name() {
    local pair branch slug
    pair=$(compute_branch_name)
    branch="${pair%|*}"
    slug="${pair##*|}"
    jq -n \
        --arg branch "$branch" \
        --arg slug "$slug" \
        --argjson issue "$ISSUE" \
        '{branch: $branch, slug: $slug, issue: $issue}'
}

# ============================================================================
# Subcommand: create
# ============================================================================

cmd_create() {
    [[ -n "$BASE" ]] || die_json "--base is required for create" 1
    require_git_repo

    local pair branch slug
    pair=$(compute_branch_name)
    branch="${pair%|*}"
    slug="${pair##*|}"

    # Idempotent: if branch already exists locally or on origin, no-op
    if git show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
        jq -n --arg branch "$branch" --arg base "$BASE" --arg slug "$slug" \
            '{status: "exists", branch: $branch, base: $base, slug: $slug, location: "local"}'
        return 0
    fi
    if git show-ref --verify --quiet "refs/remotes/origin/$branch" 2>/dev/null; then
        # Check it out locally to track remote
        git fetch origin "$branch" >/dev/null 2>&1 || true
        jq -n --arg branch "$branch" --arg base "$BASE" --arg slug "$slug" \
            '{status: "exists", branch: $branch, base: $base, slug: $slug, location: "remote"}'
        return 0
    fi

    # Resolve base ref (allow origin/x or local x)
    local base_ref="$BASE"
    if ! git rev-parse --verify --quiet "$base_ref" >/dev/null 2>&1; then
        if git rev-parse --verify --quiet "origin/$base_ref" >/dev/null 2>&1; then
            base_ref="origin/$base_ref"
        else
            die_json "Base branch not found: $BASE" 1
        fi
    fi

    # Create the branch ref (no checkout — caller manages working tree)
    if ! git branch "$branch" "$base_ref" >/dev/null 2>&1; then
        die_json "git branch failed creating $branch from $base_ref" 1
    fi

    jq -n --arg branch "$branch" --arg base "$BASE" --arg slug "$slug" \
        '{status: "created", branch: $branch, base: $base, slug: $slug}'
}

# ============================================================================
# Subcommand: cleanup
# ============================================================================

cmd_cleanup() {
    require_git_repo

    local pair branch slug
    pair=$(compute_branch_name)
    branch="${pair%|*}"
    slug="${pair##*|}"

    local existed_local=false existed_remote=false
    if git show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
        existed_local=true
    fi
    if git show-ref --verify --quiet "refs/remotes/origin/$branch" 2>/dev/null; then
        existed_remote=true
    fi

    if [[ "$existed_local" == false && "$existed_remote" == false ]]; then
        jq -n --arg branch "$branch" \
            '{status: "skipped", branch: $branch, reason: "branch does not exist"}'
        return 0
    fi

    # Safety check: refuse if there are unmerged commits relative to the
    # recorded base (from --base / flow.json) or the conventional defaults.
    # We require the branch to be merged into AT LEAST ONE of:
    #   1. $BASE (if explicit / from flow.json), tried first
    #   2. origin/main, origin/dev, main, dev (fallbacks)
    # If none of them contains all of the branch's commits, refuse cleanup.
    if [[ "$existed_local" == true && "$FORCE" == false ]]; then
        local candidate_bases=()
        # Prefer the recorded base when provided
        [[ -n "$BASE" ]] && candidate_bases+=("$BASE" "origin/$BASE")
        candidate_bases+=("origin/main" "origin/dev" "main" "dev")

        local fully_merged=false
        local last_unmerged_msg=""
        for target in "${candidate_bases[@]}"; do
            if git rev-parse --verify --quiet "$target" >/dev/null 2>&1; then
                local count
                count=$(git rev-list --count "$target..$branch" 2>/dev/null || echo "0")
                if [[ "$count" -eq 0 ]]; then
                    fully_merged=true
                    break
                else
                    last_unmerged_msg="$count commit(s) ahead of $target"
                fi
            fi
        done

        if [[ "$fully_merged" == false && -n "$last_unmerged_msg" ]]; then
            jq -n --arg branch "$branch" \
                --arg reason "$last_unmerged_msg (checked: ${candidate_bases[*]}); use --force to override" \
                '{status: "skipped", branch: $branch, reason: $reason}'
            return 1
        fi
    fi

    # Delete local
    if [[ "$existed_local" == true ]]; then
        git branch -D "$branch" >/dev/null 2>&1 || true
    fi
    # Delete remote (best-effort)
    if [[ "$existed_remote" == true ]]; then
        git push origin --delete "$branch" >/dev/null 2>&1 || true
    fi

    jq -n --arg branch "$branch" \
        '{status: "cleaned", branch: $branch, reason: "branch removed"}'
}

case "$SUBCMD" in
    create) cmd_create ;;
    cleanup) cmd_cleanup ;;
    name) cmd_name ;;
    *) die_json "Unknown subcommand: $SUBCMD (must be create|cleanup|name)" 1 ;;
esac
