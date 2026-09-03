#!/usr/bin/env bats
# link-agent-skills.bats - Regression tests for
# plugins/playpark-core/_lib/infra/link-agent-skills.sh.
#
# 外部スキルの実体は plugins/playpark-skills/.agents/skills/ に置き、symlink は
# plugins/playpark-skills/ 直下に張る。plugin ディレクトリの外を指す top-level entry が
# あると `claude plugin install`（mode: link）が install 自体を拒否するため、旧配置
# （repo root 直下 / repo root の .agents/ を指す脱出 symlink）の掃除が要件になる。
#
# 各テストは $BATS_TEST_TMPDIR に fixture リポジトリを組み立てる。REPO_ROOT は
# スクリプト自身の位置から導出されるため、コピー先が実効的な repo root になり、
# 実リポジトリに触れずに挙動を確認できる。

SCRIPT_REL="plugins/playpark-core/_lib/infra/link-agent-skills.sh"

setup() {
    FIXTURE="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$FIXTURE/plugins/playpark-core/_lib/infra"
    mkdir -p "$FIXTURE/plugins/playpark-skills"
    cp "$BATS_TEST_DIRNAME/../$SCRIPT_REL" "$FIXTURE/plugins/playpark-core/_lib/infra/"
    printf '# base\nplugins/playpark-skills/.agents/\n' > "$FIXTURE/.gitignore"
}

run_link() {
    run bash "$FIXTURE/$SCRIPT_REL"
}

@test "旧配置が残っていても 1 回の実行で新配置の symlink が張られる" {
    mkdir -p "$FIXTURE/plugins/playpark-skills/.agents/skills/alpha"
    # 旧配置: plugin の外（repo root の .agents/）を指す脱出 symlink
    ln -s ../../.agents/skills/alpha "$FIXTURE/plugins/playpark-skills/alpha"

    run_link
    [ "$status" -eq 0 ]

    [ -L "$FIXTURE/plugins/playpark-skills/alpha" ]
    [ "$(readlink "$FIXTURE/plugins/playpark-skills/alpha")" = ".agents/skills/alpha" ]
    # symlink が plugin ディレクトリ内で解決すること
    [ -d "$FIXTURE/plugins/playpark-skills/alpha" ]
}

@test "repo root 直下の旧 symlink が掃除される" {
    mkdir -p "$FIXTURE/plugins/playpark-skills/.agents/skills/alpha"
    mkdir -p "$FIXTURE/.agents/skills/gamma"
    ln -s .agents/skills/gamma "$FIXTURE/gamma"

    run_link
    [ "$status" -eq 0 ]

    [ ! -L "$FIXTURE/gamma" ]
}

@test "実体が未移動でも脱出 symlink は掃除される" {
    # .agents/skills/ を plugin 配下へ移す前のマシンを再現する。
    # ここで早期 return すると脱出 symlink が残り plugin install がブロックされ続ける。
    mkdir -p "$FIXTURE/.agents/skills/alpha"
    ln -s ../../.agents/skills/alpha "$FIXTURE/plugins/playpark-skills/alpha"

    run_link
    [ "$status" -eq 0 ]

    [ ! -L "$FIXTURE/plugins/playpark-skills/alpha" ]
}

@test "2 回実行しても結果が変わらない（冪等）" {
    mkdir -p "$FIXTURE/plugins/playpark-skills/.agents/skills/alpha"
    mkdir -p "$FIXTURE/plugins/playpark-skills/.agents/skills/beta"

    run_link
    [ "$status" -eq 0 ]
    first_gitignore="$(cat "$FIXTURE/.gitignore")"

    run_link
    [ "$status" -eq 0 ]

    [ "$(readlink "$FIXTURE/plugins/playpark-skills/alpha")" = ".agents/skills/alpha" ]
    [ "$(readlink "$FIXTURE/plugins/playpark-skills/beta")" = ".agents/skills/beta" ]
    [ "$(cat "$FIXTURE/.gitignore")" = "$first_gitignore" ]
}

@test ".gitignore の managed セクションが plugin 相対パスで書かれる" {
    mkdir -p "$FIXTURE/plugins/playpark-skills/.agents/skills/alpha"

    run_link
    [ "$status" -eq 0 ]

    run grep -qx 'plugins/playpark-skills/alpha' "$FIXTURE/.gitignore"
    [ "$status" -eq 0 ]
}
