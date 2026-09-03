#!/usr/bin/env bats
# Tests for _lib/scripts/detect-stack.sh
#
# detect-stack.sh は framework 検出のみを行う決定論的門番 (issue #497)。
# 出力は {"frameworks": [...]} のみ。vendored skill へのマッピング
# (best_practice_skills / rules_paths) は出力しない。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/detect-stack.sh"

@test "(a) next 依存の package.json -> frameworks に next が含まれる" {
    PROJ="$BATS_TEST_TMPDIR/proj-next"
    mkdir -p "$PROJ"
    cat > "$PROJ/package.json" <<'JSON'
{
  "dependencies": {
    "next": "14.0.0",
    "react": "18.0.0"
  }
}
JSON

    run "$SCRIPT" "$PROJ"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.frameworks | index("next") != null' >/dev/null
}

@test "(b1) 依存なし package.json -> frameworks が []" {
    PROJ="$BATS_TEST_TMPDIR/proj-empty"
    mkdir -p "$PROJ"
    cat > "$PROJ/package.json" <<'JSON'
{
  "dependencies": {}
}
JSON

    run "$SCRIPT" "$PROJ"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.frameworks == []' >/dev/null
}

@test "(b2) package.json なし -> frameworks が []" {
    PROJ="$BATS_TEST_TMPDIR/proj-none"
    mkdir -p "$PROJ"

    run "$SCRIPT" "$PROJ"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.frameworks == []' >/dev/null
}

@test "(c) 出力 JSON に rules_paths キーが含まれない (回帰防止)" {
    PROJ="$BATS_TEST_TMPDIR/proj-next2"
    mkdir -p "$PROJ"
    cat > "$PROJ/package.json" <<'JSON'
{
  "dependencies": {
    "next": "14.0.0"
  }
}
JSON

    run "$SCRIPT" "$PROJ"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e 'has("rules_paths") == false' >/dev/null
}

@test "(d) 出力 JSON に best_practice_skills キーが含まれない (回帰防止)" {
    PROJ="$BATS_TEST_TMPDIR/proj-next3"
    mkdir -p "$PROJ"
    cat > "$PROJ/package.json" <<'JSON'
{
  "dependencies": {
    "next": "14.0.0"
  }
}
JSON

    run "$SCRIPT" "$PROJ"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e 'has("best_practice_skills") == false' >/dev/null
}

@test "(e) remotion 依存 -> frameworks に remotion が含まれる" {
    PROJ="$BATS_TEST_TMPDIR/proj-remotion"
    mkdir -p "$PROJ"
    cat > "$PROJ/package.json" <<'JSON'
{
  "dependencies": {
    "remotion": "4.0.0",
    "@remotion/cli": "4.0.0"
  }
}
JSON

    run "$SCRIPT" "$PROJ"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.frameworks | index("remotion") != null' >/dev/null
}

@test "(f) .env に neon.tech を含む -> frameworks に neon が含まれる" {
    PROJ="$BATS_TEST_TMPDIR/proj-neon"
    mkdir -p "$PROJ"
    cat > "$PROJ/.env" <<'ENV'
DATABASE_URL=postgres://user:pass@ep-cool-name-123456.us-east-2.aws.neon.tech/db
ENV

    run "$SCRIPT" "$PROJ"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.frameworks | index("neon") != null' >/dev/null
}

@test "output キーが frameworks のみ (jq 経路)" {
    PROJ="$BATS_TEST_TMPDIR/proj-keys"
    mkdir -p "$PROJ"

    run "$SCRIPT" "$PROJ"

    [ "$status" -eq 0 ]
    keys="$(echo "$output" | jq -c '. | keys')"
    [ "$keys" = '["frameworks"]' ]
}
