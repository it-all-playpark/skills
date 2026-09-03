#!/usr/bin/env bats
# Tests for repo-commit/scripts/export_commit.py
#
# Strategy: stub `gh` via PATH injection ($BATS_TEST_TMPDIR/bin/gh, placed
# ahead of the real gh in PATH). The stub logs every argv it receives to
# $GH_CALLS_LOG and, for `gh api <path> ...`, dispatches on <path>:
#   - */commits/<sha>   (single commit)  -> cat fixtures/commit_<sha4>.json
#   - *?...              (commit list)   -> cat fixtures/commits.json
#   - repos/<owner>/<repo> (default branch) -> echo main
# Order matters: single-commit match is checked before the list match,
# because both paths start with the same repos/<owner>/<repo>/commits prefix.

setup() {
    SKILLS_REPO="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
    SCRIPT="$SKILLS_REPO/repo-commit/scripts/export_commit.py"

    export FIXTURE_DIR="$BATS_TEST_TMPDIR/fixtures"
    mkdir -p "$FIXTURE_DIR"

    GH_CALLS_LOG="$BATS_TEST_TMPDIR/gh_calls.log"
    rm -f "$GH_CALLS_LOG"
    export GH_CALLS_LOG
    export GH_FAIL_SHA=""

    mkdir -p "$BATS_TEST_TMPDIR/bin"
    cat > "$BATS_TEST_TMPDIR/bin/gh" << 'EOF'
#!/usr/bin/env bash
echo "$@" >> "$GH_CALLS_LOG"

if [[ "$1" != "api" ]]; then
    exit 1
fi

path="$2"
case "$path" in
    */commits/*)
        sha="${path##*/}"
        if [[ -n "$GH_FAIL_SHA" && "$sha" == "$GH_FAIL_SHA"* ]]; then
            echo "stub gh failure for $sha" >&2
            exit 1
        fi
        prefix="${sha:0:4}"
        cat "$FIXTURE_DIR/commit_${prefix}.json"
        exit 0
        ;;
    *\?*)
        cat "$FIXTURE_DIR/commits.json"
        exit 0
        ;;
    repos/*/*)
        echo "main"
        exit 0
        ;;
    *)
        exit 1
        ;;
esac
EOF
    chmod +x "$BATS_TEST_TMPDIR/bin/gh"
    export PATH="$BATS_TEST_TMPDIR/bin:$PATH"

    cat > "$FIXTURE_DIR/commits.json" << 'EOF'
[
  {
    "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "commit": {
      "author": {"name": "alice", "date": "2026-08-20T10:00:00Z"},
      "committer": {"date": "2026-08-20T10:00:00Z"},
      "message": "feat: alpha\n\nAdds the alpha feature."
    },
    "html_url": "https://github.com/owner/repo/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "parents": [
      {"sha": "0000000000000000000000000000000000000a"}
    ]
  },
  {
    "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "commit": {
      "author": {"name": "bob", "date": "2026-08-21T00:00:00Z"},
      "committer": {"date": "2026-08-21T00:00:00Z"},
      "message": "Merge pull request #1 from x/y"
    },
    "html_url": "https://github.com/owner/repo/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "parents": [
      {"sha": "0000000000000000000000000000000000000b"},
      {"sha": "0000000000000000000000000000000000000c"}
    ]
  },
  {
    "sha": "cccccccccccccccccccccccccccccccccccccc",
    "commit": {
      "author": {"name": "carol", "date": "2020-01-01T00:00:00Z"},
      "committer": {"date": "2026-08-25T00:00:00Z"},
      "message": "fix: gamma\n\nFixes the gamma bug (rebased)."
    },
    "html_url": "https://github.com/owner/repo/commit/cccccccccccccccccccccccccccccccccccccc",
    "parents": [
      {"sha": "0000000000000000000000000000000000000d"}
    ]
  },
  {
    "sha": "dddddddddddddddddddddddddddddddddddddd",
    "commit": {
      "author": {"name": "dave", "date": "2026-08-22T00:00:00Z"},
      "committer": {"date": "2026-08-22T00:00:00Z"},
      "message": "chore: delta"
    },
    "html_url": "https://github.com/owner/repo/commit/dddddddddddddddddddddddddddddddddddddd",
    "parents": [
      {"sha": "0000000000000000000000000000000000000e"}
    ]
  }
]
EOF

    cat > "$FIXTURE_DIR/commit_aaaa.json" << 'EOF'
{
  "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "files": [
    {"filename": "src/a.ts"},
    {"filename": "src/b.ts"}
  ]
}
EOF

    cat > "$FIXTURE_DIR/commit_bbbb.json" << 'EOF'
{
  "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "files": [
    {"filename": "merged.ts"}
  ]
}
EOF

    cat > "$FIXTURE_DIR/commit_cccc.json" << 'EOF'
{
  "sha": "cccccccccccccccccccccccccccccccccccccc",
  "files": null
}
EOF

    cat > "$FIXTURE_DIR/commit_dddd.json" << 'EOF'
{
  "sha": "dddddddddddddddddddddddddddddddddddddd"
}
EOF

    OUT_FILE="$BATS_TEST_TMPDIR/out.md"
}

@test "no options: 4 commits, no Files line, no Merges line, list API called once and no per-commit API" {
    run python3 "$SCRIPT" owner/repo --branch main -o "$OUT_FILE"
    [ "$status" -eq 0 ]

    heading_count=$(grep -c '^## ' "$OUT_FILE")
    [ "$heading_count" -eq 4 ]

    files_count=$(grep -c -- '^- \*\*Files\*\*:' "$OUT_FILE" || true)
    [ "$files_count" -eq 0 ]

    merges_count=$(grep -c '^Merges:' "$OUT_FILE" || true)
    [ "$merges_count" -eq 0 ]

    per_commit_calls=$(grep -c 'commits/' "$GH_CALLS_LOG" || true)
    [ "$per_commit_calls" -eq 0 ]

    [ "$(wc -l < "$GH_CALLS_LOG")" -eq 1 ]
}

@test "no options: Date line is author date" {
    run python3 "$SCRIPT" owner/repo --branch main -o "$OUT_FILE"
    [ "$status" -eq 0 ]

    grep -A5 '^## fix: gamma' "$OUT_FILE" | grep -q -- '- \*\*Date\*\*: 2020-01-01 00:00'
}

@test "--since 45d: list API url carries since=<now-45d> in Zulu" {
    run python3 "$SCRIPT" owner/repo --branch main --since 45d -o "$OUT_FILE"
    [ "$status" -eq 0 ]

    since_value=$(grep -o 'since=[0-9TZ:-]*' "$GH_CALLS_LOG" | head -1 | cut -d= -f2)
    [ -n "$since_value" ]

    run python3 -c "
import sys
from datetime import datetime, timezone
value = datetime.fromisoformat(sys.argv[1].replace('Z', '+00:00'))
now = datetime.now(timezone.utc)
diff = abs((now - value).total_seconds() - 45 * 86400)
sys.exit(0 if diff <= 60 else 1)
" "$since_value"
    [ "$status" -eq 0 ]

    grep -q "Since: $since_value" "$OUT_FILE"
}

@test "--since 2026-07-01: keeps T00:00:00Z suffix (backward compatible)" {
    run python3 "$SCRIPT" owner/repo --branch main --since 2026-07-01 -o "$OUT_FILE"
    [ "$status" -eq 0 ]

    grep -q 'since=2026-07-01T00:00:00Z' "$GH_CALLS_LOG"
    grep -q 'Since: 2026-07-01T00:00:00Z' "$OUT_FILE"
}

@test "--since bogus: exit 1 with Invalid --since" {
    run python3 "$SCRIPT" owner/repo --branch main --since bogus -o "$OUT_FILE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Invalid --since"* ]]
}

@test "--no-merges: merge commit excluded and Total Commits reflects it" {
    run python3 "$SCRIPT" owner/repo --branch main --no-merges -o "$OUT_FILE"
    [ "$status" -eq 0 ]

    ! grep -q '^## Merge pull request' "$OUT_FILE"
    grep -q 'Total Commits: 3' "$OUT_FILE"
    grep -q '^Merges: excluded' "$OUT_FILE"
    [[ "$output" == *"Found 3 commits"* ]]
}

@test "--files: Files line per commit; null and missing files yield (none)" {
    run python3 "$SCRIPT" owner/repo --branch main --files -o "$OUT_FILE"
    [ "$status" -eq 0 ]

    grep -A5 '^## feat: alpha' "$OUT_FILE" | grep -q -- '- \*\*Files\*\*: src/a.ts, src/b.ts'
    grep -A5 '^## fix: gamma' "$OUT_FILE" | grep -q -- '- \*\*Files\*\*: (none)'
    grep -A5 '^## chore: delta' "$OUT_FILE" | grep -q -- '- \*\*Files\*\*: (none)'

    per_commit_calls=$(grep -c 'commits/' "$GH_CALLS_LOG")
    [ "$per_commit_calls" -eq 4 ]
}

@test "--since 45d --no-merges --files combined" {
    run python3 "$SCRIPT" owner/repo --branch main --since 45d --no-merges --files -o "$OUT_FILE"
    [ "$status" -eq 0 ]

    heading_count=$(grep -c '^## ' "$OUT_FILE")
    [ "$heading_count" -eq 3 ]

    ! grep -q 'commits/bbbb' "$GH_CALLS_LOG"

    files_count=$(grep -c -- '^- \*\*Files\*\*:' "$OUT_FILE")
    [ "$files_count" -eq 3 ]

    grep -q 'since=' "$GH_CALLS_LOG"
}

@test "resolve_since unit: 45d / YYYY-MM-DD / ISO" {
    run python3 -c "
import sys
sys.path.insert(0, '$(dirname "$SCRIPT")')
from datetime import datetime, timezone
from export_commit import resolve_since

now = datetime(2026, 9, 2, 12, 0, tzinfo=timezone.utc)
assert resolve_since('45d', now) == '2026-07-19T12:00:00Z', resolve_since('45d', now)
assert resolve_since('2026-07-01', now) == '2026-07-01T00:00:00Z', resolve_since('2026-07-01', now)
assert resolve_since('2026-07-01T12:00:00Z', now) == '2026-07-01T12:00:00Z', resolve_since('2026-07-01T12:00:00Z', now)
print('ok')
"
    [ "$status" -eq 0 ]
    [[ "$output" == *"ok"* ]]
}

@test "--files: per-commit API failure is a hard error" {
    export GH_FAIL_SHA="cccc"
    run python3 "$SCRIPT" owner/repo --branch main --files -o "$OUT_FILE"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Failed to get files for ccccccc"* ]]
}
