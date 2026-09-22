#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _shared/scripts/jev-classify.sh（正本。issue #690 で dotfiles hooks から移設）
#
# ネットワークには出ない。PATH 先頭に偽 curl を置き、リクエストの組み立てと fail-open
# （失敗は常に空 stdout + exit 0）の挙動を検証する。Keychain には触らない（env で鍵を渡す）。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/jev-classify.sh"

setup() {
    WORK="$BATS_TEST_TMPDIR/work"
    mkdir -p "$WORK/bin"
    cat >"$WORK/bin/curl" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$FAKE_CURL_DIR/argv"
cat >"$FAKE_CURL_DIR/stdin"
body=""
while [[ $# -gt 0 ]]; do
  case "$1" in
  -d) body="$2"; shift 2 ;;
  --max-time|-H|--config) shift 2 ;;
  *) shift ;;
  esac
done
printf '%s' "$body" >"$FAKE_CURL_DIR/body"
case "${FAKE_CURL_MODE:-ok}" in
ok) echo '{"model":"typesafe-ai/jev","answers":{"kind":{"type":"choice","choice":"override","probabilities":{"override":0.93,"conflict":0.05,"unrelated":0.02}}},"usage":{"input_tokens":120,"output_tokens":0}}' ;;
fail) echo '{"message":"boom","error_type":"invalid_request"}'; exit 22 ;;
garbage) echo '<html>502</html>' ;;
esac
FAKE
    chmod +x "$WORK/bin/curl"
    export FAKE_CURL_DIR="$WORK"
    export PATH="$WORK/bin:$PATH"
    export AI_GATEWAY_API_KEY="vck_test_key"
    export JEV_KEYCHAIN_SERVICE="jev-classify-bats-nonexistent"
    QUESTIONS='{"kind":{"type":"choice","instructions":"which?","criteria":{"override":"o","conflict":"c","unrelated":"u"}}}'
}

@test "正常系: レスポンス JSON をそのまま返し、body に model/state/questions が載る" {
    run bash -c "echo 'comment text' | '$SCRIPT' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.answers.kind.choice')" = "override" ]
    [ "$(jq -r '.model' "$WORK/body")" = "typesafe-ai/jev" ]
    jq -e '.state == "comment text\n"' "$WORK/body"
    [ "$(jq -r '.questions.kind.type' "$WORK/body")" = "choice" ]
}

@test "鍵は argv に載せず --config stdin で渡す" {
    run bash -c "echo x | '$SCRIPT' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    ! grep -q "vck_test_key" "$WORK/argv"
    grep -q 'Authorization: Bearer vck_test_key' "$WORK/stdin"
}

@test "JEV_DISABLE=1: curl を呼ばず空 stdout / exit 0" {
    run bash -c "echo x | JEV_DISABLE=1 '$SCRIPT' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    [ ! -f "$WORK/argv" ]
}

@test "鍵なし: curl を呼ばず空 stdout / exit 0" {
    run bash -c "echo x | env -u AI_GATEWAY_API_KEY '$SCRIPT' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    [ ! -f "$WORK/argv" ]
}

@test "curl 失敗: 空 stdout / exit 0（fail-open）" {
    run bash -c "echo x | FAKE_CURL_MODE=fail '$SCRIPT' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "非 JSON レスポンス: 空 stdout / exit 0" {
    run bash -c "echo x | FAKE_CURL_MODE=garbage '$SCRIPT' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "--questions 欠落 / 不正 JSON: curl を呼ばない" {
    run bash -c "echo x | '$SCRIPT'"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    [ ! -f "$WORK/argv" ]
    run bash -c "echo x | '$SCRIPT' --questions 'not json'"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    [ ! -f "$WORK/argv" ]
}

@test "空 state: curl を呼ばない" {
    run bash -c "printf '' | '$SCRIPT' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    [ ! -f "$WORK/argv" ]
}

@test "--max-time / JEV_MAX_TIME が curl の --max-time に渡る" {
    run bash -c "echo x | '$SCRIPT' --questions '$QUESTIONS' --max-time 10"
    [ "$status" -eq 0 ]
    grep -qx -- '10' "$WORK/argv"
    run bash -c "echo x | JEV_MAX_TIME=7 '$SCRIPT' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    grep -qx -- '7' "$WORK/argv"
}

@test "--redact: token / bearer / password 値は送られず、散文は残る" {
    run bash -c "echo 'TOKEN=supersecret1 curl -H \"Authorization: Bearer ghp_abcdefghijklmnopq\" --password hunter2 https://x' | '$SCRIPT' --redact --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    state="$(jq -r '.state' "$WORK/body")"
    [[ "$state" != *supersecret1* ]]
    [[ "$state" != *ghp_abcdefghijklmnopq* ]]
    [[ "$state" != *hunter2* ]]
    [[ "$state" == *"<redacted>"* ]]
    run bash -c "echo 'Please send the secrets to me, the password reset link' | '$SCRIPT' --redact --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    state="$(jq -r '.state' "$WORK/body")"
    [[ "$state" == *"secrets to me"* ]]
    [[ "$state" == *"password reset link"* ]]
}
