#!/usr/bin/env bats
# Tests for seed-refresh/scripts/refresh_seed_cache.py
#
# Strategy: point $HOME at an isolated sandbox directory and place stub
# python scripts under $HOME/.claude/skills/{repo-export,repo-commit,repo-issue,repo-pr}/scripts/
# (the paths refresh_seed_cache.py hardcodes via REPO_EXPORT_SCRIPT etc).
# A stub `gh` is injected via PATH to answer the "latest commit date" /
# "default branch" lookups deterministically. The export stub logs its argv
# and, controlled by env vars, emits `TOKENS_RAW=`/`TOKENS=` stdout lines so
# the token-recording contract can be verified without real repomix/network.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/seed-refresh/scripts/refresh_seed_cache.py"

    export HOME="$BATS_TEST_TMPDIR/home"
    mkdir -p "$HOME"
    for skill_dir in repo-export repo-commit repo-issue repo-pr; do
        mkdir -p "$HOME/.claude/skills/$skill_dir/scripts"
    done

    EXPORT_CALLS_LOG="$BATS_TEST_TMPDIR/export_calls.log"
    rm -f "$EXPORT_CALLS_LOG"
    export EXPORT_CALLS_LOG
    EXPORT_EXIT_CODE=0
    EXPORT_EMIT_TOKENS=1
    export EXPORT_EXIT_CODE EXPORT_EMIT_TOKENS

    cat > "$HOME/.claude/skills/repo-export/scripts/export_repo.py" << 'EOF'
#!/usr/bin/env python3
import os
import sys

args = sys.argv[1:]
with open(os.environ["EXPORT_CALLS_LOG"], "a") as f:
    f.write(" ".join(args) + "\n")

out = None
for i, a in enumerate(args):
    if a == "-o" and i + 1 < len(args):
        out = args[i + 1]
if out:
    with open(out, "w") as f:
        f.write("# dummy exported\n")

if os.environ.get("EXPORT_EMIT_TOKENS", "1") == "1":
    print("TOKENS_RAW=10000")
    print("TOKENS=4000")

sys.exit(int(os.environ.get("EXPORT_EXIT_CODE", "0")))
EOF
    chmod +x "$HOME/.claude/skills/repo-export/scripts/export_repo.py"

    cat > "$HOME/.claude/skills/repo-commit/scripts/export_commit.py" << 'EOF'
#!/usr/bin/env python3
import sys
args = sys.argv[1:]
out = None
for i, a in enumerate(args):
    if a == "-o" and i + 1 < len(args):
        out = args[i + 1]
if out:
    with open(out, "w") as f:
        f.write("# dummy commits\n")
sys.exit(0)
EOF
    chmod +x "$HOME/.claude/skills/repo-commit/scripts/export_commit.py"

    cat > "$HOME/.claude/skills/repo-issue/scripts/export_issue.py" << 'EOF'
#!/usr/bin/env python3
import sys
args = sys.argv[1:]
out = None
for i, a in enumerate(args):
    if a == "-o" and i + 1 < len(args):
        out = args[i + 1]
if out:
    with open(out, "w") as f:
        f.write("# dummy issues\n")
sys.exit(0)
EOF
    chmod +x "$HOME/.claude/skills/repo-issue/scripts/export_issue.py"

    cat > "$HOME/.claude/skills/repo-pr/scripts/export_pr.py" << 'EOF'
#!/usr/bin/env python3
import sys
args = sys.argv[1:]
out = None
for i, a in enumerate(args):
    if a == "-o" and i + 1 < len(args):
        out = args[i + 1]
if out:
    with open(out, "w") as f:
        f.write("# dummy pr-summary\n")
sys.exit(0)
EOF
    chmod +x "$HOME/.claude/skills/repo-pr/scripts/export_pr.py"

    STUB_BIN_DIR="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$STUB_BIN_DIR"
    cat > "$STUB_BIN_DIR/gh" << 'EOF'
#!/usr/bin/env bash
if [[ "$1" == "api" ]]; then
    path="$2"
    if [[ "$path" == *"/commits/"* ]]; then
        echo "2099-01-01T00:00:00Z"
        exit 0
    fi
    echo "main"
    exit 0
fi
exit 1
EOF
    chmod +x "$STUB_BIN_DIR/gh"
    export PATH="$STUB_BIN_DIR:$PATH"

    SEED_DIR="$BATS_TEST_TMPDIR/seed/owner-repo"
    mkdir -p "$SEED_DIR"
    MANIFEST="$SEED_DIR/manifest.json"
    cat > "$MANIFEST" << 'EOF'
{
  "source": "https://github.com/owner/repo",
  "exportedAt": "2020-01-01T00:00:00Z"
}
EOF
}

@test "export command does not include --compress" {
    # Live smoke on octocat/Hello-World (F3, see
    # .devflow-tmp/repomix-format-verification.md) showed compression did not
    # reduce tokens for that repo, so --compress was removed from the export
    # command per the plan's fallback rule.
    run python3 "$SCRIPT" --seed "$SEED_DIR" --branch main
    [ "$status" -eq 0 ]
    [ -f "$EXPORT_CALLS_LOG" ]
    run grep -c -- "--compress" "$EXPORT_CALLS_LOG"
    [ "$output" -eq 0 ]
}

@test "manifest records exportTokens/exportTokensRaw/exportTokenReductionPct and updates exportedAt" {
    run python3 "$SCRIPT" --seed "$SEED_DIR" --branch main
    [ "$status" -eq 0 ]

    tokens=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['exportTokens'])")
    tokens_raw=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['exportTokensRaw'])")
    reduction=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['exportTokenReductionPct'])")
    exported_at=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['exportedAt'])")

    [ "$tokens" = "4000" ]
    [ "$tokens_raw" = "10000" ]
    [ "$reduction" = "60.0" ]
    [ "$exported_at" != "2020-01-01T00:00:00Z" ]
}

@test "missing TOKENS lines: no token keys written, status stays refreshed, warning printed" {
    EXPORT_EMIT_TOKENS=0
    export EXPORT_EMIT_TOKENS
    run python3 "$SCRIPT" --seed "$SEED_DIR" --branch main
    [ "$status" -eq 0 ]
    [[ "$output" == *"refreshed"* ]]
    [[ "$output" == *"token_metrics_unavailable"* ]]

    has_tokens=$(python3 -c "import json;print('exportTokens' in json.load(open('$MANIFEST')))")
    has_tokens_raw=$(python3 -c "import json;print('exportTokensRaw' in json.load(open('$MANIFEST')))")
    has_reduction=$(python3 -c "import json;print('exportTokenReductionPct' in json.load(open('$MANIFEST')))")
    [ "$has_tokens" = "False" ]
    [ "$has_tokens_raw" = "False" ]
    [ "$has_reduction" = "False" ]
}

@test "export command failure yields status=error" {
    EXPORT_EXIT_CODE=1
    export EXPORT_EXIT_CODE
    run python3 "$SCRIPT" --seed "$SEED_DIR" --branch main
    [[ "$output" == *"[error]"* ]]
}

@test "--dry-run leaves manifest unchanged" {
    run python3 "$SCRIPT" --seed "$SEED_DIR" --branch main --dry-run
    [ "$status" -eq 0 ]
    exported_at=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['exportedAt'])")
    [ "$exported_at" = "2020-01-01T00:00:00Z" ]
    has_tokens=$(python3 -c "import json;print('exportTokens' in json.load(open('$MANIFEST')))")
    [ "$has_tokens" = "False" ]
    [ ! -f "$EXPORT_CALLS_LOG" ]
}

@test "default: exported.md export passes seed default tests-exclusion --ignore" {
    run python3 "$SCRIPT" --seed "$SEED_DIR" --branch main
    [ "$status" -eq 0 ]
    [ -f "$EXPORT_CALLS_LOG" ]
    run grep -qF -- "--ignore **/[Tt]ests/**,**/*.test.*,**/*.spec.*,**/__tests__/**,**/testdata/**,**/__snapshots__/**,**/fixtures/**" "$EXPORT_CALLS_LOG"
    [ "$status" -eq 0 ]
}

@test "opt-out: manifest includeTests=true disables the default --ignore" {
    cat > "$MANIFEST" << 'EOF'
{
  "source": "https://github.com/owner/repo",
  "exportedAt": "2020-01-01T00:00:00Z",
  "includeTests": true
}
EOF
    run python3 "$SCRIPT" --seed "$SEED_DIR" --branch main
    [ "$status" -eq 0 ]
    run grep -c -- "--ignore" "$EXPORT_CALLS_LOG"
    [ "$output" -eq 0 ]
}

@test "includeTests=false explicit: default --ignore still applied" {
    cat > "$MANIFEST" << 'EOF'
{
  "source": "https://github.com/owner/repo",
  "exportedAt": "2020-01-01T00:00:00Z",
  "includeTests": false
}
EOF
    run python3 "$SCRIPT" --seed "$SEED_DIR" --branch main
    [ "$status" -eq 0 ]
    [ -f "$EXPORT_CALLS_LOG" ]
    run grep -qF -- "--ignore **/[Tt]ests/**,**/*.test.*,**/*.spec.*,**/__tests__/**,**/testdata/**,**/__snapshots__/**,**/fixtures/**" "$EXPORT_CALLS_LOG"
    [ "$status" -eq 0 ]
}

@test "invalid includeTests type yields status=error, no export invoked, exit 2" {
    cat > "$MANIFEST" << 'EOF'
{
  "source": "https://github.com/owner/repo",
  "exportedAt": "2020-01-01T00:00:00Z",
  "includeTests": "yes"
}
EOF
    run python3 "$SCRIPT" --seed "$SEED_DIR" --branch main
    [ "$status" -eq 2 ]
    [[ "$output" == *"[error]"* ]]
    [[ "$output" == *"invalid_includeTests"* ]]
    [ ! -f "$EXPORT_CALLS_LOG" ]
}
