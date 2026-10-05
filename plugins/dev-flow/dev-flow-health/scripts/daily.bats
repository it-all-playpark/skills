#!/usr/bin/env bats
# Tests for dev-flow-health/scripts/daily.sh と install-schedule.sh
#
# claude CLI は PATH stub に置き換え、呼ばれたら引数を記録する。
# new / regressed が 0 件の日は stub が呼ばれないこと（LLM を起動しないこと）を確かめる。
# install-schedule.sh は --print のみ検証する（--install は launchctl の副作用があるため対象外）。

setup() {
    SKILL_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
    DAILY="$SKILL_DIR/scripts/daily.sh"
    INSTALL="$SKILL_DIR/scripts/install-schedule.sh"

    JOURNAL="$BATS_TEST_TMPDIR/journal"
    OUT="$BATS_TEST_TMPDIR/out"
    mkdir -p "$JOURNAL"
    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        name="$(printf '%s' "$line" | jq -r '._file')"
        printf '%s' "$line" | jq 'del(._file)' > "$JOURNAL/$name"
    done < "$SKILL_DIR/tests/fixtures/lifecycle.jsonl"

    STUB="$BATS_TEST_TMPDIR/stub"
    CALLS="$BATS_TEST_TMPDIR/claude-calls"
    mkdir -p "$STUB"
    printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\n' "$CALLS" > "$STUB/claude"
    chmod +x "$STUB/claude"
    export PATH="$STUB:$PATH"
}

daily() {
    bash "$DAILY" --out-dir "$OUT" --journal-dir "$JOURNAL" --repo "$BATS_TEST_TMPDIR/no-repo" "$@"
}

@test "new / regressed が 0 件の日は LLM（claude）を呼ばずにレポートだけ書く" {
    # 窓 10-05..10-06 には fixture の失敗が無い
    run daily --date 2026-10-06 --now 2026-10-06T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.needs_llm')" = "false" ]
    [ "$(printf '%s' "$output" | jq '.llm_invoked')" = "false" ]
    [ ! -f "$CALLS" ]
    [ -f "$OUT/2026-10-06.json" ]
    [ "$(jq -c '.summary' "$OUT/2026-10-06.json")" = '{"new":0,"regressed":0,"ongoing":4,"resolved":1}' ]
}

@test "new / regressed がある日だけ claude -p で dev-flow-health skill にレポートを渡す" {
    run daily --date 2026-10-05 --now 2026-10-05T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.needs_llm')" = "true" ]
    [ "$(printf '%s' "$output" | jq '.llm_invoked')" = "true" ]
    [ "$(printf '%s' "$output" | jq '.llm_exit')" = "0" ]
    [ "$(wc -l < "$CALLS" | tr -d ' ')" = "1" ]
    [ "$(cat "$CALLS")" = "-p /dev-flow:dev-flow-health $OUT/2026-10-05.json" ]
    [ "$(jq '.summary.new + .summary.regressed' "$OUT/2026-10-05.json")" = "3" ]
}

@test "窓の始点は前回レポートの generated_at — 実行が空いた日の新規も取りこぼさない" {
    mkdir -p "$OUT"
    echo '{"generated_at":"2026-10-04T15:00:00Z"}' > "$OUT/2026-10-04.json"
    run daily --date 2026-10-06 --now 2026-10-06T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(jq -r '.window.since' "$OUT/2026-10-06.json")" = "2026-10-04T15:00:00Z" ]
    # 10-04T18:00 の再発が窓に入る
    [ "$(jq '.summary.regressed' "$OUT/2026-10-06.json")" = "1" ]
    [ "$(printf '%s' "$output" | jq '.llm_invoked')" = "true" ]
}

@test "claude が失敗しても日次実行は止まらず終了コードを記録する" {
    printf '#!/bin/sh\nexit 3\n' > "$STUB/claude"
    run daily --date 2026-10-05 --now 2026-10-05T00:00:00Z
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq '.llm_exit')" = "3" ]
}

@test "install-schedule --print: 毎日 07:00 に daily.sh を登録時の PATH で起動する plist" {
    run bash "$INSTALL" --print
    [ "$status" -eq 0 ]
    [[ "$output" == *"<string>com.playpark.dev-flow-health</string>"* ]]
    [[ "$output" == *"<string>$SKILL_DIR/scripts/daily.sh</string>"* ]]
    [[ "$output" == *"<key>Hour</key><integer>7</integer>"* ]]
    [[ "$output" != *"<key>Weekday</key>"* ]]
    [[ "$output" == *"<key>PATH</key><string>$STUB:"* ]]
}

@test "install-schedule --print: claude CLI 不在なら error、不明引数は usage で exit 1" {
    PATH="/usr/bin:/bin" run bash "$INSTALL" --print
    [ "$status" -ne 0 ]
    run bash "$INSTALL"
    [ "$status" -eq 1 ]
    run bash "$INSTALL" --bogus
    [ "$status" -eq 1 ]
}
