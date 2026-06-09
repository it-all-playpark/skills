#\!/usr/bin/env bats
# Tests for _shared/scripts/diff-risk-classify.sh
#
# Strategy: mktemp -d で隔離 git repo を作成し、各 danger class の陽性/陰性 diff を
# commit してスクリプトの出力を検証する。
# NOTE: F2 でスクリプトが実装されるまでこれらのテストは fail (red) になる。
#
# Class 文字列: auth / crypto / config / data-migration / public-api / exec-sink / dependency

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/_shared/scripts/diff-risk-classify.sh"
    REPO="$(mktemp -d)"
    git -C "$REPO" init -q
    git -C "$REPO" config user.email t@t
    git -C "$REPO" config user.name t
    git -C "$REPO" commit -q --allow-empty -m base
    BASE="$(git -C "$REPO" rev-parse HEAD)"
}

teardown() {
    rm -rf "$REPO"
}

# ---------------------------------------------------------------------------
# 1. auth POSITIVE
# ---------------------------------------------------------------------------
@test "auth POSITIVE: requireAuth を含む src/auth.ts -> class auth の hit オブジェクトを返す" {
    mkdir -p "$REPO/src"
    printf 'function requireAuth(user) {\n  return user.isAuthenticated;\n}\n' \
        > "$REPO/src/auth.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"auth"'* ]]
    [[ "$output" == *'auth.ts'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "auth")] | length > 0'
}

# ---------------------------------------------------------------------------
# 2. auth NEGATIVE
# ---------------------------------------------------------------------------
@test "auth NEGATIVE: README に hello world の変更 -> 出力は []" {
    printf 'hello world\n' > "$REPO/README.md"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

# ---------------------------------------------------------------------------
# 3. crypto POSITIVE
# ---------------------------------------------------------------------------
@test "crypto POSITIVE: crypto.createHash を含むファイル -> class crypto の hit オブジェクトを返す" {
    mkdir -p "$REPO/src"
    printf 'const hash = crypto.createHash("sha256");\n' \
        > "$REPO/src/util.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"crypto"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "crypto")] | length > 0'
}

# ---------------------------------------------------------------------------
# 4. crypto NEGATIVE
# ---------------------------------------------------------------------------
@test "crypto NEGATIVE: 無害な変更 -> 出力は []" {
    printf 'const x = 1;\n' > "$REPO/src/index.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

# ---------------------------------------------------------------------------
# 5. config POSITIVE
# ---------------------------------------------------------------------------
@test "config POSITIVE: .env ファイルに API_TOKEN= を追加 -> class config の hit オブジェクトを返す" {
    printf 'API_TOKEN=supersecret\n' > "$REPO/.env"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"config"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "config")] | length > 0'
}

# ---------------------------------------------------------------------------
# 6. config NEGATIVE
# ---------------------------------------------------------------------------
@test "config NEGATIVE: 無害な変更 -> 出力は []" {
    printf 'just a comment\n' > "$REPO/notes.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

# ---------------------------------------------------------------------------
# 7. data-migration POSITIVE
# ---------------------------------------------------------------------------
@test "data-migration POSITIVE: migrations/ 配下の ALTER TABLE 含むファイル -> class data-migration を返す" {
    mkdir -p "$REPO/migrations"
    printf 'ALTER TABLE users ADD COLUMN verified BOOLEAN;\n' \
        > "$REPO/migrations/0001_add_verified.sql"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"data-migration"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "data-migration")] | length > 0'
}

# ---------------------------------------------------------------------------
# 8. data-migration NEGATIVE
# ---------------------------------------------------------------------------
@test "data-migration NEGATIVE: 無害な変更 -> 出力は []" {
    printf 'select 1;\n' > "$REPO/query.sql"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

# ---------------------------------------------------------------------------
# 9. public-api POSITIVE
# ---------------------------------------------------------------------------
@test "public-api POSITIVE: export function を含むファイル -> class public-api を返す" {
    mkdir -p "$REPO/src"
    printf 'export function getUser(id) {\n  return db.find(id);\n}\n' \
        > "$REPO/src/api.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"public-api"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "public-api")] | length > 0'
}

# ---------------------------------------------------------------------------
# 10. public-api NEGATIVE
# ---------------------------------------------------------------------------
@test "public-api NEGATIVE: export なしの内部関数 -> 出力は []" {
    mkdir -p "$REPO/src"
    printf 'function helper() {\n  return 42;\n}\n' \
        > "$REPO/src/helper.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

# ---------------------------------------------------------------------------
# 11. exec-sink POSITIVE
# ---------------------------------------------------------------------------
@test "exec-sink POSITIVE: eval( を含むファイル -> class exec-sink を返す" {
    mkdir -p "$REPO/src"
    printf 'const result = eval(userInput);\n' \
        > "$REPO/src/runner.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"exec-sink"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "exec-sink")] | length > 0'
}

# ---------------------------------------------------------------------------
# 12. exec-sink NEGATIVE
# ---------------------------------------------------------------------------
@test "exec-sink NEGATIVE: 無害な変更 -> 出力は []" {
    printf 'const x = 2 + 2;\n' > "$REPO/src/math.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

# ---------------------------------------------------------------------------
# 13. dependency POSITIVE
# ---------------------------------------------------------------------------
@test "dependency POSITIVE: package.json に dependencies 変更 -> class dependency を返す" {
    printf '{\n  "name": "app",\n  "dependencies": {\n    "lodash": "^4.17.21"\n  }\n}\n' \
        > "$REPO/package.json"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"dependency"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "dependency")] | length > 0'
}

# ---------------------------------------------------------------------------
# 14. dependency NEGATIVE
# ---------------------------------------------------------------------------
@test "dependency NEGATIVE: 無害な変更 -> 出力は []" {
    printf 'version = "1.0.0"\nauthor = "Alice"\n' > "$REPO/metadata.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

# ---------------------------------------------------------------------------
# 15a. EMPTY: 明らかに無害なファイルのみ変更 -> [] かつ exit 0
# ---------------------------------------------------------------------------
@test "EMPTY: 無害な変更のみ -> stdout が [] でかつ exit 0" {
    printf 'This is just a changelog entry.\n' > "$REPO/CHANGELOG.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

# ---------------------------------------------------------------------------
# 15b. MULTI-CLASS: 1 ファイルが auth と exec-sink の両クラスにヒット -> 2 オブジェクト
# ---------------------------------------------------------------------------
@test "MULTI-CLASS: auth と exec-sink の両方のマーカーを含むファイル -> 2 つの hit オブジェクトを返す" {
    mkdir -p "$REPO/src"
    # requireAuth (auth class) + eval( (exec-sink class) を同一ファイルに
    printf 'function requireAuth(user) { return eval(user.token); }\n' \
        > "$REPO/src/mixed.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "auth")] | length > 0'
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "exec-sink")] | length > 0'
    printf '%s\n' "$output" | jq -e 'length >= 2'
}

# ---------------------------------------------------------------------------
# NON-ASCII: 日本語ファイル名 × content-based クラス (public-api) の regression
# core.quotepath=false なしでは git diff --name-only が "src/\350..." と
# エスケープされ per-file diff が空になり false negative になる。
# ---------------------------------------------------------------------------
@test "NON-ASCII: 日本語ファイル名に export function -> class public-api を返す (core.quotepath regression)" {
    mkdir -p "$REPO/src"
    # 非 ASCII ファイル名（日本語）に public-api トリガーを追加
    printf 'export function 認証API(user) {\n  return user.id;\n}\n' \
        > "$REPO/src/認証api.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"public-api"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "public-api")] | length > 0'
    # file 値が壊れた escape シーケンスでないことを確認
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "public-api")][0].file | test("認証api\\.ts$")'
}

# ---------------------------------------------------------------------------
# SUBDIR-CWD: repo サブディレクトリを cwd にして content-based クラスが正しくヒットする
# (regression: per-file diff pathspec が cwd 相対で解釈されると subdir 実行時に
#  added が空になり content-based 6 クラスが silent false-negative になっていた)
# ---------------------------------------------------------------------------
@test "SUBDIR-CWD: repo subdir を cwd にして public-api (export function) が正しくヒットする" {
    mkdir -p "$REPO/src"
    printf 'export function getUser(id) {\n  return db.find(id);\n}\n' \
        > "$REPO/src/sub.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    # Run from a subdirectory of the repo, NOT the repo root
    run bash -c "cd '$REPO/src' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"public-api"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "public-api")] | length > 0'
}

# ---------------------------------------------------------------------------
# ERROR: 不正な base ref -> 非 0 exit
# ---------------------------------------------------------------------------
@test "ERROR: 不正な base ref (invalid-sha) -> 非 0 exit" {
    run bash -c "cd '$REPO' && '$SCRIPT' 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'"
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# ERROR: git repo 外で実行 -> 非 0 exit
# ---------------------------------------------------------------------------
@test "ERROR: git repo 外 (非 git ディレクトリ) で実行 -> 非 0 exit" {
    NON_GIT="$(mktemp -d)"
    run bash -c "cd '$NON_GIT' && '$SCRIPT' 'HEAD'"
    rm -rf "$NON_GIT"
    [ "$status" -ne 0 ]
}
