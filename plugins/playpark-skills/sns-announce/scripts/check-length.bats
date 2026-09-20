#!/usr/bin/env bats
# Tests for sns-announce/scripts/check-length.sh
#
# X counts W/F chars as 2, others as 1, URLs as a flat 23; Bluesky is plain len.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/sns-announce/scripts/check-length.sh"
    URL="https://www.playpark.co.jp/blog/example-slug?utm_source=x&utm_medium=social&utm_campaign=example-slug"
}

@test "x: ascii counts 1 per char" {
    run bash "$SCRIPT" --platform x "abcde"
    [ "$status" -eq 0 ]
    [ "$output" = $'x\t5\t280\tok' ]
}

@test "x: CJK counts 2 per char, URL is a flat 23" {
    # 6 W chars (12) + space (1) + URL (23) + space (1) + "#tag" (4) = 41
    run bash "$SCRIPT" --platform x "日本語テスト $URL #tag"
    [ "$status" -eq 0 ]
    [ "$output" = $'x\t41\t280\tok' ]
}

@test "x: 141 CJK chars = 282 -> over, exit 1" {
    text="$(python3 -c 'print("あ"*141)')"
    run bash "$SCRIPT" --platform x "$text"
    [ "$status" -eq 1 ]
    [ "$output" = $'x\t282\t280\tover' ]
}

@test "x: exactly 280 is ok" {
    text="$(python3 -c 'print("あ"*140)')"
    run bash "$SCRIPT" --platform x "$text"
    [ "$status" -eq 0 ]
    [ "$output" = $'x\t280\t280\tok' ]
}

@test "bluesky: plain char count, URL not shortened" {
    run bash "$SCRIPT" --platform bluesky "あいう $URL"
    [ "$status" -eq 0 ]
    [ "$output" = "bluesky	$((4 + ${#URL}))	300	ok" ]
}

@test "stdin text when no positional text" {
    run bash -c "printf 'abc' | bash '$SCRIPT' --platform bluesky"
    [ "$status" -eq 0 ]
    [ "$output" = $'bluesky\t3\t300\tok' ]
}

@test "zernio array: checks only x/bluesky items, exit 1 when any over" {
    f="$BATS_TEST_TMPDIR/posts.json"
    python3 - "$f" <<'PY'
import json, sys
ja = "あ" * 141
json.dump([
    {"content": ja, "schedule": "2026-09-23 07:30", "platforms": ["x"]},
    {"content": "short", "schedule": "2026-09-23 07:30", "platforms": ["bluesky"]},
    {"content": "x" * 5000, "schedule": "2026-09-23 08:30", "platforms": ["linkedin"]},
], open(sys.argv[1], "w"), ensure_ascii=False)
PY
    run bash "$SCRIPT" "$f"
    [ "$status" -eq 1 ]
    [ "${lines[0]}" = $'x\t282\t280\tover' ]
    [ "${lines[1]}" = $'bluesky\t5\t300\tok' ]
    [ "${#lines[@]}" -eq 2 ]
}

@test "standard json (posts map) is accepted" {
    f="$BATS_TEST_TMPDIR/std.json"
    printf '{"source":"a.mdx","posts":{"x":"hello","linkedin":"long"}}' > "$f"
    run bash "$SCRIPT" "$f"
    [ "$status" -eq 0 ]
    [ "$output" = $'x\t5\t280\tok' ]
}

@test "unsupported platform exits non-zero" {
    run bash "$SCRIPT" --platform linkedin "hi"
    [ "$status" -ne 0 ]
}

@test "no args exits non-zero with usage" {
    run bash "$SCRIPT"
    [ "$status" -ne 0 ]
}
