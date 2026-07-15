#!/usr/bin/env bats
# Tests for _shared/scripts/structural-classify.sh (issue #350, F1)
#
# Strategy: mktemp -d で隔離 git repo(worktree 相当) を作成し、fake difft stub を PATH の
# 先頭に置いて決定論的に判定を制御する。stub は difft の実際の引数順序
# (`difft [flags...] OLD-PATH NEW-PATH`) に合わせ、最後の引数(= new 側ファイル)の内容に
# FORMAT_ONLY マーカーがあれば exit 0 (フォーマットのみ)、なければ exit 1 (構造変化) を返す。
#
# NOTE on <base-ref>: the script diffs merge-base(HEAD, base-ref) against the working
# tree (a two-TREE comparison, not a commit-by-commit walk). For a status-"M" case, the
# file must already exist AT the base-ref commit -- so each M-status test captures its
# own local base ref (`base_ref`) right after committing the pre-change content, then
# commits the post-change content and passes `base_ref` (not the repo-wide empty $BASE)
# to the script. The same applies to the delete (D) case: if a file is both added and
# removed strictly AFTER the repo-wide $BASE, the two-tree diff against $BASE shows no
# change at all (absent at both endpoints).
#
# NOTE: 実装されるまでこれらのテストは fail (red) になる想定 (TDD)。

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/_shared/scripts/structural-classify.sh"

    REPO="$(mktemp -d)"
    git -C "$REPO" init -q
    git -C "$REPO" config user.email t@t
    git -C "$REPO" config user.name t
    git -C "$REPO" commit -q --allow-empty -m base
    BASE="$(git -C "$REPO" rev-parse HEAD)"

    # PATH に fake difft stub を差し込むためのディレクトリ (デフォルトでは空 = difft 不在)
    FAKE_BIN="$(mktemp -d)"
    ORIG_PATH="$PATH"
}

teardown() {
    rm -rf "$REPO" "$FAKE_BIN"
    PATH="$ORIG_PATH"
}

# stub は最後の引数 (difft の NEW-PATH) の内容で分岐する決定論 fake difft。
install_fake_difft() {
    cat > "$FAKE_BIN/difft" <<'STUB'
#!/usr/bin/env bash
# fake difft: last positional arg is the NEW-PATH (real difft's arg order is
# `difft [flags...] OLD-PATH NEW-PATH`), so grabbing the last arg is robust
# regardless of how many leading flags are passed.
new="${@: -1}"
if grep -q 'FORMAT_ONLY' "$new" 2>/dev/null; then
    exit 0
else
    exit 1
fi
STUB
    chmod +x "$FAKE_BIN/difft"
    PATH="$FAKE_BIN:$ORIG_PATH"
}

commit_all() {
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m change
}

run_classify() {
    local base_ref="$1"
    run bash -c "PATH='$FAKE_BIN:$ORIG_PATH' bash '$SCRIPT' '$REPO' '$base_ref'"
}

# ---------------------------------------------------------------------------
# 1. difft not installed -> available:false fallback, ok:true, exit 0
# ---------------------------------------------------------------------------
@test "difft 未インストール -> available:false の fallback JSON を返し exit 0" {
    printf 'x\n' > "$REPO/a.txt"
    commit_all
    # NOTE: no install_fake_difft call -- FAKE_BIN stays empty, PATH stays default.
    run bash -c "PATH='$FAKE_BIN:$ORIG_PATH' bash '$SCRIPT' '$REPO' '$BASE'"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and .available == false and .structural == [] and .format_only == [] and .reason == "difft_not_installed"'
}

# ---------------------------------------------------------------------------
# 2. Modified file, stub reports FORMAT_ONLY -> format_only
# ---------------------------------------------------------------------------
@test "M ファイル + difft exit 0 -> format_only に分類される" {
    install_fake_difft
    printf 'line one\n' > "$REPO/src.txt"
    commit_all
    base_ref="$(git -C "$REPO" rev-parse HEAD)"
    printf 'line one changed FORMAT_ONLY\n' > "$REPO/src.txt"
    commit_all
    run_classify "$base_ref"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and .available == true and (.format_only | index("src.txt")) != null and (.structural | index("src.txt")) == null'
}

# ---------------------------------------------------------------------------
# 3. Modified file, stub reports structural (no marker) -> structural
# ---------------------------------------------------------------------------
@test "M ファイル + difft exit 1 -> structural に分類される" {
    install_fake_difft
    printf 'line one\n' > "$REPO/src2.txt"
    commit_all
    base_ref="$(git -C "$REPO" rev-parse HEAD)"
    printf 'line one totally different logic\n' > "$REPO/src2.txt"
    commit_all
    run_classify "$base_ref"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and (.structural | index("src2.txt")) != null and (.format_only | index("src2.txt")) == null'
}

# ---------------------------------------------------------------------------
# 4. Untracked new file -> structural
# ---------------------------------------------------------------------------
@test "untracked 新規ファイル -> structural に分類される" {
    install_fake_difft
    printf 'existing\n' > "$REPO/base.txt"
    commit_all
    printf 'new stuff\n' > "$REPO/new-untracked.txt"
    run_classify "$BASE"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '(.structural | index("new-untracked.txt")) != null and (.format_only | index("new-untracked.txt")) == null'
}

# ---------------------------------------------------------------------------
# 5. Deleted file (D) -> structural
# ---------------------------------------------------------------------------
@test "削除ファイル(D) -> structural に分類される" {
    install_fake_difft
    printf 'to be deleted\n' > "$REPO/gone.txt"
    commit_all
    base_ref="$(git -C "$REPO" rev-parse HEAD)"
    rm "$REPO/gone.txt"
    commit_all
    run_classify "$base_ref"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '(.structural | index("gone.txt")) != null and (.format_only | index("gone.txt")) == null'
}

# ---------------------------------------------------------------------------
# 6. git mv (rename) -> old + new paths both structural, parsing not desynced
# ---------------------------------------------------------------------------
@test "git mv による rename -> old/new 両パスが structural、後続パースが崩れない" {
    install_fake_difft
    printf 'renamed content\n' > "$REPO/old-name.txt"
    printf 'sentinel content unchanged\n' > "$REPO/sentinel.txt"
    commit_all
    base_ref="$(git -C "$REPO" rev-parse HEAD)"
    git -C "$REPO" mv old-name.txt new-name.txt
    printf 'sentinel content unchanged FORMAT_ONLY\n' > "$REPO/sentinel.txt"
    commit_all
    run_classify "$base_ref"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        (.structural | index("old-name.txt")) != null and
        (.structural | index("new-name.txt")) != null and
        (.format_only | index("sentinel.txt")) != null
    '
}

# ---------------------------------------------------------------------------
# 7. Same-basename M files in different dirs classified independently
# ---------------------------------------------------------------------------
@test "同名 basename の M ファイル 2 件 (a/foo.js FORMAT_ONLY, b/foo.js structural) が独立に分類される" {
    install_fake_difft
    mkdir -p "$REPO/a" "$REPO/b"
    printf 'shared content\n' > "$REPO/a/foo.js"
    printf 'shared content\n' > "$REPO/b/foo.js"
    commit_all
    base_ref="$(git -C "$REPO" rev-parse HEAD)"
    printf 'shared content FORMAT_ONLY\n' > "$REPO/a/foo.js"
    printf 'shared content but real logic change\n' > "$REPO/b/foo.js"
    commit_all
    run_classify "$base_ref"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '
        (.format_only | index("a/foo.js")) != null and
        (.structural | index("a/foo.js")) == null and
        (.structural | index("b/foo.js")) != null and
        (.format_only | index("b/foo.js")) == null
    '
}

# ---------------------------------------------------------------------------
# 8. Path containing spaces -> -z parsing and JSON escaping correct
# ---------------------------------------------------------------------------
@test "空白を含むパス -> -z パースと JSON escape が正しい" {
    install_fake_difft
    mkdir -p "$REPO/dir with space"
    printf 'orig\n' > "$REPO/dir with space/file name.txt"
    commit_all
    base_ref="$(git -C "$REPO" rev-parse HEAD)"
    printf 'orig totally rewritten\n' > "$REPO/dir with space/file name.txt"
    commit_all
    run_classify "$base_ref"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '(.structural | index("dir with space/file name.txt")) != null'
}

# ---------------------------------------------------------------------------
# 9. No changes -> both arrays empty
# ---------------------------------------------------------------------------
@test "変更ゼロ -> structural / format_only とも空配列" {
    install_fake_difft
    run_classify "$BASE"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e '.ok == true and .available == true and .structural == [] and .format_only == []'
}
