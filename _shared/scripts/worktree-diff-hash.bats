#!/usr/bin/env bats
# Tests for _shared/scripts/worktree-diff-hash.sh
#
# Strategy: mktemp -d で隔離 git repo + worktree を作成し、各ケースのシナリオで
# スクリプトの出力を検証する。

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/worktree-diff-hash.sh"

    # ベースとなる bare-ish repo をセットアップ
    REPO="$(mktemp -d)"
    git -C "$REPO" init -q
    git -C "$REPO" config user.email t@t
    git -C "$REPO" config user.name t
    # 初期ファイルを作成して base commit
    printf 'hello\n' > "$REPO/file.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m base
    # 実際のコミットハッシュを保存（symbolic ref を使わないことで
    # worktree の ahead commit 後も base commit を一意に参照できる）
    BASE_REF="$(git -C "$REPO" rev-parse HEAD)"

    # worktree を別ディレクトリに追加
    WT="$(mktemp -d)"
    rm -rf "$WT"
    git -C "$REPO" worktree add -q "$WT"
}

teardown() {
    # worktree を削除してから repo を削除
    git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || true
    rm -rf "$REPO"
    rm -rf "$WT"
}

# ---------------------------------------------------------------------------
# 1. base と内容一致の clean worktree -> empty:true
# ---------------------------------------------------------------------------
@test "clean worktree (no changes) -> empty:true" {
    run bash "$SCRIPT" "$WT" "$BASE_REF"
    [ "$status" -eq 0 ]
    # JSON 1 行であること
    [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 1 ]
    # empty:true
    printf '%s\n' "$output" | grep -q '"empty":true'
    # hash フィールドが存在すること
    printf '%s\n' "$output" | grep -q '"hash":'
}

# ---------------------------------------------------------------------------
# 2. 未ステージ変更あり -> empty:false かつ hash が clean 時と異なる
# ---------------------------------------------------------------------------
@test "unstaged modification -> empty:false and different hash from clean" {
    # clean 時の hash を取得
    clean_out=$(bash "$SCRIPT" "$WT" "$BASE_REF")
    clean_hash=$(printf '%s\n' "$clean_out" | grep -o '"hash":"[^"]*"' | cut -d'"' -f4)

    # unstaged 変更を加える
    printf 'modified content\n' > "$WT/file.txt"

    run bash "$SCRIPT" "$WT" "$BASE_REF"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q '"empty":false'

    dirty_hash=$(printf '%s\n' "$output" | grep -o '"hash":"[^"]*"' | cut -d'"' -f4)
    [ "$clean_hash" \!= "$dirty_hash" ]
}

# ---------------------------------------------------------------------------
# 3. staged-only 変更（git add のみで commit なし）-> empty:false
# ---------------------------------------------------------------------------
@test "staged-only change (git add, no commit) -> empty:false" {
    printf 'staged content\n' > "$WT/file.txt"
    git -C "$WT" add file.txt

    run bash "$SCRIPT" "$WT" "$BASE_REF"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q '"empty":false'
}

# ---------------------------------------------------------------------------
# 4. untracked ファイルのみ追加 -> empty:false
# ---------------------------------------------------------------------------
@test "untracked file added -> empty:false" {
    printf 'new file\n' > "$WT/new-file.txt"

    run bash "$SCRIPT" "$WT" "$BASE_REF"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q '"empty":false'
}

# ---------------------------------------------------------------------------
# 5. 同一状態で 2 回実行 -> 同一 hash（決定論性）
# ---------------------------------------------------------------------------
@test "determinism: same state produces same hash" {
    # 変更を加えた状態で 2 回実行
    printf 'some change\n' >> "$WT/file.txt"

    out1=$(bash "$SCRIPT" "$WT" "$BASE_REF")
    out2=$(bash "$SCRIPT" "$WT" "$BASE_REF")

    hash1=$(printf '%s\n' "$out1" | grep -o '"hash":"[^"]*"' | cut -d'"' -f4)
    hash2=$(printf '%s\n' "$out2" | grep -o '"hash":"[^"]*"' | cut -d'"' -f4)

    [ "$hash1" = "$hash2" ]
    [ -n "$hash1" ]
}

# ---------------------------------------------------------------------------
# 6. 実行前後で git status --porcelain の出力が不変（実 index 非破壊）
# ---------------------------------------------------------------------------
@test "real index is not modified (porcelain unchanged)" {
    # staged 変更と unstaged 変更の両方がある状態を作る
    printf 'staged\n' > "$WT/staged.txt"
    git -C "$WT" add staged.txt
    printf 'unstaged\n' > "$WT/file.txt"

    # スクリプト実行前の git status
    before=$(git -C "$WT" status --porcelain)

    bash "$SCRIPT" "$WT" "$BASE_REF" >/dev/null

    # スクリプト実行後の git status
    after=$(git -C "$WT" status --porcelain)

    [ "$before" = "$after" ]
}

# ---------------------------------------------------------------------------
# 7. 引数不足 -> exit 非 0
# ---------------------------------------------------------------------------
@test "missing arguments -> non-zero exit" {
    run bash "$SCRIPT"
    [ "$status" -ne 0 ]
}

@test "missing base-ref argument -> non-zero exit" {
    run bash "$SCRIPT" "$WT"
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# 8. base より先の commit が存在する worktree -> empty:false
# ---------------------------------------------------------------------------
@test "worktree has commit ahead of base -> empty:false" {
    # BASE_REF は setup で保存した実際のコミットハッシュなので、
    # worktree に追加 commit を作っても base を正しく参照できる
    printf 'committed change\n' > "$WT/file.txt"
    git -C "$WT" add file.txt
    git -C "$WT" commit -q -m "ahead commit"

    run bash "$SCRIPT" "$WT" "$BASE_REF"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q '"empty":false'
}
