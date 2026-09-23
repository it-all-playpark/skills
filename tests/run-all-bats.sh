#!/usr/bin/env bash
# run-all-bats.sh - Discover and execute all .bats test files in the repo.
#
# Usage: run-all-bats.sh [--strict]
#
# Behavior:
#   - Discovers `**/*.bats` files under the repository root, excluding
#     `.git`, `node_modules`, `.serena`, `.system`, `.agents`, and worktree dirs.
#   - If `bats` is not installed:
#       - Default mode: prints a warning and exits 0 (graceful skip in
#         environments that don't have bats yet).
#       - `--strict` mode: exits 1 (use this in CI to require bats).
#   - If `bats` is installed: runs the .bats files in parallel (one bats
#     process per file) and aggregates results. Each file's output is
#     buffered and printed in discovery order once all files finish, so logs
#     never interleave. Exit 0 only if all files pass; exit 1 if any test fails.
#   - Parallelism: `RUN_ALL_BATS_JOBS` (positive integer) overrides the
#     default of the online CPU count; set it to 1 to run serially. Files are
#     independent (each test uses mktemp / $BATS_TEST_TMPDIR), and serial
#     execution made dev-flow Validate spend ~7 min per full-suite pass.
#
# Designed to be called from CI (GitHub Actions) after `brew install bats-core`
# (macOS) or `apt install bats` (ubuntu).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# plugin install 時と同じ bin/ 解決環境を再現する（cross-plugin の _lib/common.sh
# locator が PATH 上の bin/journal をアンカーに解決するため、単体実行でも前置が必要）。
export PATH="$REPO_ROOT/plugins/playpark-core/bin:$REPO_ROOT/plugins/dev-flow/bin:$PATH"

STRICT=false
if [[ "${1:-}" == "--strict" ]]; then
    STRICT=true
fi

if [[ -n "${RUN_ALL_BATS_JOBS:-}" ]]; then
    if [[ ! "$RUN_ALL_BATS_JOBS" =~ ^[1-9][0-9]*$ ]]; then
        echo "[run-all-bats] RUN_ALL_BATS_JOBS must be a positive integer (got: '$RUN_ALL_BATS_JOBS')." >&2
        exit 2
    fi
    JOBS="$RUN_ALL_BATS_JOBS"
else
    JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
    [[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || JOBS=4
fi

if ! command -v bats >/dev/null 2>&1; then
    echo "[run-all-bats] bats is not installed." >&2
    echo "[run-all-bats] Install: brew install bats-core (macOS) / apt-get install bats (Ubuntu)" >&2
    if [[ "$STRICT" == true ]]; then
        echo "[run-all-bats] --strict mode: exiting 1." >&2
        exit 1
    fi
    echo "[run-all-bats] Skipping bats tests (non-strict mode)." >&2
    exit 0
fi

# Discover .bats files
mapfile -t BATS_FILES < <(
    find "$REPO_ROOT" \
        -type d \( -name ".git" -o -name "node_modules" -o -name ".serena" \
                -o -name ".system" -o -name ".agents" \
                -o -path "*/.claude/worktrees" \) -prune -o \
        -type f -name "*.bats" -print | sort
)

if [[ ${#BATS_FILES[@]} -eq 0 ]]; then
    echo "[run-all-bats] No .bats files found."
    exit 0
fi

echo "[run-all-bats] Discovered ${#BATS_FILES[@]} .bats file(s):"
for f in "${BATS_FILES[@]}"; do
    echo "  - ${f#$REPO_ROOT/}"
done
echo "[run-all-bats] Running with ${JOBS} parallel job(s)."
echo ""

RESULT_DIR="$(mktemp -d)"
trap 'rm -rf "$RESULT_DIR"' EXIT

# One bats process per file. Output goes to <index>.log and the exit code to
# <index>.rc so the report below can replay them in discovery order.
# xargs appends each (index, file) pair after the fixed "$RESULT_DIR" arg, so
# inside `bash -c` $1 is the result dir and $2/$3 are index/file.
run_one() {
    local idx="$1" file="$2" dir="$3"
    bats "$file" > "$dir/$idx.log" 2>&1
    echo "$?" > "$dir/$idx.rc"
}
export -f run_one

for i in "${!BATS_FILES[@]}"; do
    printf '%s\0%s\0' "$i" "${BATS_FILES[$i]}"
done | xargs -0 -n 2 -P "$JOBS" bash -c 'run_one "$2" "$3" "$1"' _ "$RESULT_DIR"

FAILED=()
PASSED=()
for i in "${!BATS_FILES[@]}"; do
    f="${BATS_FILES[$i]}"
    echo "=== Running: ${f#$REPO_ROOT/} ==="
    cat "$RESULT_DIR/$i.log" 2>/dev/null
    # A missing .rc (worker killed before recording) counts as a failure.
    if [[ "$(cat "$RESULT_DIR/$i.rc" 2>/dev/null)" == "0" ]]; then
        PASSED+=("$f")
    else
        FAILED+=("$f")
    fi
    echo ""
done

echo "=================================================="
echo "[run-all-bats] Summary: ${#PASSED[@]} passed, ${#FAILED[@]} failed"
echo "=================================================="

if [[ ${#FAILED[@]} -gt 0 ]]; then
    echo "Failed files:"
    for f in "${FAILED[@]}"; do
        echo "  - ${f#$REPO_ROOT/}"
    done
    exit 1
fi

exit 0
