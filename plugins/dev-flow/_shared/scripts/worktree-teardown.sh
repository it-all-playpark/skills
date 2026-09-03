#!/usr/bin/env bash
# worktree-teardown.sh - dev-flow 管理下の worktree を安全に teardown する。
# .veridelta/runs/*.json を veridelta-archive.sh で中央 archive-root へ退避してから
# git worktree remove を実行する(退避 -> 削除の順序保証。AC-1)。
#
# 実行文脈: 非 sandbox の human terminal での実行を前提とする。Claude sandbox 下では
# repo 内書き込み(archive 側)が deny され fail-open で警告を出すのみになる
# (sandbox 経由で使う場合は .claude/settings.json の sandbox write allow へ
# .veridelta-archive/ の追加が必要)。
#
# 使い方: worktree-teardown.sh <worktree-path> [--archive-root <dir>] [--force]
#
# 動作:
#   1. <worktree-path> が git worktree であることを検証(非 worktree はエラー)
#   2. veridelta-archive.sh で .veridelta/runs/*.json を退避
#      (archive の失敗・スクリプト不在はいずれも警告のみで続行 = fail-open, AC-2)
#   3. main repo を解決し `git worktree remove [--force] <worktree-path>` を実行し、
#      その exit code をそのまま本スクリプトの exit code として返す
#      (remove が block された場合は退避済みである旨を stderr に案内)
#
# 出力: JSON なし。人間向け stderr/stdout メッセージ + exit code が契約。
#
# Exit:
#   0: teardown 成功
#   非0: git worktree remove 失敗(untracked/modified files 等。exit code はそのまま伝播)
#   2: 引数不足 / <worktree-path> が git worktree ではない / git-common-dir 解決失敗
set -uo pipefail

# ============================================================================
# Args
# ============================================================================

if [ $# -lt 1 ]; then
    echo "Usage: worktree-teardown.sh <worktree-path> [--archive-root <dir>] [--force]" >&2
    exit 2
fi

WT="$1"
shift

ARCHIVE_ROOT=""
FORCE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --archive-root)
            if [ $# -lt 2 ]; then
                echo "--archive-root requires a value" >&2
                exit 2
            fi
            ARCHIVE_ROOT="$2"
            shift 2
            ;;
        --force)
            FORCE=1
            shift
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 2
            ;;
    esac
done

# ============================================================================
# Validate <worktree-path> is a git worktree
# ============================================================================

if ! git -C "$WT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Error: not a git worktree: $WT" >&2
    exit 2
fi

# ============================================================================
# Step 1: archive .veridelta/runs/*.json BEFORE removing the worktree (AC-1).
# fail-open: any archive failure (command failure, ok:false, script missing)
# is a warning only and never blocks teardown (AC-2).
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE_SCRIPT="$SCRIPT_DIR/veridelta-archive.sh"

if [ -x "$ARCHIVE_SCRIPT" ]; then
    archive_output=""
    archive_status=0
    archive_output="$("$ARCHIVE_SCRIPT" "$WT" ${ARCHIVE_ROOT:+"$ARCHIVE_ROOT"})" || archive_status=$?

    if [ "$archive_status" -ne 0 ]; then
        echo "worktree-teardown: veridelta-archive.sh exited $archive_status, continuing (fail-open): $archive_output" >&2
    elif [[ "$archive_output" != *'"ok":true'* ]]; then
        echo "worktree-teardown: veridelta-archive reported failure, continuing (fail-open): $archive_output" >&2
    fi
else
    echo "worktree-teardown: veridelta-archive.sh not found or not executable at $ARCHIVE_SCRIPT, skipping archive (fail-open)" >&2
fi

# ============================================================================
# Step 2: resolve main repo and remove the worktree
# ============================================================================

common_dir="$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
if [ -z "$common_dir" ]; then
    echo "Error: failed to resolve git-common-dir for $WT" >&2
    exit 2
fi
MAIN_REPO="$(dirname "$common_dir")"

remove_args=(worktree remove)
if [ "$FORCE" -eq 1 ]; then
    remove_args+=(--force)
fi
remove_args+=("$WT")

remove_stderr_tmp="$(mktemp "${TMPDIR:-/tmp}/worktree-teardown-remove-stderr.XXXXXX")"
trap 'rm -f "$remove_stderr_tmp"' EXIT

git -C "$MAIN_REPO" "${remove_args[@]}" 2>"$remove_stderr_tmp"
remove_exit=$?

remove_stderr="$(cat "$remove_stderr_tmp")"
if [ -n "$remove_stderr" ]; then
    echo "$remove_stderr" >&2
fi

if [ "$remove_exit" -ne 0 ]; then
    echo "worktree-teardown: 退避は完了済み。--force で再実行可能" >&2
fi

exit "$remove_exit"
