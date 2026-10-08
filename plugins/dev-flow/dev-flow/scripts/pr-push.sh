#!/usr/bin/env bash
# pr-push.sh - dev-flow PR phase の push を実行し、出力全文を log に残して末尾行だけを返す (issue #819)
#
# Usage: pr-push <log-file>
#
# cwd（PR phase の worktree）で `git push origin HEAD` を 1 回だけ実行する（--no-verify は付けない・
# リトライしない。-u は付けない — 起動元 repo の .git/config は sandbox 内から書けないので upstream を書かない）。git の stdout / stderr は合わせて <log-file> へ書き、そのまま端末へは流さない。終了後に
#
#   pr-push: exit=<git の exit code> log=<log-file>
#   <<<PUSH_TAIL_BEGIN>>>
#   <出力末尾の空でない行（最大 PUSH_TAIL_LINES 行）>
#   <<<PUSH_TAIL_END>>>
#
# を stdout に出し、git の exit code で終了する（引数不足・log ディレクトリ作成失敗・git repo 外は push せず exit 2、
# lock の待ち上限超過は push せず exit 75 で、末尾行に `pr-push: lock_timeout ...` を返す）。
#
# pre-push hook の出力（全リポジトリの lint warning 等）は呼び出し側 agent の tool 出力上限を超えると
# 途中で切れ、hook の最終行と git の `failed to push` 行が見えなくなる。返す量を末尾数行に固定して、
# 出力全体の長さに関係なく末尾を渡す。全文は <log-file> に残るので、人間はそこで失敗した段を確認する。
# 末尾行は ANSI エスケープと \r 区切りの進捗表示を落とし、1 行 PUSH_TAIL_MAX_COLS バイトで切る
# （1 行が極端に長い出力でも返す量の上限を固定するため）。
#
# 認証付き network I/O を内部に持つ exec-proxy の例外（.claude/rules/dev-flow.md）。sandbox 内で動き、
# pre-push hook（repo の任意コード）も sandbox 内で走る。hook が sandbox 内で前提を満たせない処理（docker 等）は
# その repo の hook 側で skip する（E2E は CI が回す）。
#
# push は repo 単位の排他 lock（git-common-dir 配下の dev-flow-pr-push.lock/、worktree 間で共有）を取ってから行う
# (issue #872)。同じ repo の並行 run の pre-push hook が同時に走ると、テストが CPU を奪い合って落ちるため。
# lock は mkdir / rmdir だけで取得・解放する（sandbox 内から書ける場所。$TMPDIR はセッションごとに別なので使えない）。
# 保持者は lock 内の pid-<PID>/ で記録し、`kill -0` が ESRCH のときだけ stale として奪う — sandbox 内の
# `kill -0` は生きている他プロセスにも EPERM を返すので、EPERM は生きている扱い。
# PR_PUSH_LOCK_WAIT_SECONDS 秒待っても取れなければ push せず、log に `pr-push: lock_timeout ...` を書いて
# exit LOCK_TIMEOUT_EXIT で終了する（hook 失敗の exit 1 と区別する）。待ち上限は呼び出し側の Bash timeout 600 秒の
# 半分に置き、残りを push 自体に充てる。

set -uo pipefail

PUSH_TAIL_LINES=5
PUSH_TAIL_MAX_COLS=500
PUSH_LOCK_WAIT_SECONDS="${PR_PUSH_LOCK_WAIT_SECONDS:-300}"
PUSH_LOCK_POLL_SECONDS="${PR_PUSH_LOCK_POLL_SECONDS:-2}"
LOCK_TIMEOUT_EXIT=75

log="${1:-}"
if [[ -z "$log" ]]; then
    echo "Usage: pr-push <log-file>" >&2
    exit 2
fi
mkdir -p "$(dirname "$log")" || exit 2

print_result() {
    local esc
    esc="$(printf '\033')"
    echo "pr-push: exit=${rc} log=${log}"
    echo "<<<PUSH_TAIL_BEGIN>>>"
    LC_ALL=C tr '\r' '\n' <"$log" \
        | LC_ALL=C sed "s/${esc}\[[0-9;?]*[A-Za-z]//g" \
        | LC_ALL=C grep -v '^[[:space:]]*$' \
        | tail -n "$PUSH_TAIL_LINES" \
        | LC_ALL=C cut -c "1-${PUSH_TAIL_MAX_COLS}"
    echo "<<<PUSH_TAIL_END>>>"
}

common_dir="$(git rev-parse --path-format=absolute --git-common-dir)" || exit 2
lock="${common_dir}/dev-flow-pr-push.lock"
held=0

release_lock() {
    [[ "$held" -eq 1 ]] || return 0
    rmdir "${lock}/pid-$$" "$lock" 2>/dev/null
    held=0
}
trap release_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# 保持者の PID が ESRCH（存在しない）なら、その pid-<PID>/ のパスを出して 0 を返す。
# 保持者の記録がまだ無い（mkdir 直後）・生きている・EPERM のときは 1。
stale_holder() {
    local entry pid err
    for entry in "$lock"/pid-*; do
        [[ -d "$entry" ]] || continue
        pid="${entry##*/pid-}"
        err="$(export LC_ALL=C; kill -0 "$pid" 2>&1)" && return 1
        [[ "$err" == *"No such process"* ]] || return 1
        echo "$entry"
        return 0
    done
    return 1
}

wait_start=$SECONDS
while ! mkdir "$lock" 2>/dev/null; do
    # pid-<PID>/ を消せた 1 プロセスだけが lock 本体を消す（同時に奪いに来た側は rmdir に失敗して待ちに戻る）
    if stale="$(stale_holder)" && rmdir "$stale" 2>/dev/null && rmdir "$lock" 2>/dev/null; then
        continue
    fi
    if (( SECONDS - wait_start >= PUSH_LOCK_WAIT_SECONDS )); then
        echo "pr-push: lock_timeout waited=${PUSH_LOCK_WAIT_SECONDS}s lock=${lock} (another push in this repo still holds the lock; not pushed)" >"$log"
        rc=$LOCK_TIMEOUT_EXIT
        print_result
        exit "$rc"
    fi
    sleep "$PUSH_LOCK_POLL_SECONDS"
done
held=1
mkdir "${lock}/pid-$$"

git push origin HEAD >"$log" 2>&1
rc=$?

print_result
exit "$rc"
