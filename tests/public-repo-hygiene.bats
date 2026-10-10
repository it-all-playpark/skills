#!/usr/bin/env bats
# public-repo-hygiene.bats - 本 repo は public。git ls-files の全追跡ファイルを走査し、公開に適さない
# 混入を検出したら <path>:<line>: <種別>: <該当文字列> を出して fail する（issue #925）。
# 規約は AGENTS.md の「Public repo」節。ここは機械的に検出できる部分だけを強制する:
#   - home:       ホームディレクトリの絶対パス（/Users/<name>/・/home/<name>/）
#   - email:      メールアドレス
#   - org:        private org の参照
#   - claudedocs: 内部メモ・セッションダンプ（claudedocs/ 配下の追跡ファイル・Claude Code の transcript パス）
#   - repo:       plugins/ の実行経路（テスト・fixture 以外）での本 repo のハードコード
# 許可リストはこのファイルに持つ。例外を足すときは理由をコメントで残す。
# このファイル自身は検出パターンと fixture の違反文字列を持つので走査から外す（検出ロジックは fixture テストが守る）。

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
}

SELF=':(exclude)tests/public-repo-hygiene.bats'

# 許可リスト（awk の ERE。該当文字列の全体一致で判定する。mawk は {n,m} を解さないので使わない）
# home: テスト・例示用の placeholder 名だけを通す。<user> のような山括弧の placeholder も通す。
HOME_ALLOW='/Users/(x|u|username)/|/home/u/|/(Users|home)/<[^/>]+>/'
# email:
#   - example.com / example.org（サブドメイン含む）: RFC 2606 の例示用ドメイン
#   - users.noreply.github.com: GitHub の no-reply アドレス（個人のアドレスを出さない形）
#   - *.test.local: テスト用ドメイン
#   - xxx@project.iam.gserviceaccount.com: GCP サービスアカウントの placeholder（ga-analyzer の setup guide）
#   - git@github.com: SSH remote の URL（アドレスではない）
#   - pass@ep-cool-name-123456.us-east-2.aws.neon.tech: detect-stack.bats のダミー接続 URL（userinfo@host）
EMAIL_ALLOW='[^@]+@([A-Za-z0-9-]+\.)*example\.(com|org)|[^@]+@users\.noreply\.github\.com|[^@]+@([A-Za-z0-9-]+\.)*test\.local|xxx@project\.iam\.gserviceaccount\.com|git@github\.com|pass@ep-cool-name-123456\.us-east-2\.aws\.neon\.tech'
PRIVATE_ORG='playpark-llc'

# git grep -nIoE の `<path>:<line>:<match>` を受け、match が許可リスト（$2、空なら無し）に全体一致する行を
# 除いて `<path>:<line>: <種別>: <match>` に整形する。
# allow は -v ではなく ENVIRON で渡す（-v は \. をエスケープとして解釈し、gawk / mawk で . に化ける）。
label_hits() {
    HYGIENE_ALLOW="$2" awk -v kind="$1" 'BEGIN { allow = ENVIRON["HYGIENE_ALLOW"] } {
        i = index($0, ":"); path = substr($0, 1, i - 1); rest = substr($0, i + 1)
        j = index(rest, ":"); line = substr(rest, 1, j - 1); m = substr(rest, j + 1)
        if (allow != "" && m ~ ("^(" allow ")$")) next
        print path ":" line ": " kind ": " m
    }'
}

# <root> の git 管理下の追跡ファイルを走査し、違反を出力する。違反があれば 1 を返す。
hygiene_scan() {
    local root="$1" hits
    hits="$(
        git -C "$root" grep -nIoE '/(Users|home)/[^/[:space:]]+/' -- . "$SELF" | label_hits home "$HOME_ALLOW"
        git -C "$root" grep -nIoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- . "$SELF" | label_hits email "$EMAIL_ALLOW"
        git -C "$root" grep -nIoF "$PRIVATE_ORG/" -- . "$SELF" | label_hits org ''
        git -C "$root" ls-files | grep -E '(^|/)claudedocs/' | sed 's/$/: claudedocs: claudedocs 配下の追跡ファイル/'
        # transcript は ~/.claude/projects/<cwd を - 区切りにした名前>/<session>.jsonl。<project> のような
        # 山括弧の placeholder は先頭文字で外れる。
        git -C "$root" grep -nIoE '\.claude/projects/[A-Za-z0-9_-][^/[:space:]]*' -- . "$SELF" | label_hits claudedocs ''
        git -C "$root" grep -nIoE -- '--repo[= ]+it-all-playpark/[A-Za-z0-9._-]*' -- plugins \
            ':(exclude)*.bats' ':(exclude)*.test.mjs' ':(exclude)*.test.sh' \
            ':(exclude)*/tests/*' ':(exclude)*/fixtures/*' | label_hits repo ''
    )"
    [ -z "$hits" ] && return 0
    echo "$hits"
    return 1
}

# 許可リストの placeholder だけを含む追跡ファイル 1 本を持つ fixture repo を作る
make_fixture_repo() {
    FIXTURE="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$FIXTURE/plugins/demo/scripts"
    git -C "$FIXTURE" init -q
    cat > "$FIXTURE/allowed.md" <<'EOF'
/Users/x/repo /Users/u/a /home/u/b /Users/username/c /Users/<user>/d
test@example.com me@git.example.org 123+bot@users.noreply.github.com a@ci.test.local
xxx@project.iam.gserviceaccount.com git@github.com:acme/repo.git
postgres://user:pass@ep-cool-name-123456.us-east-2.aws.neon.tech/db
~/.claude/projects/<project>/<session>.jsonl
gh issue list --repo acme/tools
EOF
    git -C "$FIXTURE" add -A
}

# fixture repo に違反を 1 件含むファイルを足す（2 行目が違反）
add_violation() {
    local path="$1" line="$2"
    mkdir -p "$(dirname "$FIXTURE/$path")"
    printf 'clean line\n%s\n' "$line" > "$FIXTURE/$path"
    git -C "$FIXTURE" add -A
}

@test "現在の追跡ファイルに public repo に載せられない混入が無い" {
    run hygiene_scan "$REPO_ROOT"
    echo "$output"
    [ "$status" -eq 0 ]
}

@test "fixture: 許可リストの placeholder だけなら通る" {
    make_fixture_repo
    run hygiene_scan "$FIXTURE"
    echo "$output"
    [ "$status" -eq 0 ]
}

@test "fixture: ホームディレクトリの絶対パスを足すと file:line 付きで fail する" {
    make_fixture_repo
    add_violation docs/a.md 'see /Users/alice/src/app'
    run hygiene_scan "$FIXTURE"
    echo "$output"
    [ "$status" -eq 1 ]
    [ "$output" = "docs/a.md:2: home: /Users/alice/" ]

    add_violation docs/b.md 'cd /home/bob/work'
    run hygiene_scan "$FIXTURE"
    echo "$output"
    [ "$status" -eq 1 ]
    [[ "$output" == *"docs/b.md:2: home: /home/bob/"* ]]
}

@test "fixture: 許可リスト外のメールアドレスを足すと file:line 付きで fail する" {
    make_fixture_repo
    add_violation docs/a.md 'contact: alice@corp.co.jp'
    run hygiene_scan "$FIXTURE"
    echo "$output"
    [ "$status" -eq 1 ]
    [ "$output" = "docs/a.md:2: email: alice@corp.co.jp" ]
}

@test "fixture: private org の参照を足すと file:line 付きで fail する" {
    make_fixture_repo
    add_violation docs/a.md "clone github.com/$PRIVATE_ORG/internal"
    run hygiene_scan "$FIXTURE"
    echo "$output"
    [ "$status" -eq 1 ]
    [ "$output" = "docs/a.md:2: org: $PRIVATE_ORG/" ]
}

@test "fixture: claudedocs 配下の追跡ファイルを足すと fail する" {
    make_fixture_repo
    add_violation claudedocs/rca.md 'memo'
    run hygiene_scan "$FIXTURE"
    echo "$output"
    [ "$status" -eq 1 ]
    [ "$output" = "claudedocs/rca.md: claudedocs: claudedocs 配下の追跡ファイル" ]
}

@test "fixture: Claude Code の transcript パスを足すと file:line 付きで fail する" {
    make_fixture_repo
    add_violation docs/a.md 'log: ~/.claude/projects/-Users-x-repo/0f1e.jsonl'
    run hygiene_scan "$FIXTURE"
    echo "$output"
    [ "$status" -eq 1 ]
    [ "$output" = "docs/a.md:2: claudedocs: .claude/projects/-Users-x-repo" ]
}

@test "fixture: plugins/ の SKILL.md・scripts に --repo it-all-playpark/ を足すと fail し、テストと fixture は対象外" {
    make_fixture_repo
    add_violation plugins/demo/scripts/fixtures/case.json 'gh pr list --repo it-all-playpark/claude-plugins'
    add_violation plugins/demo/scripts/run.bats 'gh pr list --repo it-all-playpark/claude-plugins'
    run hygiene_scan "$FIXTURE"
    echo "$output"
    [ "$status" -eq 0 ]

    add_violation plugins/demo/SKILL.md 'gh issue list --repo it-all-playpark/claude-plugins'
    add_violation plugins/demo/scripts/run.sh 'gh pr view --repo=it-all-playpark/claude-plugins 1'
    run hygiene_scan "$FIXTURE"
    echo "$output"
    [ "$status" -eq 1 ]
    [[ "$output" == *"plugins/demo/SKILL.md:2: repo: --repo it-all-playpark/claude-plugins"* ]]
    [[ "$output" == *"plugins/demo/scripts/run.sh:2: repo: --repo=it-all-playpark/claude-plugins"* ]]
}

@test "AGENTS.md の Public repo 節はこのテストを参照する" {
    section="$(awk '$0 == "## Public repo" {on=1; next} on && /^## / {exit} on {print}' "$REPO_ROOT/AGENTS.md")"
    echo "$section"
    [ -n "$section" ]
    [[ "$section" == *"tests/public-repo-hygiene.bats"* ]]
}
