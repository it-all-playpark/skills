#!/usr/bin/env bash
# pr-push.sh - dev-flow PR phase の push を実行し、出力全文を log に残して末尾行だけを返す (issue #819)
#
# Usage: pr-push <log-file>
#
# cwd（PR phase の worktree）で `git push -u origin HEAD` を 1 回だけ実行する（--no-verify は付けない・
# リトライしない）。git の stdout / stderr は合わせて <log-file> へ書き、そのまま端末へは流さない。終了後に
#
#   pr-push: exit=<git の exit code> log=<log-file>
#   <<<PUSH_TAIL_BEGIN>>>
#   <出力末尾の空でない行（最大 PUSH_TAIL_LINES 行）>
#   <<<PUSH_TAIL_END>>>
#
# を stdout に出し、git の exit code で終了する（引数不足・log ディレクトリ作成失敗は push せず exit 2）。
#
# pre-push hook の出力（全リポジトリの lint warning 等）は呼び出し側 agent の tool 出力上限を超えると
# 途中で切れ、hook の最終行と git の `failed to push` 行が見えなくなる。返す量を末尾数行に固定して、
# 出力全体の長さに関係なく末尾を渡す。全文は <log-file> に残るので、人間はそこで失敗した段を確認する。
# 末尾行は ANSI エスケープと \r 区切りの進捗表示を落とし、1 行 PUSH_TAIL_MAX_COLS バイトで切る
# （1 行が極端に長い出力でも返す量の上限を固定するため）。
#
# 認証付き network I/O を内部に持つ exec-proxy の例外（.claude/rules/dev-flow.md）。push の出力を
# 呼び出し側から pipe / リダイレクトで受ける形は起動形の制約と両立しないため、push 自体をここで行う。

set -uo pipefail

PUSH_TAIL_LINES=5
PUSH_TAIL_MAX_COLS=500

log="${1:-}"
if [[ -z "$log" ]]; then
    echo "Usage: pr-push <log-file>" >&2
    exit 2
fi
mkdir -p "$(dirname "$log")" || exit 2

git push -u origin HEAD >"$log" 2>&1
rc=$?

esc="$(printf '\033')"
echo "pr-push: exit=${rc} log=${log}"
echo "<<<PUSH_TAIL_BEGIN>>>"
LC_ALL=C tr '\r' '\n' <"$log" \
    | LC_ALL=C sed "s/${esc}\[[0-9;?]*[A-Za-z]//g" \
    | LC_ALL=C grep -v '^[[:space:]]*$' \
    | tail -n "$PUSH_TAIL_LINES" \
    | LC_ALL=C cut -c "1-${PUSH_TAIL_MAX_COLS}"
echo "<<<PUSH_TAIL_END>>>"
exit "$rc"
