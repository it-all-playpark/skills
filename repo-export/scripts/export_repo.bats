#!/usr/bin/env bats
# Tests for repo-export/scripts/export_repo.py
#
# Strategy: stub `repomix` via a bash script injected through REPOMIX_CMD env
# var (highest-priority resolution path in export_repo.py). The stub logs the
# argv it receives, writes dummy content to the -o output path, and emits a
# "Total Tokens: 12,345 tokens" style summary line on stdout so the token
# parsing contract can be verified deterministically.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/repo-export/scripts/export_repo.py"

    CALLS_LOG="$BATS_TEST_TMPDIR/repomix_calls.log"
    rm -f "$CALLS_LOG"

    STUB="$BATS_TEST_TMPDIR/repomix_stub.sh"
    REPOMIX_EXIT_CODE=0
    REPOMIX_EMIT_TOKENS=1
    export REPOMIX_EXIT_CODE REPOMIX_EMIT_TOKENS CALLS_LOG

    cat > "$STUB" << 'EOF'
#!/usr/bin/env bash
echo "$@" >> "$CALLS_LOG"

# find -o argument and write dummy content there
prev=""
out=""
for arg in "$@"; do
    if [[ "$prev" == "-o" ]]; then
        out="$arg"
    fi
    prev="$arg"
done
if [[ -n "$out" ]]; then
    echo "# dummy repomix output" > "$out"
fi

if [[ "${REPOMIX_EMIT_TOKENS}" == "1" ]]; then
    echo "Some summary line"
    echo "Total Tokens: 12,345 tokens"
fi

exit "${REPOMIX_EXIT_CODE}"
EOF
    chmod +x "$STUB"
    export REPOMIX_CMD="$STUB"

    OUT_FILE="$BATS_TEST_TMPDIR/out.md"
}

@test "short form owner/repo normalized to https url" {
    run python3 "$SCRIPT" owner/repo -o "$OUT_FILE"
    [ "$status" -eq 0 ]
    [ -f "$CALLS_LOG" ]
    grep -qF -- "--remote https://github.com/owner/repo --style markdown -o $OUT_FILE" "$CALLS_LOG"
}

@test "git@github.com ssh url normalized to https" {
    run python3 "$SCRIPT" git@github.com:owner/repo.git -o "$OUT_FILE"
    [ "$status" -eq 0 ]
    grep -qF -- "--remote https://github.com/owner/repo --style markdown -o $OUT_FILE" "$CALLS_LOG"
}

@test "-b adds --remote-branch" {
    run python3 "$SCRIPT" owner/repo -o "$OUT_FILE" -b develop
    [ "$status" -eq 0 ]
    grep -qF -- "--remote-branch develop" "$CALLS_LOG"
}

@test "-p adds --include with path and **/path/** and strips trailing slash" {
    run python3 "$SCRIPT" owner/repo -o "$OUT_FILE" -p docs/
    [ "$status" -eq 0 ]
    grep -qF -- '--include docs,**/docs/**' "$CALLS_LOG"
}

@test "default run does not pass --compress and does not emit TOKENS_RAW" {
    run python3 "$SCRIPT" owner/repo -o "$OUT_FILE"
    [ "$status" -eq 0 ]
    script_output="$output"
    run grep -c -- "--compress" "$CALLS_LOG"
    [ "$output" -eq 0 ]
    [[ "$script_output" != *"TOKENS_RAW="* ]]
}

@test "--compress runs repomix twice and emits TOKENS_RAW then TOKENS" {
    run python3 "$SCRIPT" owner/repo -o "$OUT_FILE" --compress
    [ "$status" -eq 0 ]

    call_count=$(wc -l < "$CALLS_LOG" | tr -d ' ')
    [ "$call_count" -eq 2 ]

    first_call=$(sed -n '1p' "$CALLS_LOG")
    second_call=$(sed -n '2p' "$CALLS_LOG")

    [[ "$first_call" != *"--compress"* ]]
    [[ "$second_call" == *"--compress"* ]]

    [[ "$output" == *"TOKENS_RAW=12345"* ]]
    [[ "$output" == *"TOKENS=12345"* ]]
}

@test "repomix failure propagates as exit 1 with stderr" {
    REPOMIX_EXIT_CODE=1
    export REPOMIX_EXIT_CODE
    run python3 "$SCRIPT" owner/repo -o "$OUT_FILE"
    [ "$status" -eq 1 ]
}

@test "missing Total Tokens line yields TOKENS=unknown" {
    REPOMIX_EMIT_TOKENS=0
    export REPOMIX_EMIT_TOKENS
    run python3 "$SCRIPT" owner/repo -o "$OUT_FILE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"TOKENS=unknown"* ]]
}

@test "invalid url without owner/repo exits 1" {
    run python3 "$SCRIPT" nopath -o "$OUT_FILE"
    [ "$status" -eq 1 ]
}

@test "--ignore passes through to repomix argv verbatim" {
    run python3 "$SCRIPT" owner/repo -o "$OUT_FILE" --ignore '**/[Tt]ests/**,**/*.test.*'
    [ "$status" -eq 0 ]
    grep -qF -- "--ignore **/[Tt]ests/**,**/*.test.*" "$CALLS_LOG"
}

@test "default run does not pass --ignore" {
    run python3 "$SCRIPT" owner/repo -o "$OUT_FILE"
    [ "$status" -eq 0 ]
    run grep -c -- "--ignore" "$CALLS_LOG"
    [ "$output" -eq 0 ]
}

@test "--compress --ignore applies --ignore to both baseline and compressed runs" {
    run python3 "$SCRIPT" owner/repo -o "$OUT_FILE" --compress --ignore '**/testdata/**'
    [ "$status" -eq 0 ]

    call_count=$(wc -l < "$CALLS_LOG" | tr -d ' ')
    [ "$call_count" -eq 2 ]

    first_call=$(sed -n '1p' "$CALLS_LOG")
    second_call=$(sed -n '2p' "$CALLS_LOG")

    [[ "$first_call" == *"--ignore **/testdata/**"* ]]
    [[ "$second_call" == *"--ignore **/testdata/**"* ]]
}
