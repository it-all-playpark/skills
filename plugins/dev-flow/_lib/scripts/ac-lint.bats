#!/usr/bin/env bats
# Tests for _lib/scripts/ac-lint.sh
#
# AC (Acceptance Criteria) 契約 lint: issue body の中に AC 見出し
# (受け入れ基準|受け入れ条件|Acceptance Criteria|完了条件) を検出し、
# セクション内の checkbox / 箇条書きの有無から 3 値 verdict を判定する。
#
# verdict:
#   t1           - AC 見出し + `- [ ]` / `- [x]` checkbox 行 >= 1
#   t2           - AC 見出し + checkbox 以外の箇条書き（- / * / N.）行 >= 1
#   non_compliant - 見出し不在、またはセクションが空/該当行なし
#
# exit code: t1/t2 -> 0, non_compliant -> 3, usage/IO エラー -> 1

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/ac-lint.sh"

write_body() {
    local out="$1"
    shift
    printf '%s\n' "$@" > "$out"
}

@test "(1) 受け入れ基準見出し + checkbox 2行 -> t1 / exit 0" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "# Title" \
        "" \
        "## 受け入れ基準" \
        "- [ ] AC-1 foo" \
        "- [ ] AC-2 bar"

    run "$SCRIPT" "$BODY"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true' >/dev/null
    echo "$output" | jq -e '.verdict == "t1"' >/dev/null
    echo "$output" | jq -e '.heading_found == true' >/dev/null
    echo "$output" | jq -e '.checkbox_count == 2' >/dev/null
}

@test "(2) 後続テキスト付き見出し '## 受け入れ基準（Acceptance Criteria）' + checkbox -> t1" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 受け入れ基準（Acceptance Criteria）" \
        "- [ ] AC-1 foo"

    run "$SCRIPT" "$BODY"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "t1"' >/dev/null
    echo "$output" | jq -e '.heading_found == true' >/dev/null
}

@test "(3) level-3 見出し '### 完了条件' + checkbox -> t1" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "### 完了条件" \
        "- [ ] done"

    run "$SCRIPT" "$BODY"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "t1"' >/dev/null
}

@test "(4) チェック済み checkbox '- [x]' のみ -> t1" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 受け入れ基準" \
        "- [x] done" \
        "- [X] also done"

    run "$SCRIPT" "$BODY"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "t1"' >/dev/null
    echo "$output" | jq -e '.checkbox_count == 2' >/dev/null
}

@test "(5) 大文字小文字ゆらぎ '## acceptance criteria' + 箇条書き -> t2 / exit 0" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## acceptance criteria" \
        "- foo" \
        "- bar"

    run "$SCRIPT" "$BODY"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true' >/dev/null
    echo "$output" | jq -e '.verdict == "t2"' >/dev/null
    echo "$output" | jq -e '.bullet_count == 2' >/dev/null
}

@test "(6) 見出し + 番号リスト '1. ' -> t2" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## Acceptance Criteria" \
        "1. first" \
        "2. second"

    run "$SCRIPT" "$BODY"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "t2"' >/dev/null
    echo "$output" | jq -e '.bullet_count == 2' >/dev/null
}

@test "(7) checkbox はあるが AC 見出しなし -> non_compliant / exit 3 / heading_found false" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## Tasks" \
        "- [ ] not an AC section"

    run "$SCRIPT" "$BODY"

    [ "$status" -eq 3 ]
    echo "$output" | jq -e '.ok == true' >/dev/null
    echo "$output" | jq -e '.verdict == "non_compliant"' >/dev/null
    echo "$output" | jq -e '.heading_found == false' >/dev/null
}

@test "(8) 見出しありセクション空（直後に次見出し）-> non_compliant" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 受け入れ基準" \
        "## テスト戦略" \
        "- Unit: foo"

    run "$SCRIPT" "$BODY"

    [ "$status" -eq 3 ]
    echo "$output" | jq -e '.verdict == "non_compliant"' >/dev/null
    echo "$output" | jq -e '.heading_found == true' >/dev/null
}

@test "(9) checkbox が AC セクション外（次見出しの後）のみ -> non_compliant" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 受け入れ基準" \
        "" \
        "## テスト戦略" \
        "- [ ] not counted, outside AC section"

    run "$SCRIPT" "$BODY"

    [ "$status" -eq 3 ]
    echo "$output" | jq -e '.verdict == "non_compliant"' >/dev/null
}

@test "(10) CRLF body -> t1" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    printf '## 受け入れ基準\r\n- [ ] AC-1\r\n' > "$BODY"

    run "$SCRIPT" "$BODY"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "t1"' >/dev/null
}

@test "(11a) 引数なし -> exit 1 + ok:false" {
    run "$SCRIPT"

    [ "$status" -eq 1 ]
    echo "$output" | jq -e '.ok == false' >/dev/null
}

@test "(11b) 不在ファイル -> exit 1 + ok:false" {
    run "$SCRIPT" "$BATS_TEST_TMPDIR/does-not-exist.md"

    [ "$status" -eq 1 ]
    echo "$output" | jq -e '.ok == false' >/dev/null
}

@test "(11c) 空ファイル -> exit 1 + ok:false" {
    BODY="$BATS_TEST_TMPDIR/empty.md"
    : > "$BODY"

    run "$SCRIPT" "$BODY"

    [ "$status" -eq 1 ]
    echo "$output" | jq -e '.ok == false' >/dev/null
}

@test "(12) '## 受入条件'（enum 外表記）-> non_compliant" {
    BODY="$BATS_TEST_TMPDIR/body.md"
    write_body "$BODY" \
        "## 受入条件" \
        "- [ ] AC-1"

    run "$SCRIPT" "$BODY"

    [ "$status" -eq 3 ]
    echo "$output" | jq -e '.verdict == "non_compliant"' >/dev/null
    echo "$output" | jq -e '.heading_found == false' >/dev/null
}
