#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _shared/scripts/jev-classify.sh（正本。issue #690 で dotfiles hooks から移設）
#
# ネットワークには出ない。PATH 先頭に偽 curl を置き、リクエストの組み立てと fail-open
# （失敗は常に空 stdout + exit 0）の挙動を検証する。Keychain には触らない（env で鍵を渡すか、
# PATH 先頭の偽 security が FAKE_SECURITY_EXIT（既定 44 = item なし、ok = 鍵を返す）で応える）。

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
unix_socket=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
  -d) body="$2"; shift 2 ;;
  --unix-socket) unix_socket="$2"; shift 2 ;;
  --max-time|-H|--config) shift 2 ;;
  -*) shift ;;
  *) url="$1"; shift ;;
  esac
done
printf '%s' "$body" >"$FAKE_CURL_DIR/body"
printf '%s %s\n' "${unix_socket:--}" "$url" >>"$FAKE_CURL_DIR/calls"
if [[ -n $unix_socket ]]; then
  case "${FAKE_BROKER_MODE:-ok}" in
  down) echo "curl: (7) Failed to connect to jev-broker port 80" >&2; exit 7 ;;
  error) echo '{"error":"jev-broker: keychain read failed (item x: security exit 36)"}'; exit 22 ;;
  esac
fi
case "${FAKE_CURL_MODE:-ok}" in
ok) echo '{"model":"typesafe-ai/jev","answers":{"kind":{"type":"choice","choice":"override","probabilities":{"override":0.93,"conflict":0.05,"unrelated":0.02}}},"usage":{"input_tokens":120,"output_tokens":0}}' ;;
fail) echo '{"message":"boom","error_type":"invalid_request"}'; exit 22 ;;
timeout) echo 'curl: (28) Operation timed out' >&2; exit 28 ;;
garbage) echo '<html>502</html>' ;;
esac
FAKE
    chmod +x "$WORK/bin/curl"
    cat >"$WORK/bin/security" <<'FAKE'
#!/usr/bin/env bash
echo called >>"$FAKE_CURL_DIR/security_calls"
if [[ "${FAKE_SECURITY_EXIT:-44}" == "ok" ]]; then
  echo "vck_from_keychain"
  exit 0
fi
exit "${FAKE_SECURITY_EXIT:-44}"
FAKE
    chmod +x "$WORK/bin/security"
    REASON="$WORK/reason"
    export FAKE_CURL_DIR="$WORK"
    export PATH="$WORK/bin:$PATH"
    # 実機の jev-broker ソケットを拾わない。broker のテストは make_socket で作る
    export JEV_BROKER_SOCKET="$WORK/no-broker.sock"
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

# ---- --reason-file（issue #728: 「応答なし」を原因別に呼び出し側へ返す）----

@test "--reason-file: 成功時は書かない" {
    run bash -c "echo x | '$SCRIPT' --reason-file '$REASON' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ -n "$output" ]
    [ ! -e "$REASON" ]
}

@test "--reason-file: Keychain に届かない（security exit 36）-> keychain unreachable、curl 未呼び出し" {
    run bash -c "echo x | env -u AI_GATEWAY_API_KEY FAKE_SECURITY_EXIT=36 '$SCRIPT' --reason-file '$REASON' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    grep -qx 'keychain unreachable (security exit 36: errSecInteractionNotAllowed; locked, sandboxed, or another login session such as a bg job)' "$REASON"
    [ ! -f "$WORK/argv" ]
}

@test "--reason-file: Keychain item なし（exit 44）/ その他の exit code を区別する" {
    run bash -c "echo x | env -u AI_GATEWAY_API_KEY FAKE_SECURITY_EXIT=44 '$SCRIPT' --reason-file '$REASON' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    grep -qx "no API key (keychain item '$JEV_KEYCHAIN_SERVICE' not found: security exit 44)" "$REASON"
    run bash -c "echo x | env -u AI_GATEWAY_API_KEY FAKE_SECURITY_EXIT=51 '$SCRIPT' --reason-file '$REASON' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    grep -qx 'keychain read failed (security exit 51)' "$REASON"
}

@test "Keychain から鍵が取れれば --config stdin で渡す" {
    run bash -c "echo x | env -u AI_GATEWAY_API_KEY FAKE_SECURITY_EXIT=ok '$SCRIPT' --reason-file '$REASON' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.answers.kind.choice')" = "override" ]
    grep -q 'Authorization: Bearer vck_from_keychain' "$WORK/stdin"
    [ ! -e "$REASON" ]
}

@test "--reason-file: timeout / request failed / bad response / disabled" {
    run bash -c "echo x | FAKE_CURL_MODE=timeout '$SCRIPT' --reason-file '$REASON' --max-time 9 --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    grep -qx 'timeout (curl exit 28, --max-time 9s)' "$REASON"
    run bash -c "echo x | FAKE_CURL_MODE=fail '$SCRIPT' --reason-file '$REASON' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    grep -q '^request failed (curl exit 22): .*boom' "$REASON"
    run bash -c "echo x | FAKE_CURL_MODE=garbage '$SCRIPT' --reason-file '$REASON' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    grep -q '^bad response (no .answers object): <html>502</html>' "$REASON"
    run bash -c "echo x | JEV_DISABLE=1 '$SCRIPT' --reason-file '$REASON' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    grep -qx 'disabled via JEV_DISABLE' "$REASON"
}

# ---- jev-broker 経由（Keychain に届かない sandbox 内 / bg job 向け）----

# use_socket: JEV_BROKER_SOCKET を実在する Unix ソケットに向ける。偽 curl は接続しないので
# 待ち受けは不要で、`-S` を満たすファイルがあればよい。sandbox 内では bind が拒否されるため、
# そのときは OS が既に持つソケットを借りる（接続はしない）
use_socket() {
    local path="$WORK/broker.sock" existing
    if python3 -c 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$path" 2>/dev/null; then
        export JEV_BROKER_SOCKET="$path"
        return
    fi
    for existing in /var/run/mDNSResponder /nix/var/nix/daemon-socket/socket /var/run/docker.sock; do
        if [[ -S $existing ]]; then
            export JEV_BROKER_SOCKET="$existing"
            return
        fi
    done
    skip "Unix ソケットを用意できない（bind 拒否かつ既存ソケットなし）"
}

@test "broker: ソケットがあれば --unix-socket で送り、鍵を読まず Authorization も付けない" {
    use_socket
    run bash -c "echo x | env -u AI_GATEWAY_API_KEY '$SCRIPT' --reason-file '$REASON' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.answers.kind.choice')" = "override" ]
    grep -qx "$JEV_BROKER_SOCKET http://jev-broker/typesafe/v1/systemone" "$WORK/calls"
    [ "$(wc -l <"$WORK/calls")" -eq 1 ]
    ! grep -q 'Authorization' "$WORK/stdin"
    ! grep -qx -- '--config' "$WORK/argv"
    [ ! -f "$WORK/security_calls" ]
    [ ! -e "$REASON" ]
}

@test "broker: AI_GATEWAY_API_KEY があればソケットより優先して直接呼ぶ" {
    use_socket
    run bash -c "echo x | '$SCRIPT' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    grep -q '^- https://ai-gateway.vercel.sh/typesafe/v1/systemone$' "$WORK/calls"
    grep -q 'Authorization: Bearer vck_test_key' "$WORK/stdin"
}

@test "broker: ソケットでない通常ファイルは broker とみなさない" {
    : >"$JEV_BROKER_SOCKET"
    run bash -c "echo x | env -u AI_GATEWAY_API_KEY FAKE_SECURITY_EXIT=ok '$SCRIPT' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    grep -q '^- https://' "$WORK/calls"
    ! grep -q -- "--unix-socket" "$WORK/argv"
}

@test "broker: 接続できない（curl exit 7）なら Keychain 経路に落ちて成功する" {
    use_socket
    run bash -c "echo x | env -u AI_GATEWAY_API_KEY FAKE_BROKER_MODE=down FAKE_SECURITY_EXIT=ok '$SCRIPT' --reason-file '$REASON' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.answers.kind.choice')" = "override" ]
    [ "$(wc -l <"$WORK/calls")" -eq 2 ]
    grep -q 'Authorization: Bearer vck_from_keychain' "$WORK/stdin"
    [ ! -e "$REASON" ]
}

@test "broker: 接続できず Keychain にも届かない -> 両方の理由を 1 行で返す" {
    use_socket
    run bash -c "echo x | env -u AI_GATEWAY_API_KEY FAKE_BROKER_MODE=down FAKE_SECURITY_EXIT=36 '$SCRIPT' --reason-file '$REASON' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    [ "$(wc -l <"$REASON")" -eq 1 ]
    grep -q "^broker unreachable (curl exit 7 on $JEV_BROKER_SOCKET); keychain unreachable (security exit 36" "$REASON"
}

@test "broker: broker がエラーを返したら Keychain に落ちず broker request failed" {
    use_socket
    run bash -c "echo x | env -u AI_GATEWAY_API_KEY FAKE_BROKER_MODE=error FAKE_SECURITY_EXIT=ok '$SCRIPT' --reason-file '$REASON' --questions '$QUESTIONS'"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    [ "$(wc -l <"$WORK/calls")" -eq 1 ]
    [ ! -f "$WORK/security_calls" ]
    grep -q '^broker request failed (curl exit 22): .*jev-broker: keychain read failed' "$REASON"
}
