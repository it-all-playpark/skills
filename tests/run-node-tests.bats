#!/usr/bin/env bats
# run-node-tests.bats - DEVFLOW_TEST_FILES（dev-flow run-tests --files、issue #865）で
# 落ちたファイルだけを vitest に渡すことの検査。
#
# fixture repo に実物の run-node-tests.sh を tests/ へ複写し、node_modules/.bin/vitest を受け取った引数を
# 書き出す stub に差し替える。REPO_ROOT はスクリプト自身の位置から決まるので fixture が repo root になる。

setup() {
    FIXTURE="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$FIXTURE/tests" "$FIXTURE/node_modules/.bin"
    cp "$BATS_TEST_DIRNAME/run-node-tests.sh" "$FIXTURE/tests/"
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "%s/vitest.args"\nexit 0\n' "$BATS_TEST_TMPDIR" \
        > "$FIXTURE/node_modules/.bin/vitest"
    chmod +x "$FIXTURE/node_modules/.bin/vitest"
    LIST="$BATS_TEST_TMPDIR/files.txt"
    unset DEVFLOW_CHANGED_FILES DEVFLOW_BASE DEVFLOW_TEST_FILES
}

@test "test files: 一覧の .test.mjs だけを vitest に渡す" {
    printf '%s\n' plugins/x/a.bats plugins/x/b.test.mjs tests/c.test.mjs > "$LIST"

    DEVFLOW_TEST_FILES="$LIST" run bash "$FIXTURE/tests/run-node-tests.sh"

    [ "$status" -eq 0 ]
    [ "$(cat "$BATS_TEST_TMPDIR/vitest.args")" = "$(printf '%s\n' run --configLoader runner plugins/x/b.test.mjs tests/c.test.mjs)" ]
}

@test "test files: .test.mjs が 1 件も無ければ vitest を起動せず exit 0" {
    printf '%s\n' plugins/x/a.bats > "$LIST"

    DEVFLOW_TEST_FILES="$LIST" run bash "$FIXTURE/tests/run-node-tests.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"lists no .test.mjs file"* ]]
    [ ! -f "$BATS_TEST_TMPDIR/vitest.args" ]
}

@test "test files: 未設定・読めない一覧は全件（ファイル引数なし）" {
    run bash "$FIXTURE/tests/run-node-tests.sh"
    [ "$status" -eq 0 ]
    [ "$(cat "$BATS_TEST_TMPDIR/vitest.args")" = "$(printf '%s\n' run --configLoader runner)" ]

    DEVFLOW_TEST_FILES="$BATS_TEST_TMPDIR/missing.txt" run bash "$FIXTURE/tests/run-node-tests.sh"
    [ "$status" -eq 0 ]
    [ "$(cat "$BATS_TEST_TMPDIR/vitest.args")" = "$(printf '%s\n' run --configLoader runner)" ]
}
