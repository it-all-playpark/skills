#!/usr/bin/env bash
# diff-risk-classify.sh - dev-flow W1 deterministic danger-grep on realized diff.
#
# Purpose: Grep the REALIZED git diff (actual written changes, not proposed/issue text)
# between a base ref and HEAD for 7 danger classes and print hit files as a JSON array
# to stdout. Called directly from workflow JS. Ungameable critical floor -- severity is
# ALWAYS "critical" and cannot be lowered by any flag or input.
#
# Usage: diff-risk-classify.sh [--working-tree] <base-ref>
#   --working-tree  Classify worktree changes (staged + untracked) instead of committed
#                   diff. Uses merge-base($BASE, HEAD) as anchor so BASE-ahead commits
#                   from other branches do not bleed into the result.
# Output: JSON array of {file, class, severity:"critical"} objects (stdout)
# Exit: 0 on success (even with empty hits), non-zero via die_json on error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=../../_lib/common.sh
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Args
# ============================================================================

MODE="default"

# Parse flags; reject unknown -- flags so callers get a clear error instead of
# silently treating them as a base-ref (dual-path/legacy fallback is prohibited).
while [[ "${1:-}" == --* ]]; do
    case "$1" in
        --working-tree)
            MODE="working-tree"
            shift
            ;;
        *)
            die_json "unknown flag: $1" 2
            ;;
    esac
done

BASE="${1:-}"
if [[ -z "$BASE" ]]; then
    die_json "<base-ref> required" 2
fi

require_git_repo

# Anchor all git operations to the repo root so that pathspecs are always
# root-relative regardless of cwd. This prevents silent false-negatives when
# the script is invoked from a repo subdirectory (content-based classes would
# silently return [] because the per-file diff pathspec missed the file).
GIT_ROOT="$(git rev-parse --show-toplevel)"

# ============================================================================
# Stale-base fetch (both modes, before BASE validation)
# ============================================================================
# If BASE looks like origin/<branch>, attempt a best-effort fetch to refresh
# the remote-tracking ref before validation. This prevents false-positives
# caused by a stale (behind-actual) remote ref: a stale origin/main that
# predates merged commits would make those merged changes appear as "new" in
# the diff, producing spurious hits.
#
# Failure policy: fail-open (warn and continue), NOT fail-closed (die). A
# fetch failure means we use the existing local ref which may be stale, but
# that is strictly a false-positive direction, never a false-negative. The
# security invariant (danger must block) is preserved even with a stale ref.
if [[ "$BASE" =~ ^origin/(.+)$ ]]; then
    _BRANCH="${BASH_REMATCH[1]}"
    if git -C "$GIT_ROOT" remote get-url origin >/dev/null 2>&1; then
        set +e
        git -C "$GIT_ROOT" fetch --quiet origin "$_BRANCH" 2>/dev/null
        _FETCH_RC=$?
        set -e
        if [[ "$_FETCH_RC" -ne 0 ]]; then
            echo "warn: fetch origin failed; using local ref (may be stale)" >&2
        fi
    fi
fi

# Validate the base ref resolves to a commit.
# Use set +e / RC capture instead of "if \!" to avoid history-expansion issues
# and set -e interactions across bash invocations.
set +e
git -C "$GIT_ROOT" rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1
_BASE_RC=$?
set -e
if [[ "$_BASE_RC" -ne 0 ]]; then
    die_json "invalid base ref: $BASE" 2
fi

# ============================================================================
# Collect changed files
# ============================================================================

if [[ "$MODE" == "working-tree" ]]; then
    # working-tree mode: classify uncommitted changes (staged + untracked).
    # Use merge-base($BASE, HEAD) as the diff anchor so that commits already
    # present in BASE (from other merged PRs) do NOT bleed into the file list.
    # This is the key invariant: even if BASE is ahead of the current branch's
    # fork point, only changes introduced in this worktree are classified.
    set +e
    MB="$(git -C "$GIT_ROOT" merge-base "$BASE" HEAD 2>/dev/null)"
    _MB_RC=$?
    set -e
    if [[ "$_MB_RC" -ne 0 || -z "$MB" ]]; then
        die_json "no merge-base between $BASE and HEAD" 2
    fi

    # tracked: MB vs working-tree (two-point diff). This captures both staged
    # and unstaged modifications to already-tracked files (files present in the
    # working tree are diffed against MB regardless of index state).
    tracked_files="$(git -C "$GIT_ROOT" -c core.quotepath=false diff --name-only "$MB" 2>/dev/null)" || tracked_files=""

    # untracked: git status --porcelain --untracked-files=all lists ALL untracked
    # files including those nested under untracked directories (without -uall,
    # a new directory like "newskill/" would appear as a single "?? newskill/"
    # entry, causing its contents to be silently skipped).
    untracked_files="$(git -C "$GIT_ROOT" -c core.quotepath=false status --porcelain --untracked-files=all 2>/dev/null \
        | grep '^??' | cut -c4-)" || untracked_files=""

    # Build untracked set for per-file lookup (newline-separated paths).
    UNTRACKED_SET="$untracked_files"

    # Union of tracked + untracked, deduplicated.
    files="$(printf '%s\n%s\n' "$tracked_files" "$untracked_files" | sort -u | grep -v '^$')" || files=""
else
    # Default mode: committed diff only (three-dot diff BASE...HEAD).
    # 1 byte of existing behavior unchanged.
    files="$(git -C "$GIT_ROOT" -c core.quotepath=false diff --name-only "${BASE}...HEAD" 2>/dev/null)" || files=""
    UNTRACKED_SET=""
    MB=""
fi

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

    # docs ファイル(.md/.mdx/.txt, docs/ 配下)は inert(実行されない)= realized danger
    # ではないため danger-grep 対象から除外する。docs 本文に含まれる "auth"/"exec" 等の
    # security 語彙による content-based class の false-positive を防ぐ(issue #155)。
    # filename-based class(config/dependency/data-migration)も docs には該当しない。
    if echo "$file" | grep -Eiq '\.(md|mdx|txt)$|(^|/)docs/'; then
        continue
    fi

    # Get added lines for this file (^+ lines, excluding +++ header).
    if [[ "$MODE" == "working-tree" ]]; then
        # Check if this file is untracked (in UNTRACKED_SET).
        # Strategy: if the path is in UNTRACKED_SET, treat the whole file content
        # as "added". Otherwise use two-point diff from merge-base.
        _is_untracked=false
        if [[ -n "$UNTRACKED_SET" ]] && printf '%s\n' "$UNTRACKED_SET" | grep -qxF "$file"; then
            _is_untracked=true
        fi

        if [[ "$_is_untracked" == true ]]; then
            # Untracked file: entire content is new, use cat as added lines.
            # Prefix with "+" so downstream grep patterns (which expect ^+ lines)
            # still work uniformly.
            if [[ -f "$GIT_ROOT/$file" ]]; then
                added="$(sed 's/^/+/' < "$GIT_ROOT/$file" 2>/dev/null || true)"
            else
                added=""
            fi
        else
            # Tracked file: two-point diff from merge-base vs working tree.
            added="$(git -C "$GIT_ROOT" -c core.quotepath=false diff "$MB" -- "$file" 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' || true)"
            # If diff is empty but file is in worktree and untracked by git,
            # fall back to cat (handles edge case where file was just created
            # but not yet in the untracked list due to race conditions).
            if [[ -z "$added" && -f "$GIT_ROOT/$file" ]]; then
                set +e
                git -C "$GIT_ROOT" ls-files --error-unmatch "$file" >/dev/null 2>&1
                _ls_rc=$?
                set -e
                if [[ "$_ls_rc" -ne 0 ]]; then
                    added="$(sed 's/^/+/' < "$GIT_ROOT/$file" 2>/dev/null || true)"
                fi
            fi
        fi
    else
        # Default mode: three-dot diff (committed changes only).
        # Use git -C "$GIT_ROOT" so the pathspec is always root-relative and
        # correctly resolves even when the script is run from a subdirectory.
        added="$(git -C "$GIT_ROOT" -c core.quotepath=false diff "${BASE}...HEAD" -- "$file" 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' || true)"
    fi

    # 1. auth
    if echo "$file" | grep -Eiq 'auth' || \
       echo "$added" | grep -Eiq 'authoriz|authenticat|requireAuth|isAdmin|hasPermission|jwt|session|login|logout|bearer'; then
        hits="${hits}${file}"$'\t'"auth"$'\n'
    fi

    # 2. crypto
    # P1: left-boundary group (tokens that are typically prefixed: createHmac included
    #     here to rescue from the hmac both-sides boundary tightening below).
    # P2: both-sides boundary group (hmac, rsa bare token to avoid PATH_TRAVERSAL FP),
    #     plus aes- (hyphen already acts as right boundary).
    # createHmac is in P1 (left boundary) to ensure `createHmac(` is caught even after
    # bare `hmac` is boundary-tightened in P2.
    if echo "$added" | grep -Eiq '(^|[^[:alnum:]_])(crypto\.|createHash|createCipher|createHmac|bcrypt|scrypt|randomBytes|pbkdf2)' || \
       echo "$added" | grep -Eiq '(^|[^[:alnum:]_])(hmac|rsa)([^[:alnum:]_]|$)|(^|[^[:alnum:]_])aes-'; then
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
    # _lib/ は repo 内部専用ライブラリ、tools/ は repo 内部の generator/dev CLI 置き場で、
    # いずれも外部 API surface ではないため public-api critical の構造的 false positive を除外する。
    # 緩和はこのクラス限定（他 6 クラスは _lib/ / tools/ でも従来どおり判定する）。
    if echo "$file" | grep -Eq '(^|/)(_lib|tools)/'; then
        : # _lib / tools are repo-internal; skip public-api check only
    elif echo "$added" | grep -Eiq 'export (default |async )?(function|class|const)|module\.exports|@(Get|Post|Put|Delete|Patch)\(|openapi|paths:'; then
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
