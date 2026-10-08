# worktree-checkout.sh - worktree の作成と部分 checkout の検査（source 専用。単体では実行しない）
# dev-flow-prerun（dev-flow/scripts/prerun.sh）と pr-iterate-prerun（pr-iterate-prerun.sh）が使う。
#
# prerun は sandbox 内で動く。sandbox が書けないパス（`.githooks` 等）を追跡する repo では full checkout が
# `cannot create directory at '.githooks': Operation not permitted` で失敗し、git は作りかけの worktree を片付ける。
# そこで checkout を省いて作り直し、取り出せるパスだけを取り出して、取り出せないパスに skip-worktree を付ける。
# 付けずに残すと未ステージの削除（` D`）になり、commit 時の `git add -A` がそのパスの削除を stage する。
# `checkout-index -a` はディレクトリを作れないと最初のパスで fatal 終了するので、パスごとに取り出す。

WT_SKIP_WORKTREE=()
WT_ADD_ERR=""

# worktree_add <root> <wt> <branch> <start>
#   branch が無ければ <start> から --no-track で作り（起動元 repo の .git/config に upstream を書かない）、
#   あれば checkout する。成功で 0。WT_SKIP_WORKTREE に skip-worktree を付けたパス（full checkout できた
#   ときは空）、失敗時は WT_ADD_ERR にエラーを入れる。
worktree_add() {
    local root="$1" wt="$2" branch="$3" start="$4" full_err out list p
    WT_SKIP_WORKTREE=()
    WT_ADD_ERR=""
    if git -C "$root" show-ref --verify --quiet "refs/heads/${branch}"; then
        full_err="$(git -C "$root" worktree add "$wt" "$branch" 2>&1)" && return 0
    else
        full_err="$(git -C "$root" worktree add --no-track -b "$branch" "$wt" "$start" 2>&1)" && return 0
    fi
    # -b で作った branch は full checkout が失敗しても残る。checkout を省いても作れない（branch が別の worktree で
    # checkout 済み等、checkout 以外の失敗）なら full checkout のエラーを返す
    if ! git -C "$root" show-ref --verify --quiet "refs/heads/${branch}" \
        || ! git -C "$root" worktree add --no-checkout "$wt" "$branch" >/dev/null 2>&1; then
        WT_ADD_ERR="$full_err"
        return 1
    fi
    # --no-checkout の worktree は index が空なので HEAD から作る
    if ! out="$(git -C "$wt" read-tree HEAD 2>&1)"; then
        git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1 || true
        WT_ADD_ERR="${full_err}; checkout を省いて作り直した worktree の index を作れなかった: ${out}"
        return 1
    fi
    list="$(mktemp "${TMPDIR:-/tmp}/worktree-checkout.XXXXXX")"
    git -C "$wt" ls-files -z >"$list"
    while IFS= read -r -d '' p; do
        git -C "$wt" checkout-index -f -- "$p" >/dev/null 2>&1 || WT_SKIP_WORKTREE+=("$p")
    done <"$list"
    rm -f "$list"
    if [[ ${#WT_SKIP_WORKTREE[@]} -gt 0 ]] \
        && ! out="$(git -C "$wt" update-index --skip-worktree -- "${WT_SKIP_WORKTREE[@]}" 2>&1)"; then
        git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1 || true
        WT_ADD_ERR="${full_err}; 取り出せないパスに skip-worktree を付けられなかった: ${out}"
        WT_SKIP_WORKTREE=()
        return 1
    fi
    # 取り出したファイルの stat を index に載せる（載せないと以後の git status が毎回全ファイルを読み直す）
    git -C "$wt" update-index -q --refresh >/dev/null 2>&1 || true
    return 0
}

# skip_worktree_json: WT_SKIP_WORKTREE を JSON 配列で出す
skip_worktree_json() {
    if [[ ${#WT_SKIP_WORKTREE[@]} -eq 0 ]]; then
        printf '[]'
        return
    fi
    printf '%s\n' "${WT_SKIP_WORKTREE[@]}" | jq -R . | jq -sc .
}

# partial_checkout_error <wt>
#   再利用する worktree に skip-worktree の付いていない未ステージの削除があれば、エラー文を stdout に出して 1 を返す。
#   取り出していないパス（部分 checkout）と作業中の削除は区別できないので、取り出し直さずに止める
#   （取り出し直すと作業中の削除を黙って戻す。残したまま進むと commit 時の `git add -A` が削除を stage する）。
partial_checkout_error() {
    local wt="$1" deleted n
    if ! deleted="$(git -C "$wt" ls-files --deleted 2>/dev/null)"; then
        printf 'worktree %s の未ステージの削除を判定できなかった' "$wt"
        return 1
    fi
    [[ -z "$deleted" ]] && return 0
    n="$(printf '%s\n' "$deleted" | wc -l | tr -d ' ')"
    printf 'worktree %s に未ステージの削除が %s 件ある（部分 checkout の疑い。例: %s）。commit 時に削除が stage されるので再利用しない。git worktree remove %s で削除してから再実行する（作り直しでは取り出せないパスに skip-worktree を付ける）' \
        "$wt" "$n" "$(printf '%s\n' "$deleted" | head -n 3 | paste -sd ',' -)" "$wt"
    return 1
}
