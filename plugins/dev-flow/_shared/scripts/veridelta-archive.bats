#!/usr/bin/env bats
# Tests for _shared/scripts/veridelta-archive.sh
#
# Strategy: 各テストは $BATS_TEST_TMPDIR 配下に隔離した worktree/archive-root
# fixture を作り、スクリプトの stdout(JSON 1行) と副作用(entry ディレクトリ)を検証する。
# ケース6以外は archive-root を明示引数で渡し git 非依存にする。

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/veridelta-archive.sh"
}

# ---------------------------------------------------------------------------
# ケース1: runs/*.json 2件を退避し ok:true archived:2、entry 配下の内容が元と一致
# ---------------------------------------------------------------------------
@test "archives runs/*.json and entry content matches originals" {
    WT="$BATS_TEST_TMPDIR/wt1"
    ARCHIVE_ROOT="$BATS_TEST_TMPDIR/archive1"
    mkdir -p "$WT/.veridelta/runs"
    printf '{"run":"a"}\n' > "$WT/.veridelta/runs/run-a.json"
    printf '{"run":"b"}\n' > "$WT/.veridelta/runs/run-b.json"

    run bash "$SCRIPT" "$WT" "$ARCHIVE_ROOT"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q '"ok":true'
    printf '%s\n' "$output" | grep -q '"archived":2'

    dest="$(printf '%s\n' "$output" | grep -o '"dest":"[^"]*"' | cut -d'"' -f4)"
    [ -d "$dest" ]
    diff "$dest/run-a.json" "$WT/.veridelta/runs/run-a.json"
    diff "$dest/run-b.json" "$WT/.veridelta/runs/run-b.json"
}

# ---------------------------------------------------------------------------
# ケース2: .veridelta/runs 不在 -> ok:true archived:0、entry ディレクトリ非生成
# ---------------------------------------------------------------------------
@test "missing .veridelta/runs -> archived:0 and no entry dir created" {
    WT="$BATS_TEST_TMPDIR/wt2"
    ARCHIVE_ROOT="$BATS_TEST_TMPDIR/archive2"
    mkdir -p "$WT"

    run bash "$SCRIPT" "$WT" "$ARCHIVE_ROOT"
    [ "$status" -eq 0 ]
    [ "$output" = '{"ok":true,"archived":0,"dest":"","pruned":0}' ]
    [ ! -d "$ARCHIVE_ROOT" ]
}

# ---------------------------------------------------------------------------
# ケース3: VDELTA_ARCHIVE_MAX_ENTRIES=2 で既存 entry 2件 + 新規1件
#          -> 最古 entry が消え新しい2件が残る
# ---------------------------------------------------------------------------
@test "retention by entry count prunes the oldest entry" {
    WT="$BATS_TEST_TMPDIR/wt3"
    ARCHIVE_ROOT="$BATS_TEST_TMPDIR/archive3"
    mkdir -p "$WT/.veridelta/runs"
    printf '{"run":"c"}\n' > "$WT/.veridelta/runs/run-c.json"

    mkdir -p "$ARCHIVE_ROOT/20240101T000000Z-old1"
    printf 'old1\n' > "$ARCHIVE_ROOT/20240101T000000Z-old1/run.json"
    mkdir -p "$ARCHIVE_ROOT/20240102T000000Z-old2"
    printf 'old2\n' > "$ARCHIVE_ROOT/20240102T000000Z-old2/run.json"

    VDELTA_ARCHIVE_MAX_ENTRIES=2 run bash "$SCRIPT" "$WT" "$ARCHIVE_ROOT"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q '"ok":true'
    printf '%s\n' "$output" | grep -q '"pruned":1'

    [ ! -d "$ARCHIVE_ROOT/20240101T000000Z-old1" ]
    [ -d "$ARCHIVE_ROOT/20240102T000000Z-old2" ]
    entry_count="$(find "$ARCHIVE_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
    [ "$entry_count" -eq 2 ]
}

# ---------------------------------------------------------------------------
# ケース4: VDELTA_ARCHIVE_MAX_BYTES を最新 entry 単体より小さく設定し
#          既存 entry 複数 -> 古い entry は回収されるが最新 entry は残存
# ---------------------------------------------------------------------------
@test "retention by byte budget protects the newest entry" {
    WT="$BATS_TEST_TMPDIR/wt4"
    ARCHIVE_ROOT="$BATS_TEST_TMPDIR/archive4"
    mkdir -p "$WT/.veridelta/runs"
    # 新規 entry の合計サイズが 500 バイトの MAX_BYTES を優に超えるようにする
    head -c 2000 /dev/zero | tr '\0' 'x' > "$WT/.veridelta/runs/run-new.json"

    mkdir -p "$ARCHIVE_ROOT/20240101T000000Z-old1"
    head -c 1000 /dev/zero | tr '\0' 'a' > "$ARCHIVE_ROOT/20240101T000000Z-old1/run.json"
    mkdir -p "$ARCHIVE_ROOT/20240102T000000Z-old2"
    head -c 1000 /dev/zero | tr '\0' 'b' > "$ARCHIVE_ROOT/20240102T000000Z-old2/run.json"

    VDELTA_ARCHIVE_MAX_BYTES=500 run bash "$SCRIPT" "$WT" "$ARCHIVE_ROOT"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q '"ok":true'

    dest="$(printf '%s\n' "$output" | grep -o '"dest":"[^"]*"' | cut -d'"' -f4)"

    # 古い2件は回収され、最新 entry のみが残る(超過していても1件保護で打ち切り)
    [ ! -d "$ARCHIVE_ROOT/20240101T000000Z-old1" ]
    [ ! -d "$ARCHIVE_ROOT/20240102T000000Z-old2" ]
    [ -d "$dest" ]
    entry_count="$(find "$ARCHIVE_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
    [ "$entry_count" -eq 1 ]
}

# ---------------------------------------------------------------------------
# ケース5: archive-root の親を書き込み不可にし ok:false・exit 0・ログ痕跡あり
# ---------------------------------------------------------------------------
@test "mkdir failure -> ok:false, exit 0, fail-open log trace" {
    WT="$BATS_TEST_TMPDIR/wt5"
    mkdir -p "$WT/.veridelta/runs"
    printf '{"run":"e"}\n' > "$WT/.veridelta/runs/run-e.json"

    ARCHIVE_ROOT="$BATS_TEST_TMPDIR/archive5"
    mkdir -p "$ARCHIVE_ROOT"
    chmod 555 "$ARCHIVE_ROOT"

    LOG_FILE="$BATS_TEST_TMPDIR/logs/veridelta-archive.log"

    VDELTA_ARCHIVE_LOG="$LOG_FILE" run bash "$SCRIPT" "$WT" "$ARCHIVE_ROOT"

    chmod 755 "$ARCHIVE_ROOT"

    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q '"ok":false'
    [ -f "$LOG_FILE" ]
    grep -q "veridelta-archive" "$LOG_FILE"
}

# ---------------------------------------------------------------------------
# ケース6: archive-root 省略時、git worktree から main repo root/.veridelta-archive
#          に解決される
# ---------------------------------------------------------------------------
@test "archive-root omitted resolves to main repo root/.veridelta-archive" {
    REPO="$BATS_TEST_TMPDIR/repo6"
    git init -q "$REPO"
    git -C "$REPO" config user.email t@t
    git -C "$REPO" config user.name t
    printf 'hello\n' > "$REPO/file.txt"
    git -C "$REPO" add -A
    git -C "$REPO" commit -q -m base

    WT="$BATS_TEST_TMPDIR/wt6"
    git -C "$REPO" worktree add -q "$WT" -b wt6-branch

    mkdir -p "$WT/.veridelta/runs"
    printf '{"run":"f"}\n' > "$WT/.veridelta/runs/run-f.json"

    run bash "$SCRIPT" "$WT"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | grep -q '"ok":true'

    dest="$(printf '%s\n' "$output" | grep -o '"dest":"[^"]*"' | cut -d'"' -f4)"
    # macOS では /tmp が /private/tmp のシンボリックリンクのため、dest は
    # git が realpath 解決した文字列になり得る。文字列前方一致ではなく
    # 「.veridelta-archive/ 配下」であることと、REPO 経由でも同じ実体に
    # アクセスできることを確認する(symlink 差異に非依存)。
    case "$dest" in
        */.veridelta-archive/*) : ;;
        *) echo "unexpected dest: $dest"; return 1 ;;
    esac
    [ -d "$REPO/.veridelta-archive" ]
    entry_basename="$(basename "$dest")"
    [ -d "$REPO/.veridelta-archive/$entry_basename" ]
    diff "$dest/run-f.json" "$WT/.veridelta/runs/run-f.json"

    git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# 引数不足 -> usage を stderr に出し exit 2
# ---------------------------------------------------------------------------
@test "missing arguments -> usage on stderr, exit 2" {
    run bash "$SCRIPT"
    [ "$status" -eq 2 ]
}
