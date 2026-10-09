#!/usr/bin/env bats
# Tests for _shared/scripts/workspace-prebuild.sh (issue #754)
#
# Strategy: mktemp -d に git 管理下の pnpm ワークスペース fixture を作る。packages/shared は exports が
# git 管理外の ./dist を指し、packages/backend が workspace:* で依存する（アプリ repo でよくある @acme/shared と
# 同じ形）。pnpm は stub（--filter <name>... の各 package で scripts.build を実行し、呼び出しを STUB_LOG に
# 残す）に差し替え、実 install なしで決定論に回す。

setup() {
    SCRIPT="$BATS_TEST_DIRNAME/workspace-prebuild.sh"
    TMP_DIR="$(mktemp -d)"
    WS="$TMP_DIR/ws"
    STUB_DIR="$TMP_DIR/.stubbin"
    STUB_LOG="$TMP_DIR/pnpm-invocations.log"
    make_stub_pnpm
}

teardown() {
    rm -rf "$TMP_DIR"
}

# stub pnpm: `--filter <name>...` ごとに packages/*/package.json から name が一致する package を探し、
# その dir で scripts.build を sh で実行する（依存順の解決はしない）。1 つでも失敗すれば非 0。
make_stub_pnpm() {
    mkdir -p "$STUB_DIR"
    : > "$STUB_LOG"
    cat > "$STUB_DIR/pnpm" <<STUBEOF
#!/usr/bin/env bash
echo "\$*" >> "$STUB_LOG"
names=()
while [ \$# -gt 0 ]; do
    case "\$1" in
        --filter) names+=("\${2%...}"); shift 2 ;;
        *) shift ;;
    esac
done
for n in "\${names[@]}"; do
    for pj in "\$PWD"/packages/*/package.json; do
        [ "\$(jq -r '.name' "\$pj")" = "\$n" ] || continue
        (cd "\$(dirname "\$pj")" && sh -c "\$(jq -r '.scripts.build' package.json)") || exit 1
    done
done
exit 0
STUBEOF
    chmod +x "$STUB_DIR/pnpm"
}

# pnpm ワークスペース fixture を $WS に作り、ソースを commit する。dist/ と node_modules/ は git 管理外。
# backend の node_modules/@fx/shared は pnpm と同じく packages/shared への symlink。
make_workspace() {
    mkdir -p "$WS/packages/shared/src" "$WS/packages/backend/node_modules/@fx"
    echo '{"name":"root","private":true}' > "$WS/package.json"
    printf 'lockfileVersion: 9.0\n' > "$WS/pnpm-lock.yaml"
    cat > "$WS/pnpm-workspace.yaml" <<'YAML'
packages:
  # 共有パッケージ
  - 'packages/*'
YAML
    printf 'dist/\nnode_modules/\n' > "$WS/.gitignore"
    cat > "$WS/packages/shared/package.json" <<'JSON'
{"name":"@fx/shared","type":"module","main":"./dist/index.js",
 "exports":{".":{"types":"./dist/index.d.ts","import":"./dist/index.js"},"./greet":{"import":"./dist/greet.js"}},
 "scripts":{"build":"mkdir -p dist && cp src/*.js dist/"}}
JSON
    echo "export const greet = () => 'hello v1';" > "$WS/packages/shared/src/greet.js"
    echo "export * from './greet.js';" > "$WS/packages/shared/src/index.js"
    echo '{"name":"backend","type":"module","dependencies":{"@fx/shared":"workspace:*"}}' > "$WS/packages/backend/package.json"
    ln -s ../../../shared "$WS/packages/backend/node_modules/@fx/shared"
    cat > "$WS/packages/backend/greet.test.mjs" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '@fx/shared/greet';
test('greet', () => { assert.equal(greet(), process.env.EXPECTED_GREETING ?? 'hello v1'); });
EOF
    git -C "$WS" init -q
    git -C "$WS" config user.email t@t
    git -C "$WS" config user.name t
    git -C "$WS" add -A
    git -C "$WS" commit -q -m base
}

run_prebuild() {
    PATH="$STUB_DIR:$PATH" run bash "$SCRIPT" "$WS"
}

# stdout の JSON（ビルドのログは stderr だが bats の run は両方を $output に入れるので最終行を読む）
result() {
    printf '%s\n' "$output" | tail -n 1
}

@test "(a) dist の無い新しい worktree: prebuild 前は依存先を import するテストが落ち、prebuild 後は通る (AC-1)" {
    make_workspace
    [ ! -e "$WS/packages/shared/dist" ]
    run node --test "$WS/packages/backend/greet.test.mjs"
    [ "$status" -ne 0 ]

    run_prebuild
    [ "$status" -eq 0 ]
    result | jq -e '.status == "built"'
    result | jq -e '.packages == ["@fx/shared"]'
    result | jq -e '.command == "pnpm --filter @fx/shared... run build"'
    [ -f "$WS/packages/shared/dist/greet.js" ]

    run node --test "$WS/packages/backend/greet.test.mjs"
    [ "$status" -eq 0 ]
}

@test "(b) 依存先のソースを変えたあと再実行すると成果物が更新され、テストがその変更を読む (AC-2)" {
    make_workspace
    run_prebuild
    [ "$status" -eq 0 ]
    grep -q "hello v1" "$WS/packages/shared/dist/greet.js"

    echo "export const greet = () => 'hello v2';" > "$WS/packages/shared/src/greet.js"
    run_prebuild
    [ "$status" -eq 0 ]
    grep -q "hello v2" "$WS/packages/shared/dist/greet.js"
    EXPECTED_GREETING='hello v2' run node --test "$WS/packages/backend/greet.test.mjs"
    [ "$status" -eq 0 ]
    [ "$(wc -l < "$STUB_LOG" | tr -d ' ')" -eq 2 ]
}

@test "(c) ビルドが失敗したら exit 1・status failed で、reason にビルド失敗と対象パッケージ名が残る (AC-4)" {
    make_workspace
    jq '.scripts.build = "exit 3"' "$WS/packages/shared/package.json" > "$TMP_DIR/pkg.json"
    mv "$TMP_DIR/pkg.json" "$WS/packages/shared/package.json"

    run_prebuild
    [ "$status" -eq 1 ]
    result | jq -e '.status == "failed"'
    result | jq -e '.packages == ["@fx/shared"]'
    result | jq -e '.reason == "workspace build failed: @fx/shared"'
}

@test "(d) pnpm 以外（npm workspaces）の repo ではビルドを実行しない (AC-5)" {
    make_workspace
    rm "$WS/pnpm-workspace.yaml" "$WS/pnpm-lock.yaml"
    echo '{"name":"root","private":true,"workspaces":["packages/*"]}' > "$WS/package.json"
    echo '{}' > "$WS/package-lock.json"

    run_prebuild
    [ "$status" -eq 0 ]
    result | jq -e '.status == "skipped" and .reason == "not_pnpm_workspace" and .packages == []'
    [ ! -s "$STUB_LOG" ]
    [ ! -e "$WS/packages/shared/dist" ]
}

@test "(e) 成果物が git 管理下を指す workspace package だけの repo ではビルドを実行しない (AC-5)" {
    make_workspace
    jq '.main = "./src/index.js" | .exports = {".": "./src/index.js", "./greet": "./src/greet.js"}' \
        "$WS/packages/shared/package.json" > "$TMP_DIR/pkg.json"
    mv "$TMP_DIR/pkg.json" "$WS/packages/shared/package.json"

    run_prebuild
    [ "$status" -eq 0 ]
    result | jq -e '.status == "skipped" and .reason == "no_target_packages"'
    [ ! -s "$STUB_LOG" ]
}

@test "(f) workspace: で参照されていない package は対象外 (AC-5)" {
    make_workspace
    # backend の依存を workspace: 以外にすると shared はどこからも workspace: で参照されない
    echo '{"name":"backend","type":"module","dependencies":{"@fx/shared":"^1.0.0"}}' > "$WS/packages/backend/package.json"
    run_prebuild
    [ "$status" -eq 0 ]
    result | jq -e '.reason == "no_target_packages"'
    [ ! -s "$STUB_LOG" ]
}

@test "(f-2) build script の無い package は対象外 (AC-5)" {
    make_workspace
    jq 'del(.scripts.build)' "$WS/packages/shared/package.json" > "$TMP_DIR/pkg.json"
    mv "$TMP_DIR/pkg.json" "$WS/packages/shared/package.json"
    run_prebuild
    [ "$status" -eq 0 ]
    result | jq -e '.reason == "no_target_packages"'
    [ ! -s "$STUB_LOG" ]
}

@test "(g) 対象が複数あれば 1 コマンドにまとめ、exports の * パターンも git 管理外の判定に使う" {
    make_workspace
    mkdir -p "$WS/packages/ui/src"
    cat > "$WS/packages/ui/package.json" <<'JSON'
{"name":"@fx/ui","module":"./src/index.js","exports":{"./*":"./dist/*.js"},"scripts":{"build":"mkdir -p dist && cp src/*.js dist/"}}
JSON
    echo "export const ui = 1;" > "$WS/packages/ui/src/index.js"
    echo '{"name":"backend","type":"module","dependencies":{"@fx/shared":"workspace:*"},"devDependencies":{"@fx/ui":"workspace:^"}}' \
        > "$WS/packages/backend/package.json"

    run_prebuild
    [ "$status" -eq 0 ]
    result | jq -e '.packages == ["@fx/shared", "@fx/ui"]'
    result | jq -e '.command == "pnpm --filter @fx/shared... --filter @fx/ui... run build"'
    [ "$(wc -l < "$STUB_LOG" | tr -d ' ')" -eq 1 ]
    [ -f "$WS/packages/ui/dist/index.js" ]
}

@test "(h) 引数が無ければ usage で exit 2" {
    run bash "$SCRIPT"
    [ "$status" -eq 2 ]
}
