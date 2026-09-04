#!/usr/bin/env bash
# Test suite for pretool-bash-inline-commit-gate.sh
#
# Usage: bash pretool-bash-inline-commit-gate.test.sh
#
# Exit 0 on all pass, non-zero otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SCRIPT_DIR}/pretool-bash-inline-commit-gate.sh"

if [[ ! -x ${HOOK} ]]; then
  echo "FAIL: hook not executable: ${HOOK}" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node not found in PATH; cannot run fixture stubs" >&2
  exit 0
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pretool-bash-inline-commit-gate-test.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# --- fixture: repoA — sync-inlines.mjs stub that succeeds on --check ---
REPO_A="$WORK_DIR/repoA"
mkdir -p "$REPO_A/tools"
git init -q "$REPO_A"
git -C "$REPO_A" config user.email "test@example.com"
git -C "$REPO_A" config user.name "Test User"
cat >"$REPO_A/tools/sync-inlines.mjs" <<'EOF'
if (process.argv.includes("--check")) {
  process.exit(0);
}
process.exit(1);
EOF

# --- fixture: repoB — sync-inlines.mjs stub that fails on --check ---
REPO_B="$WORK_DIR/repoB"
mkdir -p "$REPO_B/tools"
git init -q "$REPO_B"
git -C "$REPO_B" config user.email "test@example.com"
git -C "$REPO_B" config user.name "Test User"
cat >"$REPO_B/tools/sync-inlines.mjs" <<'EOF'
if (process.argv.includes("--check")) {
  console.error("inline out of sync: .claude/workflows/example.js");
  process.exit(1);
}
process.exit(0);
EOF

# --- fixture: repoC — no tools/sync-inlines.mjs at all ---
REPO_C="$WORK_DIR/repoC"
mkdir -p "$REPO_C"
git init -q "$REPO_C"
git -C "$REPO_C" config user.email "test@example.com"
git -C "$REPO_C" config user.name "Test User"

# --- fixture: repo 外の作業ディレクトリ ---
OUTSIDE_DIR="$WORK_DIR/outside"
mkdir -p "$OUTSIDE_DIR"

PASS=0
FAIL=0
FAILURES=()

# run_case <name> <command> <cwd> <expected: allow|deny>
run_case() {
  local name="$1"
  local cmd="$2"
  local cwd="$3"
  local expected="$4"

  local input
  input=$(jq -n --arg cmd "$cmd" --arg cwd "$cwd" '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')

  local output
  output=$(echo "$input" | bash "$HOOK" 2>&1 || true)

  local decision="allow"
  if [[ -n $output ]]; then
    decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null || echo "allow")
  fi

  if [[ $decision == "$expected" ]]; then
    PASS=$((PASS + 1))
    printf "  \033[32mPASS\033[0m %s\n" "$name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: expected=$expected got=$decision cmd=$cmd cwd=$cwd output=$output")
    printf "  \033[31mFAIL\033[0m %s (expected=%s, got=%s)\n" "$name" "$expected" "$decision"
  fi
}

# run_case_relative_cd <name> <process_cwd> <hook_cwd> <relative_cd_dir> <expected: allow|deny>
# `cd <relative_cd_dir> && git commit` を、hook プロセス自身の起動 cwd
# (process_cwd) と tool_input の `.cwd`(hook_cwd)をあえて乖離させた状態で
# 検証する。CD_DIR の解決は process_cwd ではなく hook_cwd 基準であるべき
# (session の .cwd とプロセス cwd が乖離しても fail-open で skip しない)。
run_case_relative_cd() {
  local name="$1"
  local process_cwd="$2"
  local hook_cwd="$3"
  local rel_cd_dir="$4"
  local expected="$5"

  local cmd="cd ${rel_cd_dir} && git commit -m x"
  local input
  input=$(jq -n --arg cmd "$cmd" --arg cwd "$hook_cwd" '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}')

  local output
  output=$(cd "$process_cwd" && echo "$input" | bash "$HOOK" 2>&1 || true)

  local decision="allow"
  if [[ -n $output ]]; then
    decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null || echo "allow")
  fi

  if [[ $decision == "$expected" ]]; then
    PASS=$((PASS + 1))
    printf "  \033[32mPASS\033[0m %s\n" "$name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: expected=$expected got=$decision cmd=$cmd process_cwd=$process_cwd hook_cwd=$hook_cwd output=$output")
    printf "  \033[31mFAIL\033[0m %s (expected=%s, got=%s)\n" "$name" "$expected" "$decision"
  fi
}

# run_case_no_cwd <name> <tool_name_json> <expected: allow|deny>
# tool_name が Bash 以外の入力を、cwd フィールドなしで検証する
run_case_non_bash() {
  local name="$1"
  local expected="$2"

  local input='{"tool_name":"Edit","tool_input":{"file_path":"foo.js","new_string":"git commit"}}'

  local output
  output=$(echo "$input" | bash "$HOOK" 2>&1 || true)

  local decision="allow"
  if [[ -n $output ]]; then
    decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null || echo "allow")
  fi

  if [[ $decision == "$expected" ]]; then
    PASS=$((PASS + 1))
    printf "  \033[32mPASS\033[0m %s\n" "$name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: expected=$expected got=$decision output=$output")
    printf "  \033[31mFAIL\033[0m %s (expected=%s, got=%s)\n" "$name" "$expected" "$decision"
  fi
}

echo "=== pretool-bash-inline-commit-gate tests ==="

echo "[Deny cases — sync-inlines --check fails]"
run_case "cwd=repoB, git commit" 'git commit -m x' "$REPO_B" "deny"
run_case "outside cwd, git -C repoB commit" "git -C ${REPO_B} commit -m x" "$OUTSIDE_DIR" "deny"
run_case "cd repoB && git commit" "cd ${REPO_B} && git commit -m x" "$OUTSIDE_DIR" "deny"
run_case_relative_cd "process cwd != .cwd, relative cd repoB && git commit" "$OUTSIDE_DIR" "$WORK_DIR" "repoB" "deny"

echo "[Allow (pass-through) cases]"
run_case "cwd=repoA, git commit (check succeeds)" 'git commit -m x' "$REPO_A" "allow"
run_case "cwd=repoC, git commit (no sync-inlines.mjs)" 'git commit -m x' "$REPO_C" "allow"
run_case "cwd=repoB, git status" 'git status' "$REPO_B" "allow"
run_case "cwd=repoB, git push origin main" 'git push origin main' "$REPO_B" "allow"
run_case "repo外 cwd, git commit" 'git commit -m x' "$OUTSIDE_DIR" "allow"
run_case "cwd=repoB, git log --grep commit (subcommand=log)" 'git log --grep commit' "$REPO_B" "allow"
run_case_relative_cd "process cwd != .cwd, relative cd repoA && git commit" "$OUTSIDE_DIR" "$WORK_DIR" "repoA" "allow"
run_case_relative_cd "process cwd == .cwd, relative cd repoB && git commit (regression)" "$WORK_DIR" "$WORK_DIR" "repoB" "deny"
run_case_non_bash "tool_name=Edit is pass-through" "allow"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
if ((FAIL > 0)); then
  printf '\n'
  printf 'Failures:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
  exit 1
fi
exit 0
