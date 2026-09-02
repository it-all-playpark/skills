#!/usr/bin/env bats
# Invariant (#569): plugin bin/ に dev-flow 実行経路の 18 スクリプトの
# bare 名 exec ラッパーを配置する。plugin install 環境では skills が
# plugin root 配下に入るため、絶対パス runtime 依存を断つ。
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

expected_names() {
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
journal
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
        journal) echo "skill-retrospective/scripts/journal.sh" ;;
        check-ci) echo "pr-iterate/scripts/check-ci.sh" ;;
        analyze-issue) echo "dev-issue-analyze/scripts/analyze-issue.sh" ;;
        hypothesis-check) echo "dev-flow-improve/scripts/hypothesis-check.sh" ;;
        analyze-dev-flow-telemetry) echo "dev-flow-doctor/scripts/analyze-dev-flow-telemetry.sh" ;;
        detect-stack) echo "_lib/scripts/detect-stack.sh" ;;
        ac-lint) echo "_lib/scripts/ac-lint.sh" ;;
        *) echo "" ;;
    esac
}

@test "bin/ の entry は対象18本と完全一致する" {
    expected="$(expected_names)"
    actual="$(/bin/ls -1 "$REPO_ROOT/bin" | sort)"
    [ "$actual" = "$expected" ]
}

@test "全wrapperがgit index上でexecutable(100755)である" {
    while IFS= read -r name; do
        run git -C "$REPO_ROOT" ls-files -s "bin/$name"
        [ "$status" -eq 0 ]
        case "$output" in
            100755\ *) : ;;
            *)
                echo "not executable in index: bin/$name -> $output"
                return 1
                ;;
        esac
    done <<< "$(expected_names)"
}

@test "全wrapperの本文が3行exec形式に一致し対象ファイルが存在する" {
    while IFS= read -r name; do
        target="$(target_for "$name")"
        [ -n "$target" ]
        file="$REPO_ROOT/bin/$name"
        [ -f "$file" ]

        line1=$(sed -n '1p' "$file")
        [ "$line1" = "#!/usr/bin/env bash" ]

        line3=$(sed -n '3p' "$file")
        expected_line3="exec bash \"\$(dirname \"\$0\")/../$target\" \"\$@\""
        [ "$line3" = "$expected_line3" ]

        [ -f "$REPO_ROOT/$target" ]
    done <<< "$(expected_names)"
}

@test "detect-stackがbin経由bare名で機能透過する" {
    d="$(mktemp -d "${TMPDIR:-/tmp}/binwrap-XXXXXX")"
    TEST_TMP_DIRS+=("$d")
    run bash "$REPO_ROOT/bin/detect-stack" "$d"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.frameworks | type == "array"'
}

@test "ac-lintがbin経由bare名で引数とexit codeを透過する(成功系)" {
    f="$(mktemp "${TMPDIR:-/tmp}/binwrap-ac-XXXXXX")"
    TEST_TMP_DIRS+=("$f")
    printf '## 受け入れ基準\n- [ ] x\n' > "$f"
    run bash "$REPO_ROOT/bin/ac-lint" "$f"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.verdict == "t1"'
}

@test "ac-lintがbin経由bare名でエラー経路を透過する(引数なし)" {
    run bash "$REPO_ROOT/bin/ac-lint"
    [ "$status" -eq 1 ]
    echo "$output" | jq -e '.ok == false'
}
