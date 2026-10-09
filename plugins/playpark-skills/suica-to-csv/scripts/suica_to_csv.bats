#!/usr/bin/env bats
# Tests for suica-to-csv/scripts/suica_to_csv.py argument handling.

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/suica_to_csv.py"
    INPUT="$BATS_TEST_TMPDIR/transactions.txt"
    printf '%s\n' '10 01 入 新橋 出 大崎 -200' '10 02 ﾊﾞｽ等 神奈中 -180' > "$INPUT"
    WORKDIR="$BATS_TEST_TMPDIR/work"
    mkdir -p "$WORKDIR"
    cd "$WORKDIR"
}

@test "-o writes the CSV to the given path instead of CWD" {
    out="$BATS_TEST_TMPDIR/out/expenses.csv"
    mkdir -p "$(dirname "$out")"
    run python3 "$SCRIPT" "$INPUT" --start-year 2025 --end-year 2025 -o "$out"
    [ "$status" -eq 0 ]
    [ -f "$out" ]
    [ ! -e "$WORKDIR/suica_transactions.csv" ]
    grep -q '^2025/10/01,JR東日本,電車代,200,' "$out"
    grep -q '^2025/10/02,神奈中バス,バス代,180,' "$out"
}

@test "without -o the CSV goes to CWD/suica_transactions.csv" {
    run python3 "$SCRIPT" "$INPUT" --start-year 2025 --end-year 2025
    [ "$status" -eq 0 ]
    [ -f "$WORKDIR/suica_transactions.csv" ]
}

@test "unknown argument exits non-zero and writes nothing" {
    run python3 "$SCRIPT" "$INPUT" --start-year 2025 --end-year 2025 --output-file x.csv
    [ "$status" -ne 0 ]
    [[ "$output" == *"unrecognized arguments"* ]]
    [ ! -e "$WORKDIR/suica_transactions.csv" ]
    [ ! -e "$WORKDIR/x.csv" ]
}
