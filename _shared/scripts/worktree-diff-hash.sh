#\!/usr/bin/env bash
# worktree-diff-hash.sh - 一時 index で working tree 全体の tree OID を算出し、
# base tree と比較して一致するか JSON 1 行で出力する。
#
# 用途: dev-flow の staged-only handoff 検出（issue #215）。
# 実 index・working tree を一切変更しない（GIT_INDEX_FILE 退避で保証）。
#
# 使い方: worktree-diff-hash.sh <worktree-path> <base-ref>
# 出力(stdout, JSON 1行): {"hash":"<tree OID>","empty":true|false}
#   empty は tree == base_tree の文字列一致（staged+unstaged+untracked を包含）
# Exit: 0 on success, 1 on error (no JSON on error)
set -euo pipefail

# ============================================================================
# Args
# ============================================================================

if [ $# -lt 2 ]; then
    echo "Usage: worktree-diff-hash.sh <worktree-path> <base-ref>" >&2
    exit 1
fi

wt="${1}"
base="${2}"

# ============================================================================
# Validate worktree path
# ============================================================================

if [ \! -d "$wt" ]; then
    echo "Error: worktree path does not exist: $wt" >&2
    exit 1
fi

# ============================================================================
# Compute tree OID via temporary index
# ============================================================================

# 一時 index ファイルを作成。EXIT trap で必ず削除する。
tmp_index=$(mktemp "${TMPDIR:-/tmp}/wt-diff-hash-index.XXXXXX")
trap 'rm -f "$tmp_index"' EXIT

# 一時 index に HEAD の tree を展開する（実 index は触らない）
GIT_INDEX_FILE="$tmp_index" git -C "$wt" read-tree HEAD

# staged + unstaged + untracked（.gitignore 尊重）を一時 index に反映
# blob の書き込みは object DB のみで working tree を変更しない
GIT_INDEX_FILE="$tmp_index" git -C "$wt" add -A

# 一時 index から tree OID を書き出す（object DB への書き込みは無害）
tree=$(GIT_INDEX_FILE="$tmp_index" git -C "$wt" write-tree)

# base ref の tree OID を取得（^{tree} で確実に tree オブジェクトを参照）
base_tree=$(git -C "$wt" rev-parse "${base}^{tree}")

# ============================================================================
# Output JSON
# ============================================================================

if [ "$tree" = "$base_tree" ]; then
    empty="true"
else
    empty="false"
fi

printf '{"hash":"%s","empty":%s}\n' "$tree" "$empty"
