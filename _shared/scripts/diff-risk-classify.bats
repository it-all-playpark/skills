#!/usr/bin/env bats
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
    mkdir -p "$REPO/src"
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
    mkdir -p "$REPO/src"
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

# ---------------------------------------------------------------------------
# docs EXCLUSION: docs ファイルは security 語彙を含んでも HIT しない (issue #155)
# ---------------------------------------------------------------------------
@test "docs EXCLUSION: .md に auth/exec 語彙 -> 除外され [] (false-positive 防止)" {
    printf 'requireAuth と child_process と eval( を解説する docs\n' > "$REPO/AGENTS.md"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

@test "docs EXCLUSION: docs/ 配下の .txt に auth 語彙 -> 除外され []" {
    mkdir -p "$REPO/docs"
    printf 'authenticate jwt bearer session を説明\n' > "$REPO/docs/guide.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

@test "docs EXCLUSION regression: 同じ auth 語彙でも .ts は HIT のまま (非 docs は不変)" {
    mkdir -p "$REPO/src"
    printf 'function requireAuth(u) { return u.jwt; }\n' > "$REPO/src/x.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"auth"'* ]]
}

# ---------------------------------------------------------------------------
# [WT-1] working-tree POSITIVE: 未コミット (git add なし) の export function が hit する
# AC#1: --working-tree フラグが worktree の変更を三点 diff ではなく status ベースで分類する
# ---------------------------------------------------------------------------
@test "WT-1 working-tree POSITIVE: 未コミット export function -> class public-api / severity critical が hit" {
    mkdir -p "$REPO/src"
    printf 'export function getUser(id) {\n  return db.find(id);\n}\n' \
        > "$REPO/src/api.ts"
    # git add も commit もしない
    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"public-api"'* ]]
    [[ "$output" == *'"severity":"critical"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "public-api")] | length > 0'
}

# ---------------------------------------------------------------------------
# [WT-2] working-tree staged-only: git add のみ (commit なし) の auth が hit する
# ---------------------------------------------------------------------------
@test "WT-2 working-tree staged-only: git add した requireAuth -> class auth が hit" {
    mkdir -p "$REPO/src"
    printf 'function requireAuth(user) { return user.isAuthenticated; }\n' \
        > "$REPO/src/auth.ts"
    git -C "$REPO" add "$REPO/src/auth.ts"
    # commit はしない
    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"auth"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "auth")] | length > 0'
}

# ---------------------------------------------------------------------------
# [WT-3] working-tree untracked dir: 未追跡サブディレクトリのファイルが hit する
# porcelain -uall なしだと `?? newskill/` に折り畳まれ素通りする regression を pin
# ---------------------------------------------------------------------------
@test "WT-3 working-tree untracked dir: 未追跡サブディレクトリの export function -> class public-api が hit" {
    mkdir -p "$REPO/newskill/scripts"
    printf 'export function build(opts) {\n  return opts;\n}\n' \
        > "$REPO/newskill/scripts/gen.ts"
    # add も commit もしない
    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"public-api"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "public-api")] | length > 0'
}

# ---------------------------------------------------------------------------
# [WT-4] working-tree clean: 変更ゼロの worktree で --working-tree -> [] かつ exit 0
# ---------------------------------------------------------------------------
@test "WT-4 working-tree clean: 変更なし -> 出力 [] かつ exit 0" {
    # 何も変更しない
    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree '$BASE'"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

# ---------------------------------------------------------------------------
# [WT-5] working-tree BASE-ahead (merge-base pin):
# main に fork 後の commit (auth-helper.ts) を積み、feature branch では
# 無害な変更のみ。BASE=main HEAD を渡して --working-tree 実行 ->
# auth-helper が含まれない (merge-base を取らず git diff $BASE 直接比較だと
# 逆方向差分に混入する regression を pin)
# ---------------------------------------------------------------------------
@test "WT-5 working-tree BASE-ahead merge-base pin: main-ahead commit は --working-tree に混入しない" {
    # fork 点 = 現在の BASE (empty commit)
    FORK_SHA="$BASE"

    # main branch に auth-helper.ts を追加コミット
    mkdir -p "$REPO/other-pr"
    printf 'function authHelper(token) { return token; }\n' \
        > "$REPO/other-pr/auth-helper.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m "main: add auth-helper"
    MAIN_SHA="$(git -C "$REPO" rev-parse HEAD)"

    # feature branch を fork 点から切る
    git -C "$REPO" checkout -q -b feature "$FORK_SHA"

    # feature worktree に無害な未コミット変更のみ
    printf 'const x = 1;\n' > "$REPO/notes-internal.js"

    # BASE=MAIN_SHA で --working-tree 実行
    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree '$MAIN_SHA'"
    [ "$status" -eq 0 ]
    # auth-helper が含まれないこと
    printf '%s\n' "$output" | jq -e '[.[] | .file | test("auth-helper")] | any | not'
}

# ---------------------------------------------------------------------------
# [WT-6] default-mode 不変: --working-tree なしの通常モードは未コミット変更を無視する
# AC#2: 三点 diff の従来挙動が壊れていないことを pin
# ---------------------------------------------------------------------------
@test "WT-6 default-mode 不変: 未コミット export function のみ -> フラグなしでは []" {
    mkdir -p "$REPO/src"
    printf 'export function getUser(id) {\n  return db.find(id);\n}\n' \
        > "$REPO/src/api.ts"
    # git add も commit もしない
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

# ---------------------------------------------------------------------------
# [WT-7] working-tree NON-ASCII: 日本語ファイル名の未追跡ファイルが hit する
# core.quotepath=false on status の pin
# ---------------------------------------------------------------------------
@test "WT-7 working-tree NON-ASCII: 日本語ファイル名の未追跡 export function -> public-api hit, file 値が正しい" {
    mkdir -p "$REPO/src"
    printf 'export function 認証処理(user) {\n  return user.id;\n}\n' \
        > "$REPO/src/認証処理.ts"
    # add も commit もしない
    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"public-api"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "public-api")] | length > 0'
    # file 値が壊れたエスケープシーケンスでないことを確認
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "public-api")][0].file | test("認証処理\\.ts$")'
}

# ---------------------------------------------------------------------------
# [STALE-1] stale-base fetch: file:// remote で stale な origin/main を fetch で最新化し
# merged-auth が --working-tree 出力に含まれないことを pin (AC#7)
# ---------------------------------------------------------------------------
@test "STALE-1 stale-base fetch: fetch で origin/main を最新化 -> merged-auth は含まれない" {
    # origin となる bare-ish リポジトリを作成
    R="$(mktemp -d)"
    git -C "$R" init -q -b main
    git -C "$R" config user.email t@t
    git -C "$R" config user.name t
    git -C "$R" commit -q --allow-empty -m "init"
    COMMIT_A="$(git -C "$R" rev-parse HEAD)"

    # origin に merged-auth.ts を追加 (commit B)
    mkdir -p "$R/merged"
    printf 'function authHelper(token) { return token; }\n' > "$R/merged/merged-auth.ts"
    git -C "$R" add -A
    git -C "$R" commit -q -m "add merged-auth"
    COMMIT_B="$(git -C "$R" rev-parse HEAD)"

    # clone して feature branch を B から切る
    C="$(mktemp -d)"
    git clone -q "file://$R" "$C"
    git -C "$C" config user.email t@t
    git -C "$C" config user.name t
    git -C "$C" checkout -q -b feature origin/main  # fork 点 = B

    # origin/main を人工的に A に後退させ stale を作る
    git -C "$C" update-ref refs/remotes/origin/main "$COMMIT_A"

    # 無害な未コミット変更のみ
    printf 'const x = 1;\n' > "$C/harmless.js"

    # --working-tree origin/main で実行 (fetch が ref を B に戻し MB=B になる)
    run bash -c "cd '$C' && '$SCRIPT' --working-tree origin/main"
    [ "$status" -eq 0 ]
    # merged-auth が含まれないこと
    printf '%s\n' "$output" | jq -e '[.[] | .file | test("merged-auth")] | any | not'

    rm -rf "$R" "$C"
}

# ---------------------------------------------------------------------------
# [STALE-2] fetch 不能 fail-safe: remote 未設定リポジトリで origin/main ref だけ存在する場合
# fetch 失敗は警告のみで分類続行 -> exit 0 かつ public-api hit
# ---------------------------------------------------------------------------
@test "STALE-2 fetch 不能 fail-safe: fetch 失敗でも exit 0 かつ分類は続行" {
    # remote 未設定の隔離 repo (= $REPO) に origin/main ref を人工的に作成
    git -C "$REPO" update-ref refs/remotes/origin/main "$BASE"

    # 未コミットの export function を置く
    mkdir -p "$REPO/src"
    printf 'export function build(opts) {\n  return opts;\n}\n' \
        > "$REPO/src/build.ts"

    run bash -c "cd '$REPO' && '$SCRIPT' --working-tree origin/main"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "public-api")] | length > 0'
}

# ---------------------------------------------------------------------------
# [CRYPTO-1] boundary NEGATIVE: PATH_TRAVERSAL 定数 (rsa 部分一致 false positive の解消 pin)
# AC#5: crypto パターンから不要な rsa 部分一致が取り除かれていることを pin
# ---------------------------------------------------------------------------
@test "CRYPTO-1 boundary NEGATIVE: PATH_TRAVERSAL 定数 -> crypto は hit しない (rsa 部分一致 FP 解消 pin)" {
    mkdir -p "$REPO/src"
    printf 'const PATH_TRAVERSAL = "../";\n' > "$REPO/src/path.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [ "$output" = "[]" ]
}

# ---------------------------------------------------------------------------
# [CRYPTO-2] boundary POSITIVE: bare createHmac 呼び出し (crypto. prefix なし) が hit する
# 両側 boundary 化により createHmac regression が救済されることを pin
# ---------------------------------------------------------------------------
@test "CRYPTO-2 boundary POSITIVE: bare createHmac 呼び出し -> class crypto が hit" {
    mkdir -p "$REPO/src"
    printf 'const mac = createHmac("sha256", key);\n' > "$REPO/src/sign.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"crypto"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "crypto")] | length > 0'
}

# ---------------------------------------------------------------------------
# [CRYPTO-3] boundary POSITIVE: 単独トークン hmac が hit する
# ---------------------------------------------------------------------------
@test "CRYPTO-3 boundary POSITIVE: 単独トークン hmac -> class crypto が hit" {
    mkdir -p "$REPO/src"
    printf 'const sig = hmac(key, msg);\n' > "$REPO/src/token.js"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"crypto"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "crypto")] | length > 0'
}

# ---------------------------------------------------------------------------
# [LIB-1] _lib 緩和: _lib/ 配下の export function は public-api に hit しない
# AC#6: _lib パスは public-api クラスから除外されることを pin
# ---------------------------------------------------------------------------
@test "LIB-1 _lib 緩和: _lib/ 配下の export function -> public-api が含まれない" {
    mkdir -p "$REPO/_lib"
    printf 'export function makeSummary(data) {\n  return data.summary;\n}\n' \
        > "$REPO/_lib/devflow-summary-format.test.mjs"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "public-api")] | length == 0'
}

# ---------------------------------------------------------------------------
# [LIB-2] _lib 緩和の狭さ: _lib/ 配下でも exec-sink は hit する
# 緩和は public-api クラス限定であることを pin
# ---------------------------------------------------------------------------
@test "LIB-2 _lib 緩和の狭さ: _lib/ 配下の eval -> exec-sink は hit する (緩和は public-api 限定)" {
    mkdir -p "$REPO/_lib"
    printf 'function run(input) { return eval(input); }\n' \
        > "$REPO/_lib/runner.mjs"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"exec-sink"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "exec-sink")] | length > 0'
}

# ---------------------------------------------------------------------------
# [TOOLS-1] tools 緩和: tools/ 配下の export function は public-api に hit しない
# AC: tools/ は repo 内部の generator/dev CLI 置き場で外部 consumer 不在のため
#     public-api critical の構造的 false positive を除外する
# ---------------------------------------------------------------------------
@test "TOOLS-1 tools 緩和: tools/ 配下の export function -> public-api が含まれない" {
    mkdir -p "$REPO/tools"
    printf 'export function buildConfig(opts) {\n  return opts;\n}\n' \
        > "$REPO/tools/gen-config.mjs"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "public-api")] | length == 0'
}

# ---------------------------------------------------------------------------
# [TOOLS-2] tools 緩和の狭さ: tools/ 配下でも exec-sink は hit する
# 緩和は public-api クラス限定であることを pin
# ---------------------------------------------------------------------------
@test "TOOLS-2 tools 緩和の狭さ: tools/ 配下の child_process+spawn -> exec-sink は hit する (緩和は public-api 限定)" {
    mkdir -p "$REPO/tools"
    printf 'const { spawn } = require("child_process");\nspawn("ls");\n' \
        > "$REPO/tools/runner.mjs"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"class":"exec-sink"'* ]]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "exec-sink")] | length > 0'
}

# ---------------------------------------------------------------------------
# [TOOLS-3] tools 緩和の narrow ガード: mytools/ は除外されない
# (^|/)tools/ が mytools/ にはマッチしない = 除外が narrow であることを pin
# ---------------------------------------------------------------------------
@test "TOOLS-3 tools 緩和の narrow ガード: mytools/ 配下の export function -> public-api に hit する" {
    mkdir -p "$REPO/mytools"
    printf 'export function publicApi() {}\n' \
        > "$REPO/mytools/api.ts"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
    run bash -c "cd '$REPO' && '$SCRIPT' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '[.[] | select(.class == "public-api")] | length > 0'
}
