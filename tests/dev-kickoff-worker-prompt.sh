#!/usr/bin/env bash
# AC2: .claude/agents/dev-kickoff-worker.md の frontmatter と body 必須要素を検証
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_FILE="$REPO_ROOT/.claude/agents/dev-kickoff-worker.md"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "PASS: $1"; }

# Case 1: file exists
[[ -f "$WORKER_FILE" ]] || fail "Case 1: $WORKER_FILE not found"
pass "Case 1: worker definition file exists"

# Extract frontmatter (between first '---' and second '---')
FRONTMATTER=$(awk '/^---$/{c++; next} c==1' "$WORKER_FILE")
BODY=$(awk '/^---$/{c++; next} c>=2' "$WORKER_FILE")

# Case 2a: name field
echo "$FRONTMATTER" | grep -qE '^name:[[:space:]]*dev-kickoff-worker[[:space:]]*$' \
    || fail "Case 2a: name field must be 'dev-kickoff-worker'"
pass "Case 2a: name: dev-kickoff-worker"

# Case 2b: description field
echo "$FRONTMATTER" | grep -qE '^description:' \
    || fail "Case 2b: description field missing"
pass "Case 2b: description field present"

# Case 2c: isolation: worktree
echo "$FRONTMATTER" | grep -qE '^isolation:[[:space:]]*worktree[[:space:]]*$' \
    || fail "Case 2c: isolation: worktree missing"
pass "Case 2c: isolation: worktree"

# Case 2d: permissionMode: auto (classifier-based auto-approval for worktree isolation)
echo "$FRONTMATTER" | grep -qE '^permissionMode:[[:space:]]*auto[[:space:]]*$' \
    || fail "Case 2d: permissionMode: auto missing"
pass "Case 2d: permissionMode: auto"

# Case 2e: tools includes Bash, Read, Write, Edit
echo "$FRONTMATTER" | grep -qE 'Bash' \
    || fail "Case 2e: tools must include Bash"
echo "$FRONTMATTER" | grep -qE 'Read' \
    || fail "Case 2e: tools must include Read"
echo "$FRONTMATTER" | grep -qE 'Write' \
    || fail "Case 2e: tools must include Write"
echo "$FRONTMATTER" | grep -qE 'Edit' \
    || fail "Case 2e: tools must include Edit"
pass "Case 2e: tools include Bash/Read/Write/Edit"

# Case 3: body mentions branch checkout (git checkout -b)
echo "$BODY" | grep -qiE 'git[[:space:]]+checkout[[:space:]]+-b' \
    || fail "Case 3: body must mention 'git checkout -b' step"
pass "Case 3: body documents branch checkout"

# Case 4: body documents return JSON contract (status / branch / commit_sha)
echo "$BODY" | grep -qE '"status"' \
    || fail "Case 4a: body should mention status field"
echo "$BODY" | grep -qE '"branch"' \
    || fail "Case 4b: body should mention branch field"
echo "$BODY" | grep -qiE '(commit_sha|commit sha)' \
    || fail "Case 4c: body should mention commit_sha"
pass "Case 4: return JSON contract documented (status/branch/commit_sha)"

echo "OK: tests/dev-kickoff-worker-prompt.sh"
