#!/usr/bin/env bats
# Tests for _shared/scripts/ensure-worktree-deps.sh
#
# Strategy: mktemp -d で一時ディレクトリを作成し、ファイルの有無で挙動を検証する。
# NOTE: F2 でスクリプトが実装されるまでこれらのテストは fail (red) になる。

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/_shared/scripts/ensure-worktree-deps.sh"
    TMP_DIR="$(mktemp -d)"
}

teardown() {
    rm -rf "$TMP_DIR"
}

@test "依存ファイル皆無のディレクトリで exit 0 かつ no_dependencies を含む JSON を stdout に出す" {
    # TMP_DIR は空 — 依存ファイルなし
    run "$SCRIPT" --path "$TMP_DIR"
    [ "$status" -eq 0 ]
    [[ "$output" == *"no_dependencies"* ]]
}

@test "--path 未指定で非 0 exit (必須引数エラー)" {
    run "$SCRIPT"
    [ "$status" -ne 0 ]
}

@test "package.json のみ (lock なし) のディレクトリでも exit 0 (pm_not_found 経由)" {
    # lock ファイルなし、package.json のみ → npm-no-lock として検出
    # テスト環境に npm がある場合でも install 失敗 / already_installed / installed いずれかで exit 0
    echo '{"name":"test","version":"1.0.0"}' > "$TMP_DIR/package.json"
    run "$SCRIPT" --path "$TMP_DIR"
    [ "$status" -eq 0 ]
}

@test "detect-and-install.sh が存在しないパスで呼ばれても exit 0 かつ status:failed の JSON を返す" {
    # /nonexistent/xyz を渡すと detect-and-install.sh が die_json で exit 1 する
    run "$SCRIPT" --path "/nonexistent/xyz_$$"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"status":"failed"'* ]]
}

@test "委譲先失敗時の JSON に path フィールドが含まれる" {
    run "$SCRIPT" --path "/nonexistent/xyz_$$"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"path"'* ]]
}

@test "委譲先失敗時のフォールバック JSON が jq で parse でき status が failed である" {
    # JSON は stdout、診断 warning は stderr に出る。bats の run は両者を $output に
    # 結合するため、jq parse には stdout のみを渡す (2>/dev/null で stderr を分離)。
    run bash -c "'$SCRIPT' --path '/nonexistent/xyz_$$' 2>/dev/null"
    [ "$status" -eq 0 ]
    # Validate JSON is well-formed and status field equals "failed".
    # printf '%s' (not echo) so literal "\n" inside the JSON string stays as data
    # regardless of the shell's echo escape semantics (zsh / xpg_echo).
    printf '%s\n' "$output" | jq -e '.status == "failed"'
}
