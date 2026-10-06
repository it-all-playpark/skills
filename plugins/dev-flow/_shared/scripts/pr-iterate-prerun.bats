#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for _shared/scripts/pr-iterate-prerun.sh (issue #828)
#
# pr-iterate-prerun は /pr-iterate 単体起動の isolation preflight（gh pr view → fetch → PR head 一致検証 →
# worktree 作成/再利用 → HEAD 合わせ → 書き込み probe → 書けない場合の repo 外退避）を 1 コマンドで行う。
# fixture は bare origin（main + PR head の feature/x）+ clone した ROOT。gh は stub する。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/pr-iterate-prerun.sh"

setup() {
    ORIGIN="$BATS_TEST_TMPDIR/origin.git"
    git init --bare -q "$ORIGIN"

    SEED="$BATS_TEST_TMPDIR/seed"
    git init -q -b main "$SEED"
    git -C "$SEED" config user.name "Test"
    git -C "$SEED" config user.email "test@example.com"
    echo "# seed" > "$SEED/README.md"
    git -C "$SEED" add README.md
    git -C "$SEED" commit -q -m "init"
    git -C "$SEED" checkout -q -b feature/x
    echo "pr" >> "$SEED/README.md"
    git -C "$SEED" add README.md
    git -C "$SEED" commit -q -m "pr commit"
    git -C "$SEED" remote add origin "$ORIGIN"
    git -C "$SEED" push -q origin main feature/x
    git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main

    ROOT="$BATS_TEST_TMPDIR/root"
    git clone -q "$ORIGIN" "$ROOT"
    git -C "$ROOT" config user.name "Test"
    git -C "$ROOT" config user.email "test@example.com"
    # git worktree list --porcelain は物理パスを返す（macOS の /var → /private/var）
    ROOT_P="$(cd "$ROOT" && pwd -P)"
    HEAD_SHA="$(git -C "$SEED" rev-parse feature/x)"

    STUB_DIR="$BATS_TEST_TMPDIR/stub-bin"
    mkdir -p "$STUB_DIR"
    cat >"$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_STUB_LOG"
if [[ -n "${GH_STUB_FAIL:-}" ]]; then
    echo "gh stub: HTTP 404" >&2
    exit 1
fi
cat "$GH_STUB_FIXTURE"
STUB
    chmod +x "$STUB_DIR/gh"
    export PATH="$STUB_DIR:$PATH"
    export GH_STUB_LOG="$BATS_TEST_TMPDIR/gh.log"
    export GH_STUB_FIXTURE="$BATS_TEST_TMPDIR/pr.json"
    unset GH_STUB_FAIL
    write_pr_fixture "$HEAD_SHA"
}

write_pr_fixture() {
    jq -n --arg oid "$1" \
        '{url: "https://github.com/acme/skills/pull/5", headRefName: "feature/x", baseRefName: "main", headRefOid: $oid}' \
        >"$GH_STUB_FIXTURE"
}

# origin の feature/x を 1 commit 進め、PR head（fixture）もそれに合わせる
advance_origin_head() {
    git -C "$SEED" checkout -q feature/x
    echo "more" >> "$SEED/README.md"
    git -C "$SEED" commit -q -am "advance"
    git -C "$SEED" push -q origin feature/x
    HEAD_SHA="$(git -C "$SEED" rev-parse feature/x)"
    write_pr_fixture "$HEAD_SHA"
}

# ---- (1) 新規作成 ----

@test "(1) worktree が無い -> origin の head から既定候補 .claude/worktrees/pr-<N> に作成し JSON 1 行を出す" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 1 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.worktree_status == "created" and .worktree_removed == false'
    echo "$output" | jq -e --arg wt "$ROOT_P/.claude/worktrees/pr-5" '.worktree == $wt'
    echo "$output" | jq -e '.head_ref == "feature/x" and .base_ref == "main" and .repo == "acme/skills" and .pr == 5'
    echo "$output" | jq -e --arg h "$HEAD_SHA" '.head_sha == $h'
    echo "$output" | jq -e '(.epoch | type) == "number" and (.epoch == (.epoch | floor))'
    echo "$output" | jq -e 'has("error") == false'
    wt="$(echo "$output" | jq -r '.worktree')"
    [ "$(git -C "$wt" rev-parse HEAD)" = "$HEAD_SHA" ]
    [ "$(git -C "$wt" rev-parse --abbrev-ref HEAD)" = "feature/x" ]
    [ "$(git -C "$wt" rev-parse --abbrev-ref '@{u}')" = "origin/feature/x" ]
    grep -qx "pr view 5 --json url,headRefName,baseRefName,headRefOid" "$GH_STUB_LOG"
}

@test "(1b) --repo を gh pr view に渡し、出力の repo はその値" {
    cd "$ROOT"
    run bash "$SCRIPT" 5 --repo other/name
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .repo == "other/name"'
    grep -qx "pr view 5 --repo other/name --json url,headRefName,baseRefName,headRefOid" "$GH_STUB_LOG"
}

# ---- (2) 再利用 ----

@test "(2) head branch を checkout 済みの worktree（dev-flow の df-<N> 等）があれば候補パスより優先して再利用する" {
    cd "$ROOT"
    DF="$BATS_TEST_TMPDIR/wt/df-1"
    git worktree add -q --track -b feature/x "$DF" origin/feature/x
    DF_P="$(cd "$DF" && pwd -P)"

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "reused"'
    echo "$output" | jq -e --arg wt "$DF_P" '.worktree == $wt'
    echo "$output" | jq -e --arg h "$HEAD_SHA" '.head_sha == $h'
    [ ! -e "$ROOT/.claude/worktrees/pr-5" ]
}

@test "(2b) 同じ PR で 2 回目 -> 1 回目に作った worktree を reused で返し、epoch は新しく採る" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    first_wt="$(echo "$output" | jq -r '.worktree')"

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "reused"'
    echo "$output" | jq -e --arg wt "$first_wt" '.worktree == $wt'
}

@test "(2c) 再利用 worktree が PR head より遅れていて未コミット変更なし -> PR head へ fast-forward する" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    wt="$(echo "$output" | jq -r '.worktree')"
    advance_origin_head

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "reused"'
    echo "$output" | jq -e --arg h "$HEAD_SHA" '.head_sha == $h'
    [ "$(git -C "$wt" rev-parse HEAD)" = "$HEAD_SHA" ]
}

@test "(2d) 前 run の isolation probe 残置物だけを除去し、.devflow-tmp の他のファイルは残す" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    wt="$(echo "$output" | jq -r '.worktree')"
    mkdir -p "$wt/.devflow-tmp"
    echo ok > "$wt/.devflow-tmp/.isolation-probe-111"
    echo body > "$wt/.devflow-tmp/pr-body.md"

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    [ ! -e "$wt/.devflow-tmp/.isolation-probe-111" ]
    [ -f "$wt/.devflow-tmp/pr-body.md" ]
}

# ---- (3) head の不一致 ----

@test "(3) origin の head が PR の headRefOid と一致しない -> ok:false、worktree を作らない" {
    write_pr_fixture "0123456789abcdef0123456789abcdef01234567"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.error | test("PR head 不一致")'
    echo "$output" | jq -e '.worktree == null'
    [ ! -e "$ROOT/.claude/worktrees/pr-5" ]
}

@test "(3b) 再利用 worktree に PR head に無い未 push のコミット -> ok:false、HEAD を動かさない" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    wt="$(echo "$output" | jq -r '.worktree')"
    echo "local" >> "$wt/README.md"
    git -C "$wt" commit -q -am "local only"
    local_head="$(git -C "$wt" rev-parse HEAD)"

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .worktree_status == "reused"'
    echo "$output" | jq -e '.error | test("PR head（.*）に無いコミット")'
    [ "$(git -C "$wt" rev-parse HEAD)" = "$local_head" ]
}

@test "(3c) 再利用 worktree が遅れていて未コミット変更あり -> ok:false、fast-forward しない" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    wt="$(echo "$output" | jq -r '.worktree')"
    old_head="$(git -C "$wt" rev-parse HEAD)"
    echo "wip" > "$wt/wip.txt"
    advance_origin_head

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.error | test("未コミット変更")'
    [ "$(git -C "$wt" rev-parse HEAD)" = "$old_head" ]
}

@test "(3d) PR head と一致する再利用 worktree の未コミット変更は残したまま ok:true（fix_failed 回収）" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    wt="$(echo "$output" | jq -r '.worktree')"
    echo "wip" > "$wt/wip.txt"

    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "reused"'
    [ -f "$wt/wip.txt" ]
}

@test "(3e) origin に head branch が無い（fork の PR 等） -> ok:false" {
    jq -n '{url: "https://github.com/acme/skills/pull/5", headRefName: "fork-only", baseRefName: "main", headRefOid: "0123456789abcdef0123456789abcdef01234567"}' >"$GH_STUB_FIXTURE"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .head_ref == "fork-only"'
    echo "$output" | jq -e '.error | test("origin に PR の head branch fork-only が無い")'
}

# ---- (4) 書き込めない場合の退避 ----

@test "(4) 既定候補に作った worktree が書けない -> remove して repo 外 <repo>-wt/pr-<N> に作り直す" {
    # post-checkout hook で repo 内 worktree の .devflow-tmp だけを書き込み不可にする（skills repo の EPERM の再現）
    HOOKS="$BATS_TEST_TMPDIR/hooks"
    mkdir -p "$HOOKS"
    cat >"$HOOKS/post-checkout" <<'HOOK'
#!/usr/bin/env bash
case "$PWD" in
    */.claude/worktrees/*) mkdir -p .devflow-tmp && chmod a-w .devflow-tmp ;;
esac
HOOK
    chmod +x "$HOOKS/post-checkout"
    git -C "$ROOT" config core.hooksPath "$HOOKS"

    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .worktree_status == "created" and .worktree_removed == true'
    echo "$output" | jq -e --arg wt "$ROOT_P-wt/pr-5" '.worktree == $wt'
    echo "$output" | jq -e --arg h "$HEAD_SHA" '.head_sha == $h'
    [ ! -e "$ROOT/.claude/worktrees/pr-5" ]
    [ "$(git -C "$ROOT_P-wt/pr-5" rev-parse HEAD)" = "$HEAD_SHA" ]
    run git -C "$ROOT" worktree list --porcelain
    [[ "$output" != *"/.claude/worktrees/pr-5"* ]]
}

@test "(4b) 再利用 worktree が書けない -> 退避せず ok:false、worktree_status=unwritable、worktree_removed=false" {
    cd "$ROOT"
    run bash "$SCRIPT" 5
    wt="$(echo "$output" | jq -r '.worktree')"
    rm -rf "$wt/.devflow-tmp"
    chmod a-w "$wt"

    run bash "$SCRIPT" 5
    status_after="$status"
    output_after="$output"
    chmod u+w "$wt"

    [ "$status_after" -eq 0 ]
    echo "$output_after" | jq -e '.ok == false and .worktree_status == "unwritable" and .worktree_removed == false'
    echo "$output_after" | jq -e '.error | ascii_downcase | test("permission|not permitted")'
    echo "$output_after" | jq -e '.error | test("git worktree remove")'
    [ ! -e "$ROOT/../root-wt/pr-5" ]
}

@test "(4c) 既定候補が存在すれば（repo 外候補より）それを使う — 未登録ディレクトリなら ok:false" {
    mkdir -p "$ROOT/.claude/worktrees/pr-5"
    mkdir -p "$ROOT-wt/pr-5"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .worktree_status == "error"'
    echo "$output" | jq -e --arg wt "$ROOT_P/.claude/worktrees/pr-5" '.worktree == $wt'
    echo "$output" | jq -e '.error | test("not a registered git worktree")'
}

@test "(4d) 既定候補が無く repo 外候補が存在すればそれを使う" {
    mkdir -p "$ROOT-wt/pr-5"
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --arg wt "$ROOT_P-wt/pr-5" '.worktree == $wt'
}

# ---- (5) その他の fail-closed ----

@test "(5a) gh pr view が失敗 -> ok:false、error に gh の出力" {
    export GH_STUB_FAIL=1
    cd "$ROOT"
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and .worktree_status == "skipped"'
    echo "$output" | jq -e '.error | test("HTTP 404")'
}

@test "(5b) head branch が main checkout で checkout 済み -> ok:false（main checkout を worktree として返さない）" {
    cd "$ROOT"
    git checkout -q -b feature/x origin/feature/x
    run bash "$SCRIPT" 5
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.error | test("main checkout")'
}

@test "(5c) 引数不正 -> exit 2、stdout 空" {
    cd "$ROOT"
    run --separate-stderr bash "$SCRIPT"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    run --separate-stderr bash "$SCRIPT" abc
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    run --separate-stderr bash "$SCRIPT" 5 --repo 'not a repo'
    [ "$status" -eq 2 ]
    [ -z "$output" ]
    run --separate-stderr bash "$SCRIPT" 5 --unknown
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

# ---- (6) 静的 pin ----

@test "(6a) 静的pin: push しない・gh は pr view のみ" {
    run grep -E 'git (-C [^ ]+ )?push' "$SCRIPT"
    [ "$status" -ne 0 ]
    run grep -E '(^|[^A-Za-z0-9_-])gh (issue|api|pr (comment|edit|merge|create|close))' "$SCRIPT"
    [ "$status" -ne 0 ]
}
