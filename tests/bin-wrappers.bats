#!/usr/bin/env bats
# Invariant (#571): bin/ exec ラッパーは playpark-core (journal 1本) と
# dev-flow (17本) に分割される。plugin install 環境では skills が
# plugin root 配下に入るため、絶対パス runtime 依存を断つ。
#
# 分割後もラッパーは plugin 境界を跨がない: 3 行目の target は
# `$(dirname "$0")/../<target>` の 1 段の `../` のみで、target 文字列自体に
# `../` を含まない（含めば隣接 plugin へ越境することになる）。
#
# wrapper は working tree の実行ビットに依存させず `bash bin/<name>` で
# 起動する（実行ビットの pin は git index mode の直接検査で行う）。

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
    TEST_TMP_DIRS=()
}

teardown() {
    for d in "${TEST_TMP_DIRS[@]:-}"; do
        if [ -n "$d" ]; then
            rm -rf "$d"
        fi
    done
    return 0
}

core_expected_names() {
    cat <<'EOF'
journal
EOF
}

devflow_expected_names() {
    cat <<'EOF'
ac-lint
analyze-dev-flow-telemetry
analyze-issue
check-ci
cross-repo-artifacts
detect-and-install
detect-stack
diff-risk-classify
ensure-worktree-deps
hypothesis-check
redgreen-verify
secfloor-classify
structural-classify
ui-verify-server
veridelta-archive
worktree-diff-hash
worktree-teardown
EOF
}

target_for() {
    case "$1" in
        journal) echo "skill-retrospective/scripts/journal.sh" ;;
        cross-repo-artifacts) echo "_shared/scripts/cross-repo-artifacts.sh" ;;
        detect-and-install) echo "_shared/scripts/detect-and-install.sh" ;;
        diff-risk-classify) echo "_shared/scripts/diff-risk-classify.sh" ;;
        ensure-worktree-deps) echo "_shared/scripts/ensure-worktree-deps.sh" ;;
        redgreen-verify) echo "_shared/scripts/redgreen-verify.sh" ;;
        secfloor-classify) echo "_shared/scripts/secfloor-classify.sh" ;;
        structural-classify) echo "_shared/scripts/structural-classify.sh" ;;
        ui-verify-server) echo "_shared/scripts/ui-verify-server.sh" ;;
        veridelta-archive) echo "_shared/scripts/veridelta-archive.sh" ;;
        worktree-diff-hash) echo "_shared/scripts/worktree-diff-hash.sh" ;;
        worktree-teardown) echo "_shared/scripts/worktree-teardown.sh" ;;
        check-ci) echo "pr-iterate/scripts/check-ci.sh" ;;
        analyze-issue) echo "dev-issue-analyze/scripts/analyze-issue.sh" ;;
        hypothesis-check) echo "dev-flow-improve/scripts/hypothesis-check.sh" ;;
        analyze-dev-flow-telemetry) echo "dev-flow-doctor/scripts/analyze-dev-flow-telemetry.sh" ;;
        detect-stack) echo "_lib/scripts/detect-stack.sh" ;;
        ac-lint) echo "_lib/scripts/ac-lint.sh" ;;
        *) echo "" ;;
    esac
}

@test "plugins/playpark-core/bin の entry は journal 1本と完全一致する" {
    expected="$(core_expected_names)"
    actual="$(/bin/ls -1 "$REPO_ROOT/plugins/playpark-core/bin" | sort)"
    [ "$actual" = "$expected" ]
}

@test "plugins/dev-flow/bin の entry は対象17本と完全一致する" {
    expected="$(devflow_expected_names)"
    actual="$(/bin/ls -1 "$REPO_ROOT/plugins/dev-flow/bin" | sort)"
    [ "$actual" = "$expected" ]
}

@test "core: 全wrapperがgit index上でexecutable(100755)である" {
    while IFS= read -r name; do
        run git -C "$REPO_ROOT" ls-files -s "plugins/playpark-core/bin/$name"
        [ "$status" -eq 0 ]
        case "$output" in
            100755\ *) : ;;
            *)
                echo "not executable in index: plugins/playpark-core/bin/$name -> $output"
                return 1
                ;;
        esac
    done <<< "$(core_expected_names)"
}

@test "dev-flow: 全wrapperがgit index上でexecutable(100755)である" {
    while IFS= read -r name; do
        run git -C "$REPO_ROOT" ls-files -s "plugins/dev-flow/bin/$name"
        [ "$status" -eq 0 ]
        case "$output" in
            100755\ *) : ;;
            *)
                echo "not executable in index: plugins/dev-flow/bin/$name -> $output"
                return 1
                ;;
        esac
    done <<< "$(devflow_expected_names)"
}

@test "core: 全wrapperの本文が3行exec形式に一致し対象ファイルが存在する" {
    plugin_root="$REPO_ROOT/plugins/playpark-core"
    while IFS= read -r name; do
        target="$(target_for "$name")"
        [ -n "$target" ]
        file="$plugin_root/bin/$name"
        [ -f "$file" ]

        line1=$(sed -n '1p' "$file")
        [ "$line1" = "#!/usr/bin/env bash" ]

        line3=$(sed -n '3p' "$file")
        expected_line3="exec bash \"\$(dirname \"\$0\")/../$target\" \"\$@\""
        [ "$line3" = "$expected_line3" ]

        [ -f "$plugin_root/$target" ]
    done <<< "$(core_expected_names)"
}

@test "dev-flow: 全wrapperの本文が3行exec形式に一致し対象ファイルが存在する" {
    plugin_root="$REPO_ROOT/plugins/dev-flow"
    while IFS= read -r name; do
        target="$(target_for "$name")"
        [ -n "$target" ]
        file="$plugin_root/bin/$name"
        [ -f "$file" ]

        line1=$(sed -n '1p' "$file")
        [ "$line1" = "#!/usr/bin/env bash" ]

        line3=$(sed -n '3p' "$file")
        expected_line3="exec bash \"\$(dirname \"\$0\")/../$target\" \"\$@\""
        [ "$line3" = "$expected_line3" ]

        [ -f "$plugin_root/$target" ]
    done <<< "$(devflow_expected_names)"
}

@test "全wrapperが plugin 境界を跨がない（target 文字列自体に ../ を含まない）" {
    for plugin in playpark-core dev-flow; do
        names="$([ "$plugin" = playpark-core ] && core_expected_names || devflow_expected_names)"
        while IFS= read -r name; do
            target="$(target_for "$name")"
            [ -n "$target" ]
            case "$target" in
                *../*)
                    echo "plugin boundary crossed: plugins/$plugin/bin/$name -> $target"
                    return 1
                    ;;
            esac
        done <<< "$names"
    done
}

@test "detect-stackがbin経由bare名で機能透過する" {
    export PATH="$REPO_ROOT/plugins/playpark-core/bin:$REPO_ROOT/plugins/dev-flow/bin:$PATH"
    d="$(mktemp -d "${TMPDIR:-/tmp}/binwrap-XXXXXX")"
    TEST_TMP_DIRS+=("$d")
    run bash "$REPO_ROOT/plugins/dev-flow/bin/detect-stack" "$d"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.frameworks | type == "array"'
}

@test "ac-lintがbin経由bare名で引数とexit codeを透過する(成功系)" {
    export PATH="$REPO_ROOT/plugins/playpark-core/bin:$REPO_ROOT/plugins/dev-flow/bin:$PATH"
    f="$(mktemp "${TMPDIR:-/tmp}/binwrap-ac-XXXXXX")"
    TEST_TMP_DIRS+=("$f")
    printf '## 受け入れ基準\n- [ ] x\n' > "$f"
    run bash "$REPO_ROOT/plugins/dev-flow/bin/ac-lint" "$f"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "t1"'
}

@test "ac-lintがbin経由bare名でエラー経路を透過する(引数なし)" {
    export PATH="$REPO_ROOT/plugins/playpark-core/bin:$REPO_ROOT/plugins/dev-flow/bin:$PATH"
    run bash "$REPO_ROOT/plugins/dev-flow/bin/ac-lint"
    [ "$status" -eq 1 ]
    echo "$output" | jq -e '.ok == false'
}
