#!/usr/bin/env bats
# Tests for dev-flow-improve/scripts/install-schedule.sh (--print のみ検証。--install は launchctl 副作用のため対象外)

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/dev-flow-improve/scripts/install-schedule.sh"
    # claude CLI を PATH stub でモック
    STUB_DIR="$BATS_TMPDIR/stub-$$"
    mkdir -p "$STUB_DIR"
    printf '#!/bin/sh\nexit 0\n' > "$STUB_DIR/claude"
    chmod +x "$STUB_DIR/claude"
    export PATH="$STUB_DIR:$PATH"
}

teardown() {
    rm -rf "$STUB_DIR"
}

@test "--print: plist に Label / claude / /dev-flow-improve / 週次スケジュールを含む" {
    run bash "$SCRIPT" --print
    [ "$status" -eq 0 ]
    [[ "$output" == *"com.playpark.dev-flow-improve"* ]]
    [[ "$output" == *"$STUB_DIR/claude"* ]]
    [[ "$output" == *"/dev-flow-improve"* ]]
    [[ "$output" == *"<key>Weekday</key><integer>6</integer>"* ]]
}

@test "--print: claude CLI 不在なら error" {
    export PATH="/usr/bin:/bin"
    run bash "$SCRIPT" --print
    [ "$status" -ne 0 ]
}

@test "引数なし / 不明引数は usage を出して exit 1" {
    run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    run bash "$SCRIPT" --bogus
    [ "$status" -eq 1 ]
}
