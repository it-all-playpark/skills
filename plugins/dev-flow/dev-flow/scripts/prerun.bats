#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for dev-flow/scripts/prerun.sh (issue #641)
#
# prerun.sh は dev-flow Setup phase の決定論処理 (base 解決 / worktree 作成・再利用+起点検証+
# 書き込み probe / .devflow-tmp の git clean / deps install / detect-stack) を 1 コマンドに
# 集約する。fixture は bare origin + clone した ROOT リポジトリ (main/dev の2ブランチ)。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/prerun.sh"

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
    git -C "$SEED" checkout -q -b dev
    echo "dev" >> "$SEED/README.md"
    git -C "$SEED" add README.md
    git -C "$SEED" commit -q -m "dev commit"
    git -C "$SEED" remote add origin "$ORIGIN"
    git -C "$SEED" push -q origin main dev
    git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main

    ROOT="$BATS_TEST_TMPDIR/root"
    git clone -q "$ORIGIN" "$ROOT"
    git -C "$ROOT" config user.name "Test"
    git -C "$ROOT" config user.email "test@example.com"

    WT="$BATS_TEST_TMPDIR/wt/df-1"
}

# ---- (1) base 未指定 + origin/dev あり ----

@test "(1) base 未指定 + origin/dev あり -> dev を起点に新規作成" {
    cd "$ROOT"
    run "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.base == "dev"'
    echo "$output" | jq -e '.base_source == "origin/dev"'
    echo "$output" | jq -e '.worktree_status == "created"'
    echo "$output" | jq -e '.branch == "feature/issue-1"'
    expected_head="$(git -C "$ROOT" rev-parse origin/dev)"
    echo "$output" | jq -e --arg h "$expected_head" '.head == $h'
    echo "$output" | jq -e '(.epoch | type) == "number" and (.epoch == (.epoch | floor))'
    echo "$output" | jq -e '.clean.ok == true'
    echo "$output" | jq -e '.deps.ok == true'
    echo "$output" | jq -e '.stack.frameworks == []'
}

# ---- (2) origin に dev 無し ----

@test "(2) origin に dev が無い -> origin/HEAD の default branch (main) を起点にする" {
    ORIGIN2="$BATS_TEST_TMPDIR/origin2.git"
    git init --bare -q "$ORIGIN2"
    SEED2="$BATS_TEST_TMPDIR/seed2"
    git init -q -b main "$SEED2"
    git -C "$SEED2" config user.name "Test"
    git -C "$SEED2" config user.email "test@example.com"
    echo "# seed2" > "$SEED2/README.md"
    git -C "$SEED2" add README.md
    git -C "$SEED2" commit -q -m "init"
    git -C "$SEED2" remote add origin2 "$ORIGIN2"
    git -C "$SEED2" push -q origin2 main
    git -C "$ORIGIN2" symbolic-ref HEAD refs/heads/main

    ROOT2="$BATS_TEST_TMPDIR/root2"
    git clone -q "$ORIGIN2" "$ROOT2"
    git -C "$ROOT2" config user.name "Test"
    git -C "$ROOT2" config user.email "test@example.com"

    cd "$ROOT2"
    run "$SCRIPT" --issue 1 --worktree "$BATS_TEST_TMPDIR/wt2/df-1"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.base == "main"'
    echo "$output" | jq -e '.base_source == "origin/HEAD"'
}

# ---- (3) --base に origin に存在しない ref ----

@test "(3) --base release (origin に無い) -> ok:false, worktree skipped" {
    cd "$ROOT"
    run "$SCRIPT" --issue 1 --worktree "$WT" --base release
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.base_error | test("origin/release")'
    echo "$output" | jq -e '.worktree_status == "skipped"'
    echo "$output" | jq -e --arg wt "$WT" '.worktree == $wt'
    echo "$output" | jq -e '.deps.note | test("skipped")'
    echo "$output" | jq -e '.stack.frameworks == []'
}

# ---- (4) --base main (存在する) ----

@test "(4) --base main -> explicit" {
    cd "$ROOT"
    run "$SCRIPT" --issue 1 --worktree "$WT" --base main
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.base == "main"'
    echo "$output" | jq -e '.base_source == "explicit"'
}

# ---- (5) 同じ WT で 2 回目 -> reused + clean ----

@test "(5) 同じ WT で2回目実行 -> reused, head同一, .devflow-tmpがcleanされる" {
    cd "$ROOT"
    run "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    first_head="$(echo "$output" | jq -r '.head')"

    mkdir -p "$WT/.devflow-tmp"
    echo "stale" > "$WT/.devflow-tmp/stale.txt"

    run "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.worktree_status == "reused"'
    echo "$output" | jq -e --arg h "$first_head" '.head == $h'
    [ ! -f "$WT/.devflow-tmp/stale.txt" ]
}

# ---- (6) 既存 worktree の起点が origin/main（期待は origin/dev）-> 不一致 ----

@test "(6) 既存worktreeの起点が不一致 -> ok:false, reused, worktree_errorに詳細" {
    cd "$ROOT"
    git worktree add -q --track -b feature/issue-1 "$WT" origin/main

    run "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.worktree_status == "reused"'
    echo "$output" | jq -e '.worktree_error | test("origin/main")'
    echo "$output" | jq -e '.worktree_error | test("origin/dev")'
    echo "$output" | jq -e '.worktree_error | test("git worktree remove")'
}

# ---- (6b) 既存 worktree が別 branch を checkout（起点は正しい）-> branch 不一致で fail-closed ----
# 出力の branch は feature/issue-<N> 固定で下流（pr-iterate head_ref / fetch）が信頼するため、
# 別 branch の worktree を ok:true で返してはならない

@test "(6b) 既存worktreeのcheckout branchがfeature/issue-Nでない -> ok:false, worktree_errorに実branch" {
    cd "$ROOT"
    git worktree add -q --track -b other-branch "$WT" origin/dev

    run "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.worktree_status == "reused"'
    echo "$output" | jq -e '.worktree_error | test("feature/issue-1")'
    echo "$output" | jq -e '.worktree_error | test("other-branch")'
}

# ---- (6c) epoch は script 開始時点（deps install より前）で採る ----

@test "(6c) epoch は script 開始時の時刻（出力直前ではない）" {
    cd "$ROOT"
    before="$(date +%s)"
    run "$SCRIPT" --issue 1 --worktree "$WT"
    after="$(date +%s)"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e --argjson b "$before" --argjson a "$after" '.epoch >= $b and .epoch <= $a'
    # 静的 pin: epoch の採取行が deps install（ensure-worktree-deps）より前にある
    epoch_line="$(grep -n '^epoch="\$(date +%s)"' "$SCRIPT" | head -1 | cut -d: -f1)"
    deps_line="$(grep -n 'ensure-worktree-deps.sh' "$SCRIPT" | head -1 | cut -d: -f1)"
    [ -n "$epoch_line" ] && [ -n "$deps_line" ] && [ "$epoch_line" -lt "$deps_line" ]
}

# ---- (7) push -u 後は origin/feature/issue-N も一致扱い ----

@test "(7) push -u 後の upstream (origin/feature/issue-1) は一致扱い" {
    cd "$ROOT"
    run "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]

    git -C "$ROOT" push -q origin "feature/issue-1"
    git -C "$WT" branch --set-upstream-to=origin/feature/issue-1 feature/issue-1

    run "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
}

# ---- (8) --no-track で upstream 未設定 ----

@test "(8) upstream tracking 未設定 -> worktree_errorに'upstream'を含む" {
    cd "$ROOT"
    git worktree add -q --no-track -b feature/issue-1 "$WT" origin/dev

    run "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.worktree_error | test("upstream")'
}

# ---- (9) prunable (実体削除) からの再作成 ----

@test "(9) 実体を rm -rf した stale worktree -> prune後に既存branchをcheckoutしてcreated" {
    cd "$ROOT"
    run "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]

    rm -rf "$WT"

    run "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true'
    echo "$output" | jq -e '.worktree_status == "created"'
}

# ---- (10) package.json (next, lockfile無し) -> stack検出 + deps no_dependencies ----

@test "(10) next依存のpackage.json(lockfile無し) -> stack.frameworksにnext、deps.ok=true" {
    git -C "$SEED" checkout -q dev
    cat > "$SEED/package.json" <<'JSON'
{
  "dependencies": {
    "next": "14.0.0"
  }
}
JSON
    git -C "$SEED" add package.json
    git -C "$SEED" commit -q -m "add next"
    git -C "$SEED" push -q origin dev

    cd "$ROOT"
    run "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.stack.frameworks | index("next") != null'
    echo "$output" | jq -e '.deps.ok == true'
}

# ---- (11) 引数エラー ----

@test "(11a) --issue 欠落 -> exit 2, stdout空" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --worktree "$WT"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

@test "(11b) --issue が数値でない -> exit 2, stdout空" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue abc --worktree "$WT"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

@test "(11c) --worktree が相対パス -> exit 2, stdout空" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "relative/path"
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

@test "(11d) 未知オプション -> exit 2, stdout空" {
    cd "$ROOT"
    run --separate-stderr "$SCRIPT" --issue 1 --worktree "$WT" --bogus
    [ "$status" -eq 2 ]
    [ -z "$output" ]
}

# ---- (12) repo 解決 ----

@test "(12a) https origin -> repo キーが owner/name" {
    git -C "$ROOT" remote set-url origin https://github.com/acme/skills.git
    cd "$ROOT"
    run "$SCRIPT" --issue 1 --worktree "$WT" --base main
    echo "$output" | jq -e '.repo == "acme/skills"'
    echo "$output" | jq -e '(.epoch | type) == "number"'
}

@test "(12b) file:// origin -> repo キーが無い" {
    cd "$ROOT"
    run "$SCRIPT" --issue 1 --worktree "$WT" --base main
    echo "$output" | jq -e 'has("repo") == false'
    echo "$output" | jq -e '(.epoch | type) == "number"'
}

# ---- (13) 既存 worktree が unwritable ----

@test "(13) 既存worktreeがunwritable -> ok:false, worktree_status=unwritable, worktree_removed=false" {
    cd "$ROOT"
    run "$SCRIPT" --issue 1 --worktree "$WT"
    [ "$status" -eq 0 ]

    chmod a-w "$WT"

    run "$SCRIPT" --issue 1 --worktree "$WT"
    status_after_chmod="$status"
    output_after_chmod="$output"

    chmod u+w "$WT"

    [ "$status_after_chmod" -eq 0 ]
    echo "$output_after_chmod" | jq -e '.ok == false'
    echo "$output_after_chmod" | jq -e '.worktree_status == "unwritable"'
    echo "$output_after_chmod" | jq -e '.worktree_error | ascii_downcase | test("permission|not permitted")'
    echo "$output_after_chmod" | jq -e '.worktree_removed == false'
}

# ---- (14) 新規作成先の親ディレクトリが unwritable ----

@test "(14) 新規worktreeの親ディレクトリがunwritable -> git worktree add失敗でworktree_status=error" {
    cd "$ROOT"
    PARENT="$BATS_TEST_TMPDIR/roparent"
    mkdir -p "$PARENT"
    chmod a-w "$PARENT"

    run "$SCRIPT" --issue 1 --worktree "$PARENT/df-1"
    chmod u+w "$PARENT"

    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false'
    echo "$output" | jq -e '.worktree_status == "error"'
}

@test "(14b) 静的pin: worktree remove --force 呼び出しが存在する" {
    count="$(grep -c 'worktree remove --force' "$SCRIPT")"
    [ "$count" -ge 1 ]
}

# ---- (15) 静的 pin: gh / git push を呼ばない ----

@test "(15a) 静的pin: gh を呼ばない" {
    run grep -E '(^|[^A-Za-z0-9_-])gh ' "$SCRIPT"
    [ "$status" -ne 0 ]
}

@test "(15b) 静的pin: git push を呼ばない" {
    run grep -E 'git (-C [^ ]+ )?push' "$SCRIPT"
    [ "$status" -ne 0 ]
}
