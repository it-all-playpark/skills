#!/usr/bin/env bats
# Tests for _shared/scripts/conflict-autoresolve.sh（issue #916）
#
# Strategy: mktemp -d に fixture repo を作り、main（base 側）と pr（PR 側）に別々の変更を積んで、pr を checkout した
# 状態から `--base-ref main` で merge させる。型 A / 型 B は merge commit（2 親）ができること、それ以外は
# git merge --abort で HEAD・作業ツリーが merge 前と一致することを確かめる。

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/conflict-autoresolve.sh"
    REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../../../.." && pwd)"
    R="$(mktemp -d)"
    git -C "$R" init -q -b main
    git -C "$R" config user.email t@t
    git -C "$R" config user.name t
    git -C "$R" config commit.gpgsign false
    git -C "$R" config core.hooksPath /dev/null
}

teardown() {
    rm -rf "$R"
}

commit_all() {
    git -C "$R" add -A
    git -C "$R" commit -q -m "$1"
}

# base commit の後に pr branch を切り、pr → main の順に $1 / $2 の関数で変更を積んで pr を checkout する
diverge() {
    git -C "$R" branch pr
    git -C "$R" checkout -q pr
    "$1"
    commit_all pr-change
    git -C "$R" checkout -q main
    "$2"
    commit_all base-change
    git -C "$R" checkout -q pr
}

run_script() {
    run bash "$SCRIPT" --worktree "$R" --base-ref main
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq -e . >/dev/null
}

field() { printf '%s\n' "$output" | jq -r "$1"; }

# 自動解消しなかったときの共通検証: merge 前の HEAD・作業ツリーに戻り、merge 途中の状態が残らない
assert_restored() {
    local before="$1"
    [ "$(field .status)" = "aborted" ]
    [ "$(field .restored)" = "true" ]
    [ "$(git -C "$R" rev-parse HEAD)" = "$before" ]
    [ "$(field .head_after)" = "$before" ]
    [ -z "$(git -C "$R" status --porcelain)" ]
    ! git -C "$R" rev-parse -q --verify MERGE_HEAD
}

assert_merge_commit() {
    local before="$1"
    [ "$(field .status)" = "resolved" ]
    [ "$(git -C "$R" rev-parse HEAD)" = "$(field .head_after)" ]
    [ "$(git -C "$R" rev-parse HEAD^1)" = "$before" ]
    [ "$(git -C "$R" rev-parse HEAD^2)" = "$(git -C "$R" rev-parse main)" ]
    [ -z "$(git -C "$R" status --porcelain)" ]
}

# ---- 型 A ----
readme_base() { printf '| k | v |\n|---|---|\n| a | 1 |\n' > "$R/README.md"; }
readme_pr_add() { printf '| pr | 2 |\n' >> "$R/README.md"; }
readme_base_add() { printf '| base | 3 |\n' >> "$R/README.md"; }

@test "型 A: 両側が同じ位置に行を足しただけの衝突は PR 側 → base 側の和集合で merge commit を作る" {
    readme_base
    commit_all base
    diverge readme_pr_add readme_base_add
    before="$(git -C "$R" rev-parse HEAD)"

    run_script
    assert_merge_commit "$before"
    [ "$(field '.files | length')" -eq 1 ]
    [ "$(field '.files[0].path')" = "README.md" ]
    [ "$(field '.files[0].type')" = "A" ]
    [ "$(cat "$R/README.md")" = "$(printf '| k | v |\n|---|---|\n| a | 1 |\n| pr | 2 |\n| base | 3 |')" ]
    ! grep -q '^<<<<<<<\|^=======\|^>>>>>>>' "$R/README.md"
}

# ---- 型 A 以外: 同じ行を両側が書き換えた ----
readme_pr_rewrite() { printf '| k | v |\n|---|---|\n| a | PR |\n' > "$R/README.md"; }
readme_base_rewrite() { printf '| k | v |\n|---|---|\n| a | BASE |\n' > "$R/README.md"; }

@test "同じ行を両側が書き換えた衝突は自動解消せず git merge --abort し、HEAD・作業ツリーが merge 前と一致する" {
    readme_base
    commit_all base
    diverge readme_pr_rewrite readme_base_rewrite
    before="$(git -C "$R" rev-parse HEAD)"

    run_script
    assert_restored "$before"
    [ "$(field .reason)" = "unsupported_conflict" ]
    [ "$(field '.files[0].type')" = "content" ]
    [ "$(cat "$R/README.md")" = "$(printf '| k | v |\n|---|---|\n| a | PR |')" ]
}

# ---- 型 A と非 A / B の混在 ----
mixed_pr() { readme_pr_add; printf 'PR\n' > "$R/other.txt"; }
mixed_base() { readme_base_add; printf 'BASE\n' > "$R/other.txt"; }

@test "型 A のファイルと非 A / B のファイルが混在する場合は、型 A のファイルも含めて全体を自動解消しない" {
    readme_base
    printf 'orig\n' > "$R/other.txt"
    commit_all base
    diverge mixed_pr mixed_base
    before="$(git -C "$R" rev-parse HEAD)"

    run_script
    assert_restored "$before"
    [ "$(field '.files[] | select(.path == "README.md") | .type')" = "A" ]
    [ "$(field '.files[] | select(.path == "other.txt") | .type')" = "content" ]
    [ "$(cat "$R/README.md")" = "$(printf '| k | v |\n|---|---|\n| a | 1 |\n| pr | 2 |')" ]
}

# ---- lockfile ----
lock_pr_add() { printf 'pr-dep@1:\n  version "1"\n' >> "$R/yarn.lock"; }
lock_base_add() { printf 'base-dep@2:\n  version "2"\n' >> "$R/yarn.lock"; }

@test "lockfile の衝突は両側が行を足しただけ（型 A の形）でも自動解消しない" {
    printf '# yarn lockfile v1\n' > "$R/yarn.lock"
    commit_all base
    diverge lock_pr_add lock_base_add
    before="$(git -C "$R" rev-parse HEAD)"

    run_script
    assert_restored "$before"
    [ "$(field '.files[0].path')" = "yarn.lock" ]
    [ "$(field '.files[0].type')" = "lockfile" ]
}

# ---- 型 B: inline 生成区間 ----
# canonical の 2 つの宣言はコメント行で隔てて置く。生成区間ではコメントが落ちて 2 行が隣接するので、canonical は
# 自動 merge できても生成区間は衝突する（skills#772 と同じ形）。
inline_base() {
    mkdir -p "$R/tools" "$R/p/_lib" "$R/p/.claude/workflows"
    cp "$REPO_ROOT/tools/sync-inlines.mjs" "$R/tools/sync-inlines.mjs"
    printf 'export const X = 1;\n// X と Y を隔てるコメント\nexport const Y = 2;\n' > "$R/p/_lib/a.mjs"
    printf 'const before = 0;\n// ==== BEGIN inline: _lib/a.mjs (生成区間) ====\n// ==== END inline: _lib/a.mjs ====\nconst after = X + Y;\n' > "$R/p/.claude/workflows/w.js"
    node "$R/tools/sync-inlines.mjs" --write --root "$R/p" >/dev/null
}
regen() { node "$R/tools/sync-inlines.mjs" --write --root "$R/p" >/dev/null; }
inline_pr_x() { sed -i.bak 's/^export const X = 1;/export const X = 10;/' "$R/p/_lib/a.mjs"; rm "$R/p/_lib/a.mjs.bak"; regen; }
inline_base_y() { sed -i.bak 's/^export const Y = 2;/export const Y = 20;/' "$R/p/_lib/a.mjs"; rm "$R/p/_lib/a.mjs.bak"; regen; }
inline_base_x() { sed -i.bak 's/^export const X = 1;/export const X = 11;/' "$R/p/_lib/a.mjs"; rm "$R/p/_lib/a.mjs.bak"; regen; }

@test "型 B: inline 生成区間だけが衝突し canonical が自動 merge できるとき、再生成して sync-inlines --check が通る merge commit を作る" {
    inline_base
    commit_all base
    diverge inline_pr_x inline_base_y
    before="$(git -C "$R" rev-parse HEAD)"

    run_script
    assert_merge_commit "$before"
    [ "$(field '.files | length')" -eq 1 ]
    [ "$(field '.files[0].path')" = "p/.claude/workflows/w.js" ]
    [ "$(field '.files[0].type')" = "B" ]
    run node "$R/tools/sync-inlines.mjs" --check --root "$R/p"
    [ "$status" -eq 0 ]
    grep -qx 'const X = 10;' "$R/p/.claude/workflows/w.js"
    grep -qx 'const Y = 20;' "$R/p/.claude/workflows/w.js"
}

@test "型 B の形でも canonical 自体が衝突していれば自動解消しない" {
    inline_base
    commit_all base
    diverge inline_pr_x inline_base_x
    before="$(git -C "$R" rev-parse HEAD)"

    run_script
    assert_restored "$before"
    [ "$(field '.files[] | select(.path == "p/_lib/a.mjs") | .type')" = "content" ]
    [ "$(field '.files[] | select(.path == "p/.claude/workflows/w.js") | .type')" = "canonical_conflict" ]
}
