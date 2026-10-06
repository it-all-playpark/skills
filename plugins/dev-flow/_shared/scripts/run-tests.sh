#!/usr/bin/env bash
# run-tests.sh - Validate（test#i）・post-eval・test#final のテスト実行 exec-proxy（issue #821）。
# Usage: run-tests.sh <worktree>
#
# green 判定を LLM の解釈ではなく exit code から決める。呼び出し側 agent は stdout の JSON 1 行を
# verbatim で転写するだけで、スクリプトの選択・起動失敗の分類・failed_files の抽出はここで行う。
#
# 手順:
#   1. workspace-prebuild.sh <WT>（pnpm ワークスペースのビルド成果物をテストの直前に作り直す）。
#      status "failed" のときはテストを 1 本も実行せず status "failed"（reason を summary の先頭に置く）。
#      それ以外（built / skipped / JSON でない）はビルドを再試行せずテストへ進む。
#   2. <WT>/tests/run-*.sh のうち実行ビットを持つ通常ファイルを全本、名前順に絶対パスの bare 形で直列実行する
#      （1 本だけ選ぶと残りのランナーの回帰が CI まで検出されない。並列化しない — repo によっては共有資源を使う）。
#   3. tests/run-*.sh が 1 本も無いときだけ、検出したフォールバック（pnpm / yarn / npm test・cargo test・
#      go test・pytest）を <WT> で全部実行する。何も無ければ tests "no_tests"。
#   リトライ・環境の自動修復はしない（起動失敗は環境要因で、同じ操作の繰り返しや store / ロックの操作では直らない）。
#
# status は全 script の exit code だけで決まる: 起動失敗（exit 126 / 127）が 1 本でもあれば "error"、
# それ以外で exit 非 0 が 1 本でもあれば "failed"、全本 0（0 本を含む）なら "passed"。
# tests / green は workflow の GREEN schema の必須キーで、status から機械的に写す（agent に組み立てさせない）:
#   passed → tests "passed" green true / failed → "failed" false / error → "error" false /
#   実行対象 0 本 → status "passed"・tests "no_tests"・green false（何も走っていないので green を主張しない）
#
# failed_files（status "failed" のときだけ非空になりうる）: exit 非 0 の script の出力から、bats の `not ok` 行
# （直後の診断行 `# (in test file <path>, line N)` のパス）と vitest / jest の `FAIL <path>` 行を抽出し、
# <WT> 相対にして重複なく並べる。exit 非 0 の script から 1 件も抽出できない・ファイルに結び付かない
# `not ok` がある・ビルド失敗のときは空配列にする — 一部だけ列挙すると、base でも落ちる既存の失敗の
# 切り分け（base-failure-triage）が結び付かない失敗を見落として green に倒しうるため。
#
# 出力（stdout, JSON 1 行。各 script の出力は $TMPDIR のログに残し stdout に混ぜない — Bash tool の出力上限で
# JSON 行が切れないように、stderr にも 1 script 1 行の要約だけを出す）:
#   {"status":"passed|failed|error","tests":"passed|failed|error|no_tests","green":bool,"summary":"...",
#    "scripts":[{"path":"...","exit":N,"launch_failed":bool}],"failed_files":[...],"epoch":N}
# exit: JSON を出力したら 0（判定は JSON の status）/ 引数不正は 2（status "error" の JSON を出す）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREBUILD="$SCRIPT_DIR/workspace-prebuild.sh"
SUMMARY_MAX=4000
LINES_MAX=30

emit() {
    # $1 status / $2 tests / $3 green / $4 summary / $5 scripts JSON / $6 failed_files JSON
    jq -nc --arg s "$1" --arg t "$2" --argjson g "$3" --arg m "${4:0:$SUMMARY_MAX}" \
        --argjson sc "$5" --argjson ff "$6" --argjson e "$(date +%s)" \
        '{status: $s, tests: $t, green: $g, summary: $m, scripts: $sc, failed_files: $ff, epoch: $e}'
}

if [[ $# -ne 1 ]]; then
    emit error error false "usage: run-tests <worktree>" '[]' '[]'
    exit 2
fi
WT=$(cd "$1" 2>/dev/null && pwd) || { emit error error false "cd failed: $1" '[]' '[]'; exit 2; }
WT_PHYS=$(cd "$WT" && pwd -P)
# テスト script・フォールバックとも <WT> を cwd にして実行する
cd "$WT" || { emit error error false "cd failed: $WT" '[]' '[]'; exit 2; }

LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/run-tests-XXXXXX") \
    || { emit error error false "cannot create log dir under ${TMPDIR:-/tmp}" '[]' '[]'; exit 0; }

# 1. workspace-prebuild
PREBUILD_OUT=$(bash "$PREBUILD" "$WT" 2>"$LOG_DIR/prebuild.log")
if [[ "$(jq -r '.status? // empty' <<< "$PREBUILD_OUT" 2>/dev/null)" == "failed" ]]; then
    reason=$(jq -r '.reason // "workspace build failed"' <<< "$PREBUILD_OUT")
    echo "[run-tests] workspace-prebuild failed — tests not run (log: $LOG_DIR/prebuild.log)" >&2
    emit failed failed false "$reason"$'\n'"$(tail -n "$LINES_MAX" "$LOG_DIR/prebuild.log")" '[]' '[]'
    exit 0
fi

# 2. 実行対象: tests/run-*.sh（実行ビットあり）、無ければフォールバック
TARGETS=()   # 表示・JSON 用の path
COMMANDS=()  # 実行内容（run-*.sh は空 = path を bare 実行、フォールバックはコマンド文字列）
shopt -s nullglob
CANDIDATES=("$WT"/tests/run-*.sh)
shopt -u nullglob
if [[ ${#CANDIDATES[@]} -gt 0 ]]; then
    while IFS= read -r f; do
        [[ -f "$f" && -x "$f" ]] || continue
        TARGETS+=("$f")
        COMMANDS+=("")
    done <<< "$(printf '%s\n' "${CANDIDATES[@]}" | LC_ALL=C sort)"
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
    if [[ -f "$WT/package.json" ]] && jq -e '.scripts.test | type == "string" and length > 0' "$WT/package.json" >/dev/null 2>&1; then
        if [[ -f "$WT/pnpm-lock.yaml" ]]; then pm=pnpm
        elif [[ -f "$WT/yarn.lock" ]]; then pm=yarn
        else pm=npm
        fi
        TARGETS+=("$pm test"); COMMANDS+=("$pm test")
    fi
    if [[ -f "$WT/Cargo.toml" ]]; then
        TARGETS+=("cargo test"); COMMANDS+=("cargo test")
    fi
    if [[ -f "$WT/go.mod" ]]; then
        TARGETS+=("go test ./..."); COMMANDS+=("go test ./...")
    fi
    if [[ -f "$WT/pytest.ini" || -f "$WT/conftest.py" ]] \
        || grep -qs '^\[tool\.pytest' "$WT/pyproject.toml" \
        || grep -qs '^\[tool:pytest\]' "$WT/setup.cfg" \
        || grep -qs '^\[pytest\]' "$WT/tox.ini"; then
        TARGETS+=("pytest"); COMMANDS+=("pytest")
    fi
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
    emit passed no_tests false "no tests/run-*.sh and no fallback test runner (package.json scripts.test / Cargo.toml / go.mod / pytest config)" '[]' '[]'
    exit 0
fi

# 出力から失敗したテストファイルを抽出する。1 行 1 パス。結び付かない `not ok` があれば "\t" 行を出す。
extract_failed_files() {
    LC_ALL=C sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$1" | LC_ALL=C awk '
        function flush() { if (pending) print "\t"; pending = 0 }
        /^not ok / { flush(); pending = 1; next }
        /^ok / { flush(); next }
        pending && match($0, /in test file .*, line [0-9]+\)/) {
            s = substr($0, RSTART + 13, RLENGTH - 13)
            sub(/, line [0-9]+\)$/, "", s)
            print s; pending = 0; next
        }
        /^[ \t]*FAIL[ \t]+/ {
            line = $0
            sub(/^[ \t]*FAIL[ \t]+/, "", line)
            n = split(line, tok, /[ \t]+/)
            i = 1
            if (tok[1] ~ /^\|.*\|$/) i = 2
            if (i <= n && tok[i] != "") print tok[i]
            next
        }
        END { flush() }
    '
}

to_rel() {
    local p="$1"
    p="${p#"$WT"/}"
    p="${p#"$WT_PHYS"/}"
    printf '%s\n' "${p#./}"
}

# 3. 直列実行
SCRIPTS_JSON='[]'
FAILED_LIST=""
UNATTRIBUTED=false
LAUNCH_FAILED_ANY=false
NONZERO_ANY=false
SUMMARY_HEAD=""
SUMMARY_BODY=""
for i in "${!TARGETS[@]}"; do
    target="${TARGETS[$i]}"
    log="$LOG_DIR/$i.log"
    if [[ -z "${COMMANDS[$i]}" ]]; then
        "$target" > "$log" 2>&1 < /dev/null
        rc=$?
    else
        read -r -a cmd <<< "${COMMANDS[$i]}"
        "${cmd[@]}" > "$log" 2>&1 < /dev/null
        rc=$?
    fi
    launch=false
    if [[ $rc -eq 126 || $rc -eq 127 ]]; then
        launch=true
        LAUNCH_FAILED_ANY=true
    fi
    echo "[run-tests] $target exit=$rc launch_failed=$launch (log: $log)" >&2
    SCRIPTS_JSON=$(jq -c --arg p "$target" --argjson e "$rc" --argjson l "$launch" \
        '. + [{path: $p, exit: $e, launch_failed: $l}]' <<< "$SCRIPTS_JSON")
    [[ $rc -eq 0 ]] && continue
    NONZERO_ANY=true
    if [[ "$launch" == true ]]; then
        SUMMARY_HEAD+="launch failed: $target (exit $rc, log: $log)"$'\n'
        SUMMARY_BODY+="--- $target"$'\n'"$(tail -n 5 "$log")"$'\n'
        continue
    fi
    SUMMARY_HEAD+="failed: $target (exit $rc, log: $log)"$'\n'
    found=$(extract_failed_files "$log")
    if [[ -z "$found" ]] || grep -q $'^\t$' <<< "$found"; then
        UNATTRIBUTED=true
    fi
    while IFS= read -r p; do
        [[ -n "$p" && "$p" != $'\t' ]] || continue
        FAILED_LIST+="$(to_rel "$p")"$'\n'
    done <<< "$found"
    fail_lines=$(LC_ALL=C sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$log" | LC_ALL=C grep -E '^(not ok |[[:space:]]*FAIL[[:space:]])' | head -n "$LINES_MAX")
    [[ -n "$fail_lines" ]] || fail_lines=$(tail -n "$LINES_MAX" "$log")
    SUMMARY_BODY+="--- $target"$'\n'"$fail_lines"$'\n'
done

FAILED_JSON='[]'
if [[ "$LAUNCH_FAILED_ANY" == false && "$NONZERO_ANY" == true && "$UNATTRIBUTED" == false && -n "$FAILED_LIST" ]]; then
    FAILED_JSON=$(printf '%s' "$FAILED_LIST" | awk 'NF && !seen[$0]++' | jq -R . | jq -sc .)
fi

if [[ "$LAUNCH_FAILED_ANY" == true ]]; then
    emit error error false "$SUMMARY_HEAD$SUMMARY_BODY" "$SCRIPTS_JSON" '[]'
elif [[ "$NONZERO_ANY" == true ]]; then
    emit failed failed false "$SUMMARY_HEAD$SUMMARY_BODY" "$SCRIPTS_JSON" "$FAILED_JSON"
else
    names=$(jq -r '[.[].path] | join(", ")' <<< "$SCRIPTS_JSON")
    emit passed passed true "passed: $names" "$SCRIPTS_JSON" '[]'
fi
exit 0
