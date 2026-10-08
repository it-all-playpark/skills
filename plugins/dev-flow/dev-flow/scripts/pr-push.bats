#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for dev-flow/scripts/pr-push.sh (issue #819)
#
# PR phase の push は pre-push hook の出力が tool 出力上限を超えると末尾（hook の最終行と git の
# `failed to push` 行）が agent から見えなくなる。pr-push は出力全文を log に残し、末尾行だけを
# PUSH_TAIL マーカーで挟んで返す。出力全体の長さに関係なく、返す量は末尾数行に固定される。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/pr-push.sh"

setup() {
    export GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR"
    REMOTE="$BATS_TEST_TMPDIR/remote.git"
    WT="$BATS_TEST_TMPDIR/wt"
    LOG="$WT/.devflow-tmp/push-output.log"
    git init -q --bare "$REMOTE"
    git init -q -b main "$WT"
    git -C "$WT" config user.name "Test"
    git -C "$WT" config user.email "test@example.com"
    git -C "$WT" remote add origin "$REMOTE"
    echo x >"$WT/a.txt"
    git -C "$WT" add a.txt
    git -C "$WT" commit -q -m init
    git -C "$WT" checkout -q -b feature/issue-1
}

# pre-push hook を置く。$1 は hook 本体（sh）。
install_hook() {
    printf '#!/bin/sh\n%s\n' "$1" >"$WT/.git/hooks/pre-push"
    chmod +x "$WT/.git/hooks/pre-push"
}

# stdout の PUSH_TAIL マーカー間の行
tail_block() {
    printf '%s\n' "$output" | sed -n '/^<<<PUSH_TAIL_BEGIN>>>$/,/^<<<PUSH_TAIL_END>>>$/p' | sed '1d;$d'
}

@test "hook が大量に出力して失敗しても、末尾に hook の最終行と git の failed to push 行が入り、返す量は小さい" {
    install_hook 'i=1; while [ $i -le 6000 ]; do echo "  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any ($i)"; i=$((i+1)); done
echo "✓ Lint passed"
echo "❌ Pre-push checks failed: unit tests"
exit 1'
    cd "$WT"
    run bash "$SCRIPT" "$LOG"
    [ "$status" -eq 1 ]
    [ "$(printf '%s\n' "$output" | head -n 1)" = "pr-push: exit=1 log=$LOG" ]
    tail="$(tail_block)"
    [[ "$tail" == *"❌ Pre-push checks failed: unit tests"* ]]
    [[ "$tail" == *"failed to push some refs"* ]]
    # hook の最終行の直後が git の failed to push 行
    [ "$(printf '%s\n' "$tail" | grep -A1 -F '❌ Pre-push checks failed: unit tests' | tail -n 1 | grep -c 'failed to push')" -eq 1 ]
    # 出力全体（約 50 万字）に関係なく、返す量は末尾数行に収まる
    [ "${#output}" -lt 4000 ]
    [ "$(printf '%s\n' "$tail" | wc -l | tr -d ' ')" -le 5 ]
}

@test "出力全文が log に残る（先頭の warning から git の failed to push 行まで）" {
    install_hook 'i=1; while [ $i -le 6000 ]; do echo "warning line $i"; i=$((i+1)); done
echo "❌ Pre-push checks failed"
exit 1'
    cd "$WT"
    run bash "$SCRIPT" "$LOG"
    [ "$status" -eq 1 ]
    [ -f "$LOG" ]
    [ "$(grep -c '^warning line ' "$LOG")" -eq 6000 ]
    grep -qx 'warning line 1' "$LOG"
    grep -q 'failed to push some refs' "$LOG"
}

@test "ANSI エスケープと末尾の空行を落とした行を返す" {
    install_hook 'printf "lint ok\n\033[31m❌ Pre-push checks failed\033[0m\n\n\n"
exit 1'
    cd "$WT"
    run bash "$SCRIPT" "$LOG"
    [ "$status" -eq 1 ]
    tail="$(tail_block)"
    printf '%s\n' "$tail" | grep -qx '❌ Pre-push checks failed'
    [ "$(printf '%s\n' "$tail" | grep -c "$(printf '\033')")" -eq 0 ]
    [ "$(printf '%s\n' "$tail" | grep -cx '')" -eq 0 ]
}

@test "1 行が極端に長くても返す行は 500 バイトで切る" {
    install_hook 'head -c 100000 /dev/zero | tr "\0" "x"; echo
exit 1'
    cd "$WT"
    run bash "$SCRIPT" "$LOG"
    [ "$status" -eq 1 ]
    [ "${#output}" -lt 4000 ]
    while IFS= read -r line; do
        [ "$(printf '%s' "$line" | LC_ALL=C wc -c | tr -d ' ')" -le 500 ]
    done <<< "$(tail_block)"
}

@test "hook が通れば exit 0 で同名 branch へ push され、.git/config に upstream を書かない" {
    install_hook 'echo "✓ all checks passed"; exit 0'
    cd "$WT"
    run bash "$SCRIPT" "$LOG"
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | head -n 1)" = "pr-push: exit=0 log=$LOG" ]
    printf '%s\n' "$output" | grep -qx '<<<PUSH_TAIL_BEGIN>>>'
    printf '%s\n' "$output" | grep -qx '<<<PUSH_TAIL_END>>>'
    tail_block | grep -qx '✓ all checks passed'
    [ "$(git -C "$REMOTE" rev-parse refs/heads/feature/issue-1)" = "$(git -C "$WT" rev-parse HEAD)" ]
    run git -C "$WT" config --get "branch.feature/issue-1.merge"
    [ "$status" -ne 0 ]
}

@test "push.default が simple（upstream 無し）でも同名 branch へ届く" {
    install_hook 'exit 0'
    git -C "$WT" config push.default simple
    cd "$WT"
    # 環境の GIT_CONFIG_*（wrapper の push.default=current）を外し、repo の simple を効かせる
    run env -u GIT_CONFIG_COUNT bash "$SCRIPT" "$LOG"
    [ "$status" -eq 0 ]
    [ "$(git -C "$REMOTE" rev-parse refs/heads/feature/issue-1)" = "$(git -C "$WT" rev-parse HEAD)" ]
}

@test "log 引数が無ければ push せず exit 2" {
    install_hook 'exit 0'
    cd "$WT"
    run bash "$SCRIPT"
    [ "$status" -eq 2 ]
    run git -C "$REMOTE" rev-parse --verify --quiet refs/heads/feature/issue-1
    [ "$status" -ne 0 ]
}

@test "push は git push origin HEAD の 1 回だけで、--no-verify を使わない" {
    run grep -v '^[[:space:]]*#' "$SCRIPT"
    [ "$(printf '%s\n' "$output" | grep -c 'git push')" -eq 1 ]
    printf '%s\n' "$output" | grep -q '^git push origin HEAD '
    [ "$(printf '%s\n' "$output" | grep -c -- '--no-verify')" -eq 0 ]
}
