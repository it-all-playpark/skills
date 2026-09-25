#!/usr/bin/env bats
# Tests for seed-harvest/scripts/seed_harvest.py
#
# Strategy: `gh` and `curl` are replaced by stubs on PATH. The gh stub answers
# from fixture files under $FIXTURES (search prs / search commits per owner and
# page / pr view / pr diff) and logs its argv to $GH_CALLS_LOG. The curl stub
# fails every URL except the hosts listed in $CURL_OK_HOSTS. Pure functions are
# checked by importing the module with python3.

setup() {
    SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/seed_harvest.py"
    SCRIPT_DIR="$(dirname "$SCRIPT")"
    FIXTURES="$BATS_TEST_TMPDIR/fixtures"
    SEED="$BATS_TEST_TMPDIR/seed"
    GH_CALLS_LOG="$BATS_TEST_TMPDIR/gh_calls.log"
    CURL_OK_HOSTS=""
    mkdir -p "$FIXTURES" "$SEED" "$BATS_TEST_TMPDIR/bin"
    export FIXTURES GH_CALLS_LOG CURL_OK_HOSTS SCRIPT_DIR

    cat > "$BATS_TEST_TMPDIR/bin/gh" << 'EOF'
#!/usr/bin/env python3
import os
import re
import sys

args = sys.argv[1:]
fx = os.environ["FIXTURES"]
with open(os.environ["GH_CALLS_LOG"], "a") as f:
    f.write(" ".join(args) + "\n")


def emit(name, default=None):
    path = os.path.join(fx, name)
    if os.path.exists(path):
        sys.stdout.write(open(path).read())
    elif default is not None:
        sys.stdout.write(default)
    else:
        sys.stderr.write(f"fixture missing: {name}\n")
        sys.exit(1)


if args[:2] == ["search", "prs"]:
    emit("search_prs.json", "[]")
elif args and args[0] == "api" and "search/commits" in args:
    joined = " ".join(args)
    owner = re.search(r"q=org:(\S+)", joined).group(1)
    page = re.search(r"(?<!_)page=(\d+)", joined).group(1)
    emit(f"commits_{owner}_p{page}.json", '{"total_count": 0, "incomplete_results": false, "items": []}')
elif args[:2] == ["pr", "view"]:
    emit("pr_view.json")
elif args[:2] == ["pr", "diff"]:
    emit("pr_diff.txt")
elif args and args[0] == "api" and "/commits/" in args[1]:
    emit("commit_diff.txt")
else:
    sys.stderr.write("unexpected gh call: " + " ".join(args) + "\n")
    sys.exit(1)
EOF
    chmod +x "$BATS_TEST_TMPDIR/bin/gh"

    cat > "$BATS_TEST_TMPDIR/bin/curl" << 'EOF'
#!/usr/bin/env python3
import os
import sys

url = sys.argv[-1]
for host in filter(None, os.environ.get("CURL_OK_HOSTS", "").split(",")):
    if host in url and host == "hn.algolia.com":
        sys.stdout.write('{"nbHits": 7}')
        sys.exit(0)
sys.stderr.write("curl: (6) Could not resolve host\n")
sys.exit(6)
EOF
    chmod +x "$BATS_TEST_TMPDIR/bin/curl"
    export PATH="$BATS_TEST_TMPDIR/bin:$PATH"

    # Jev PRs in 3 repos, plus PRs that must be excluded or dropped.
    cat > "$FIXTURES/search_prs.json" << 'EOF'
[
  {"repository": {"nameWithOwner": "it-all-playpark/skills"}, "number": 728,
   "title": "feat(dev-flow): Jev 判定を prerun に入れる", "body": "一致率 92% → 97%",
   "url": "https://github.com/it-all-playpark/skills/pull/728", "closedAt": "2026-09-22T00:00:00Z",
   "author": {"login": "naramoto"}},
  {"repository": {"nameWithOwner": "it-all-playpark/dotfiles"}, "number": 51,
   "title": "feat: Jev の API キーを sandbox から読めるようにする", "body": "レイテンシ 120ms → 80ms",
   "url": "https://github.com/it-all-playpark/dotfiles/pull/51", "closedAt": "2026-09-21T00:00:00Z",
   "author": {"login": "naramoto"}},
  {"repository": {"nameWithOwner": "playpark-llc/corporate-site"}, "number": 990,
   "title": "fix(factory): Jev キー取得を直す",
   "body": "factory が失敗していた。原因は旧パス直書き。対策としてパスを修正した。",
   "url": "https://github.com/playpark-llc/corporate-site/pull/990", "closedAt": "2026-09-23T00:00:00Z",
   "author": {"login": "naramoto"}},
  {"repository": {"nameWithOwner": "playpark-llc/corporate-site"}, "number": 992,
   "title": "blog: Jev で AI の分類を型安全にした話", "body": "一致率 97%",
   "url": "https://github.com/playpark-llc/corporate-site/pull/992", "closedAt": "2026-09-24T00:00:00Z",
   "author": {"login": "naramoto"}},
  {"repository": {"nameWithOwner": "playpark-llc/corporate-site"}, "number": 980,
   "title": "docs(blog): Jev 記事の画像", "body": "サイズ 30KB",
   "url": "https://github.com/playpark-llc/corporate-site/pull/980", "closedAt": "2026-09-24T00:00:00Z",
   "author": {"login": "naramoto"}},
  {"repository": {"nameWithOwner": "playpark-llc/corporate-site"}, "number": 981,
   "title": "chore(sns): Jev 記事の告知", "body": "",
   "url": "https://github.com/playpark-llc/corporate-site/pull/981", "closedAt": "2026-09-24T00:00:00Z",
   "author": {"login": "naramoto"}},
  {"repository": {"nameWithOwner": "it-all-playpark/skills"}, "number": 730,
   "title": "chore(deps): update dependency vitest to v5.0.2", "body": "5.0.1 -> 5.0.2",
   "url": "https://github.com/it-all-playpark/skills/pull/730", "closedAt": "2026-09-25T00:00:00Z",
   "author": {"login": "app/renovate"}},
  {"repository": {"nameWithOwner": "it-all-playpark/skills"}, "number": 731,
   "title": "refactor: README を整える", "body": "表記揺れを直す",
   "url": "https://github.com/it-all-playpark/skills/pull/731", "closedAt": "2026-09-25T00:00:00Z",
   "author": {"login": "naramoto"}}
]
EOF
}

harvest() {
    python3 "$SCRIPT" harvest --seed "$SEED" --since 2026-09-01 "$@"
}

pyeval() {
    python3 -c "import sys; sys.path.insert(0, '$SCRIPT_DIR'); import seed_harvest as m; $1"
}

# ---------------------------------------------------------------- pure functions

@test "exclusion_reason: blog/sns in scope or as type is blog_or_sns" {
    run pyeval "print(m.exclusion_reason('blog: Jev の記事', None))"
    [ "$output" = "blog_or_sns" ]
    run pyeval "print(m.exclusion_reason('docs(blog): 画像', None))"
    [ "$output" = "blog_or_sns" ]
    run pyeval "print(m.exclusion_reason('sns: 告知', None))"
    [ "$output" = "blog_or_sns" ]
    run pyeval "print(m.exclusion_reason('chore(sns): 告知', None))"
    [ "$output" = "blog_or_sns" ]
}

@test "exclusion_reason: deps, bots and merge commits; feat is kept" {
    run pyeval "print(m.exclusion_reason('chore(deps): bump x', None))"
    [ "$output" = "dependency_update" ]
    run pyeval "print(m.exclusion_reason('Update dependency vitest to v5', None))"
    [ "$output" = "dependency_update" ]
    run pyeval "print(m.exclusion_reason('feat: something', 'renovate[bot]'))"
    [ "$output" = "dependency_update" ]
    run pyeval "print(m.exclusion_reason('Merge branch main into x', None))"
    [ "$output" = "merge_commit" ]
    run pyeval "print(m.exclusion_reason('feat(seed): Jev を入れる', 'naramoto'))"
    [ "$output" = "None" ]
}

@test "extract_terms: keeps capitalized product names, drops stopwords and lowercase ids" {
    run pyeval "print(m.extract_terms('feat(dev-flow): Jev と TypeSafe を PostToolUse hook に足す (Claude, API, jev)'))"
    [ "$output" = "['Jev', 'TypeSafe', 'PostToolUse']" ]
}

@test "extract_terms: dedupes case-insensitively, first spelling wins" {
    run pyeval "print(m.extract_terms('fix: Jev と JEV と jev'))"
    [ "$output" = "['Jev']" ]
}

@test "aggregate: failed sensors are unknown, never 0" {
    run pyeval "import json; print(json.dumps(m.aggregate({'a': m.unknown('x'), 'b': m.unknown('y')})))"
    [ "$(echo "$output" | jq -r .status)" = "unknown" ]
    [ "$(echo "$output" | jq -r .score)" = "null" ]

    run pyeval "import json; print(json.dumps(m.aggregate({'a': m.unknown('x'), 'b': {'status': 'ok', 'hits': 3}})))"
    [ "$(echo "$output" | jq -r .status)" = "partial" ]
    [ "$(echo "$output" | jq -r .score)" = "3" ]

    run pyeval "import json; print(json.dumps(m.aggregate({'a': {'status': 'ok', 'hits': 0}})))"
    [ "$(echo "$output" | jq -r .status)" = "ok" ]
    [ "$(echo "$output" | jq -r .score)" = "0" ]
}

# ---------------------------------------------------------------- harvest

@test "harvest: Jev PRs from 3 repos are bundled into one topic" {
    run harvest --no-commits
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -c .topics)" = '["jev"]' ]

    topic="$SEED/_topics/jev.json"
    [ -f "$topic" ]
    [ "$(jq -r .topic "$topic")" = "Jev" ]
    [ "$(jq -r .status "$topic")" = "pending" ]
    [ "$(jq -c .repos "$topic")" = '["it-all-playpark/dotfiles","it-all-playpark/skills","playpark-llc/corporate-site"]' ]
    [ "$(jq -c '[.prs[].number] | sort' "$topic")" = '[51,728,990]' ]
    [ "$(jq -r '.demand' "$topic")" = "null" ]
}

@test "harvest: blog/sns/deps PRs are excluded, the blog: article PR does not leak into the topic" {
    run harvest --no-commits
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r .fetched)" = "8" ]
    [ "$(echo "$output" | jq -r .excluded)" = "4" ]
    [ "$(echo "$output" | jq -r .not_candidate)" = "1" ]
    [ "$(echo "$output" | jq -r .candidates)" = "3" ]
    ! jq -e '.prs[] | select(.number == 992 or .number == 980 or .number == 981)' "$SEED/_topics/jev.json"
}

@test "harvest: candidate reasons are recorded per PR" {
    run harvest --no-commits
    [ "$status" -eq 0 ]
    topic="$SEED/_topics/jev.json"
    [ "$(jq -c '.prs[] | select(.number == 728) | .reasons' "$topic")" = '["metrics","new_tool"]' ]
    [ "$(jq -c '.prs[] | select(.number == 990) | .reasons' "$topic")" = '["failure_cause_fix"]' ]
}

@test "harvest: second run does not re-add already harvested PRs" {
    run harvest --no-commits
    [ "$status" -eq 0 ]
    run harvest --no-commits
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r .already_harvested)" = "3" ]
    [ "$(jq '.prs | length' "$SEED/_topics/jev.json")" = "3" ]
}

@test "harvest: --dry-run writes nothing" {
    run harvest --no-commits --dry-run
    [ "$status" -eq 0 ]
    [ ! -e "$SEED/_topics" ]
    [ ! -e "$SEED/.seed-harvest-state.json" ]
}

# ---------------------------------------------------------------- direct commits

write_commit_pages() {
    # $1 owner, $2 total, then page sizes. Page 2 (if any) carries a feat commit introducing Deno.
    local owner="$1" total="$2"
    shift 2
    python3 - "$FIXTURES" "$owner" "$total" "$@" << 'EOF'
import json, sys
fx, owner, total, sizes = sys.argv[1], sys.argv[2], int(sys.argv[3]), [int(s) for s in sys.argv[4:]]
n = 0
for page, size in enumerate(sizes, start=1):
    items = []
    for _ in range(size):
        n += 1
        msg = f"chore: tidy {n}"
        if page == 2 and len(items) == 0:
            msg = "feat: Deno を導入する\n\nビルド時間 40秒 → 12秒"
        items.append({
            "sha": f"{n:040x}",
            "html_url": f"https://github.com/{owner}/tools/commit/{n:040x}",
            "repository": {"full_name": f"{owner}/tools"},
            "commit": {"message": msg, "committer": {"date": "2026-09-20T00:00:00Z"}},
            "author": {"login": "naramoto"},
        })
    with open(f"{fx}/commits_{owner}_p{page}.json", "w") as f:
        json.dump({"total_count": total, "incomplete_results": False, "items": items}, f)
EOF
}

@test "harvest: direct commits are read sorted by committer-date across all pages" {
    echo '[]' > "$FIXTURES/search_prs.json"
    write_commit_pages it-all-playpark 150 100 50
    run harvest --owner it-all-playpark
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r .fetched)" = "1" ]
    [ "$(echo "$output" | jq -c .topics)" = '["deno"]' ]
    [ "$(jq -r '.commits[0].sha' "$SEED/_topics/deno.json")" != "null" ]
    grep -q "sort=committer-date" "$GH_CALLS_LOG"
    grep -q "page=2" "$GH_CALLS_LOG"
    ! grep -q "page=3" "$GH_CALLS_LOG"
    [ -f "$SEED/.seed-harvest-state.json" ]
}

@test "harvest: over 1000 commits fails and keeps lastRunAt" {
    echo '{"lastRunAt": "2026-09-01T00:00:00Z"}' > "$SEED/.seed-harvest-state.json"
    write_commit_pages it-all-playpark 1001 100
    run harvest --owner it-all-playpark
    [ "$status" -eq 1 ]
    [[ "$output" == *"1001 commits"* ]]
    [ "$(jq -r .lastRunAt "$SEED/.seed-harvest-state.json")" = "2026-09-01T00:00:00Z" ]
    [ ! -e "$SEED/_topics" ]
}

@test "harvest: a short page before total_count fails and keeps lastRunAt" {
    echo '{"lastRunAt": "2026-09-01T00:00:00Z"}' > "$SEED/.seed-harvest-state.json"
    write_commit_pages it-all-playpark 150 100
    echo '{"total_count": 150, "incomplete_results": false, "items": []}' > "$FIXTURES/commits_it-all-playpark_p2.json"
    run harvest --owner it-all-playpark
    [ "$status" -eq 1 ]
    [[ "$output" == *"got 100 of 150"* ]]
    [ "$(jq -r .lastRunAt "$SEED/.seed-harvest-state.json")" = "2026-09-01T00:00:00Z" ]
}

@test "harvest: incomplete_results fails" {
    echo '{"total_count": 1, "incomplete_results": true, "items": []}' > "$FIXTURES/commits_it-all-playpark_p1.json"
    run harvest --owner it-all-playpark
    [ "$status" -eq 1 ]
    [[ "$output" == *"incomplete_results"* ]]
    [ ! -e "$SEED/.seed-harvest-state.json" ]
}

# ---------------------------------------------------------------- slice

@test "slice: large diffs are shrunk under 100KB and lockfiles are omitted" {
    run harvest --no-commits
    [ "$status" -eq 0 ]

    echo '{"title": "feat: Jev", "body": "一致率 92% → 97%", "comments": [{"author": {"login": "rev"}, "body": "LGTM"}]}' \
        > "$FIXTURES/pr_view.json"
    python3 - "$FIXTURES/pr_diff.txt" << 'EOF'
import sys
parts = []
for name in ("src/a.py", "src/b.py", "package-lock.json"):
    body = "".join(f"+line {i} of {name} " + "x" * 60 + "\n" for i in range(1000))
    parts.append(f"diff --git a/{name} b/{name}\n--- a/{name}\n+++ b/{name}\n@@ -0,0 +1,1000 @@\n{body}")
open(sys.argv[1], "w").write("".join(parts))
EOF
    [ "$(wc -c < "$FIXTURES/pr_diff.txt")" -gt 150000 ]

    run python3 "$SCRIPT" slice jev --seed "$SEED" --max-kb 99
    [ "$status" -eq 0 ]
    out="$SEED/_topics/slices/jev.md"
    [ "$(echo "$output" | jq -r .slice_path)" = "$out" ]
    [ "$(echo "$output" | jq -r .truncated)" = "true" ]
    [ "$(echo "$output" | jq -r .sources)" = "3" ]
    bytes="$(wc -c < "$out")"
    [ "$bytes" -lt 102400 ]
    [ "$(echo "$output" | jq -r .bytes)" = "$bytes" ]
    grep -q "package-lock.json is a lockfile" "$out"
    grep -q "一致率 92% → 97%" "$out"
    grep -q "truncated from" "$out"
}

@test "slice: small inputs are not truncated" {
    run harvest --no-commits
    [ "$status" -eq 0 ]
    echo '{"title": "feat: Jev", "body": "本文", "comments": []}' > "$FIXTURES/pr_view.json"
    printf 'diff --git a/x b/x\n+one\n' > "$FIXTURES/pr_diff.txt"
    run python3 "$SCRIPT" slice jev --seed "$SEED"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r .truncated)" = "false" ]
}

@test "slice: --max-kb outside 1..99 is a usage error" {
    run python3 "$SCRIPT" slice jev --seed "$SEED" --max-kb 100
    [ "$status" -eq 2 ]
}

# ---------------------------------------------------------------- sense / mark-used

@test "sense: all sensors failing gives unknown with null score, not 0" {
    run harvest --no-commits
    [ "$status" -eq 0 ]
    run python3 "$SCRIPT" sense --seed "$SEED"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -c .ranked)" = "[]" ]
    [ "$(echo "$output" | jq -r '.unranked[0].status')" = "unknown" ]
    [ "$(echo "$output" | jq -r '.unranked[0].score')" = "null" ]
    topic="$SEED/_topics/jev.json"
    [ "$(jq -r .demand.status "$topic")" = "unknown" ]
    [ "$(jq -r .demand.score "$topic")" = "null" ]
    [ "$(jq -r '[.demand.sensors[] | .status] | unique | join(",")' "$topic")" = "unknown" ]
}

@test "sense: one answering sensor gives partial with its hits as score" {
    run harvest --no-commits
    [ "$status" -eq 0 ]
    CURL_OK_HOSTS="hn.algolia.com" run python3 "$SCRIPT" sense --seed "$SEED"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.ranked[0].status')" = "partial" ]
    [ "$(echo "$output" | jq -r '.ranked[0].score')" = "7" ]
    [ "$(jq -r .demand.sensors.hatena.status "$SEED/_topics/jev.json")" = "unknown" ]
}

@test "mark-used: sets status used:<article>" {
    run harvest --no-commits
    [ "$status" -eq 0 ]
    run python3 "$SCRIPT" mark-used jev jev-typesafe-classifier --seed "$SEED"
    [ "$status" -eq 0 ]
    [ "$(jq -r .status "$SEED/_topics/jev.json")" = "used:jev-typesafe-classifier" ]
}
