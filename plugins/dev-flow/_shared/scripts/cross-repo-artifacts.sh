#!/usr/bin/env bash
# cross-repo-artifacts.sh - dev-flow の empty-diff gate 用 cross-repo 成果物検証。
#
# 用途: cross-repo issue（修正対象ファイルが dev-flow 実行対象 repo 外にある場合）で、
# dev-flow worktree の diff は空でも、implementer が申告した候補パスが実際には別 repo の
# working tree に成果を残しているかを read-only かつ決定論的に検証する。
#
# 契約:
#   - 第 1 引数: dev-flow worktree の絶対パス
#   - 第 2 引数以降: 検証対象の候補パス（1件以上）
#   - 各候補について:
#       * 先頭 "~/" は $HOME に展開する
#       * 絶対パスでないものは {exists:false} として記録しスキップする
#       * <worktree-path>/ 配下のパスは除外する（exists:false 扱い）
#       * 存在チェック（-e）を行う
#       * `git -C "$(dirname <path>)" rev-parse --show-toplevel` で repo_root を解決する
#         （非 git なら空文字）
#       * repo_root が worktree の repo_root と一致する場合は除外する（dirty 判定をスキップし
#         false 扱い。同一 repo は cross-repo の証拠にならないため）
#       * dirty 判定は `git -C <repo_root> status --porcelain --untracked-files=all -- <path>`
#         の出力が非空かどうか
#   - found は exists かつ dirty の件数（既存ファイルの存在だけでは成果の証拠にならない。
#     dirty のみを証拠とする）
#
# 使い方: cross-repo-artifacts.sh <worktree-path> <candidate-path>...
# 出力(stdout, JSON 1行):
#   {"ok":true,"found":N,"artifacts":[{"path":"...","exists":true,"repo_root":"...","dirty":true},...]}
#
# working tree・index への書き込みは一切しない（read-only）。
# Exit: 0 on success (JSON 出力あり)。1 on error（引数不足・worktree パス不存在。JSON 出力なし）。
set -euo pipefail

# ============================================================================
# Args
# ============================================================================

if [ $# -lt 2 ]; then
    echo "Usage: cross-repo-artifacts.sh <worktree-path> <candidate-path>..." >&2
    exit 1
fi

wt="${1}"
shift

if [ ! -d "$wt" ]; then
    echo "Error: worktree path does not exist: $wt" >&2
    exit 1
fi

# 末尾スラッシュを正規化（prefix 比較のため）
wt_norm="${wt%/}"

# worktree 自身の repo_root（非 git なら空文字）
wt_repo_root=$(git -C "$wt_norm" rev-parse --show-toplevel 2>/dev/null) || wt_repo_root=""

# ============================================================================
# 候補パスを1件ずつ検証
# ============================================================================

artifacts_json=()
found=0

for raw in "$@"; do
    # --- 先頭 ~/ を $HOME に展開 ---
    case "$raw" in
        "~/"*)
            path="${HOME}${raw#\~}"
            ;;
        *)
            path="$raw"
            ;;
    esac

    # --- 絶対パスでないものはスキップ ---
    case "$path" in
        /*) ;;
        *)
            artifacts_json+=("$(jq -nc --arg path "$path" \
                '{path:$path, exists:false, repo_root:"", dirty:false}')")
            continue
            ;;
    esac

    # --- worktree 配下のパスは除外 ---
    case "$path" in
        "$wt_norm"|"$wt_norm"/*)
            artifacts_json+=("$(jq -nc --arg path "$path" \
                '{path:$path, exists:false, repo_root:"", dirty:false}')")
            continue
            ;;
    esac

    # --- 存在チェック ---
    if [ -e "$path" ]; then
        exists=true
    else
        exists=false
    fi

    # --- repo_root 解決（dirname 基準、非 git なら空文字） ---
    dirname_path="$(dirname -- "$path")"
    repo_root=$(git -C "$dirname_path" rev-parse --show-toplevel 2>/dev/null) || repo_root=""

    # --- dirty 判定 ---
    dirty=false
    if [ -n "$repo_root" ]; then
        if [ -n "$wt_repo_root" ] && [ "$repo_root" = "$wt_repo_root" ]; then
            # worktree と同一 repo -> cross-repo の証拠にならないため除外（dirty 判定省略）
            dirty=false
        else
            status_out=$(git -C "$repo_root" status --porcelain --untracked-files=all -- "$path")
            if [ -n "$status_out" ]; then
                dirty=true
            fi
        fi
    fi

    if [ "$exists" = "true" ] && [ "$dirty" = "true" ]; then
        found=$((found + 1))
    fi

    artifacts_json+=("$(jq -nc --arg path "$path" --arg repo_root "$repo_root" \
        --argjson exists "$exists" --argjson dirty "$dirty" \
        '{path:$path, exists:$exists, repo_root:$repo_root, dirty:$dirty}')")
done

# ============================================================================
# Output JSON
# ============================================================================

printf '%s\n' "${artifacts_json[@]}" | jq -sc --argjson found "$found" \
    '{ok:true, found:$found, artifacts:.}'
