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

@test "extract_terms: generic words are stopwords, tool names are kept" {
    run pyeval "print(m.extract_terms('feat: App Code Stop Read Write Final Closes Path Setup Plan Pre Docs Blocked Preview Rules Boundary Cloud Mac と Bash Node Next Actions Workflow Vite Jev'))"
    [ "$output" = "['Bash', 'Node', 'Next', 'Actions', 'Workflow', 'Vite', 'Jev']" ]
}

@test "exclusion_reason: release-please and main/dev sync PRs are release_or_sync" {
    run pyeval "print(m.exclusion_reason('chore(main): release 0.10.1', None))"
    [ "$output" = "release_or_sync" ]
    run pyeval "print(m.exclusion_reason('chore(main): release skills 1.2.0', None))"
    [ "$output" = "release_or_sync" ]
    run pyeval "print(m.exclusion_reason('chore: main を dev に同期（renovate 更新の取り込み）', None))"
    [ "$output" = "release_or_sync" ]
    run pyeval "print(m.exclusion_reason('chore: dev を main に同期', None))"
    [ "$output" = "release_or_sync" ]
    run pyeval "print(m.exclusion_reason('chore: sync main into dev', None))"
    [ "$output" = "release_or_sync" ]
    run pyeval "print(m.exclusion_reason('feat: release ノートを自動生成する', None))"
    [ "$output" = "None" ]
}

@test "dedup_title: trailing (#N) and （#N を dev に） are removed" {
    run pyeval "print(m.dedup_title('chore(config): 設定を up 形式に移す (#1540)'))"
    [ "$output" = "chore(config): 設定を up 形式に移す" ]
    run pyeval "print(m.dedup_title('chore(config): 設定を up 形式に移す（#1540 を dev に）'))"
    [ "$output" = "chore(config): 設定を up 形式に移す" ]
    run pyeval "print(m.dedup_title('fix(ui): 直す（#12 を dev に） (#13)'))"
    [ "$output" = "fix(ui): 直す" ]
}

@test "repo_matches: owner/name and owner/*" {
    run pyeval "print(m.repo_matches('playpark-llc/yeg', 'playpark-llc/yeg'), m.repo_matches('playpark-llc/yeg', 'playpark-llc/corporate-site'))"
    [ "$output" = "True False" ]
    run pyeval "print(m.repo_matches('Cistree-dev/*', 'Cistree-dev/app'), m.repo_matches('Cistree-dev/*', 'playpark-llc/app'))"
    [ "$output" = "True False" ]
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

@test "harvest: release and sync PRs are excluded without a config" {
    cat > "$FIXTURES/search_prs.json" << 'EOF'
[
  {"repository": {"nameWithOwner": "it-all-playpark/skills"}, "number": 800,
   "title": "chore(main): release 0.10.1", "body": "- Jev 判定 一致率 92% → 97%",
   "url": "https://github.com/it-all-playpark/skills/pull/800", "closedAt": "2026-09-22T00:00:00Z",
   "author": {"login": "naramoto"}},
  {"repository": {"nameWithOwner": "playpark-llc/corporate-site"}, "number": 1500,
   "title": "chore: main を dev に同期（renovate 更新の取り込み）", "body": "ビルド時間 40秒 → 12秒",
   "url": "https://github.com/playpark-llc/corporate-site/pull/1500", "closedAt": "2026-09-22T00:00:00Z",
   "author": {"login": "naramoto"}}
]
EOF
    run harvest --no-commits
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r .fetched)" = "2" ]
    [ "$(echo "$output" | jq -r .excluded)" = "2" ]
    [ "$(echo "$output" | jq -c .topics)" = "[]" ]
}

@test "harvest: the same PR to dev and to main is kept once, the earlier merge wins" {
    cat > "$FIXTURES/search_prs.json" << 'EOF'
[
  {"repository": {"nameWithOwner": "playpark-llc/corporate-site"}, "number": 1541,
   "title": "feat(config): Deno の設定を移す (#1540)", "body": "ビルド時間 40秒 → 12秒",
   "url": "https://github.com/playpark-llc/corporate-site/pull/1541", "closedAt": "2026-09-21T00:00:00Z",
   "author": {"login": "naramoto"}},
  {"repository": {"nameWithOwner": "playpark-llc/corporate-site"}, "number": 1540,
   "title": "feat(config): Deno の設定を移す（#1539 を dev に）", "body": "ビルド時間 40秒 → 12秒",
   "url": "https://github.com/playpark-llc/corporate-site/pull/1540", "closedAt": "2026-09-20T00:00:00Z",
   "author": {"login": "naramoto"}},
  {"repository": {"nameWithOwner": "it-all-playpark/skills"}, "number": 9,
   "title": "feat(config): Deno の設定を移す (#8)", "body": "ビルド時間 40秒 → 12秒",
   "url": "https://github.com/it-all-playpark/skills/pull/9", "closedAt": "2026-09-22T00:00:00Z",
   "author": {"login": "naramoto"}}
]
EOF
    run harvest --no-commits
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r .duplicates)" = "1" ]
    [ "$(echo "$output" | jq -r .candidates)" = "2" ]
    [ "$(echo "$output" | jq -c .topics)" = '["deno"]' ]
    [ "$(jq -c '[.prs[].number] | sort' "$SEED/_topics/deno.json")" = '[9,1540]' ]
}

@test "harvest: a later PR with the same title as an already harvested one is a duplicate" {
    cat > "$FIXTURES/search_prs.json" << 'EOF'
[
  {"repository": {"nameWithOwner": "playpark-llc/corporate-site"}, "number": 1540,
   "title": "feat(config): Deno の設定を移す", "body": "ビルド時間 40秒 → 12秒",
   "url": "https://github.com/playpark-llc/corporate-site/pull/1540", "closedAt": "2026-09-20T00:00:00Z",
   "author": {"login": "naramoto"}}
]
EOF
    run harvest --no-commits
    [ "$status" -eq 0 ]
    cat > "$FIXTURES/search_prs.json" << 'EOF'
[
  {"repository": {"nameWithOwner": "playpark-llc/corporate-site"}, "number": 1541,
   "title": "feat(config): Deno の設定を移す（#1540 を dev に）", "body": "ビルド時間 40秒 → 12秒",
   "url": "https://github.com/playpark-llc/corporate-site/pull/1541", "closedAt": "2026-09-21T00:00:00Z",
   "author": {"login": "naramoto"}}
]
EOF
    run harvest --no-commits
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r .duplicates)" = "1" ]
    [ "$(echo "$output" | jq -c .topics)" = "[]" ]
    [ "$(jq -c '[.prs[].number]' "$SEED/_topics/deno.json")" = '[1540]' ]
}

@test "harvest: a generic word such as Blocked does not become the topic" {
    cat > "$FIXTURES/search_prs.json" << 'EOF'
[
  {"repository": {"nameWithOwner": "it-all-playpark/skills"}, "number": 77,
   "title": "fix(dev-flow): Blocked 判定の Path を直す", "body": "ビルド時間 40秒 → 12秒",
   "url": "https://github.com/it-all-playpark/skills/pull/77", "closedAt": "2026-09-20T00:00:00Z",
   "author": {"login": "naramoto"}}
]
EOF
    run harvest --no-commits
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -c .topics)" = '["fix-dev-flow-blocked-path"]' ]
    [ "$(jq -c .terms "$SEED/_topics/fix-dev-flow-blocked-path.json")" = "[]" ]
}

# ---------------------------------------------------------------- config

write_config() {
    printf '%s\n' "$1" > "$SEED/.seed-harvest-config.json"
}

@test "harvest: no config leaves topics unmarked as client" {
    run harvest --no-commits
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -c .owners)" = '["it-all-playpark","playpark-llc"]' ]
    [ "$(jq -r .client "$SEED/_topics/jev.json")" = "false" ]
}

@test "harvest: config owners are the default, --owner overrides them" {
    write_config '{"owners": ["it-all-playpark", "Cistree-dev"]}'
    run harvest --no-commits
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -c .owners)" = '["it-all-playpark","Cistree-dev"]' ]
    grep -q -- "--owner it-all-playpark --owner Cistree-dev " "$GH_CALLS_LOG"

    : > "$GH_CALLS_LOG"
    run harvest --no-commits --dry-run --owner playpark-llc
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -c .owners)" = '["playpark-llc"]' ]
    grep -q -- "--owner playpark-llc " "$GH_CALLS_LOG"
    run grep -q "Cistree-dev" "$GH_CALLS_LOG"
    [ "$status" -ne 0 ]
}

@test "harvest: config exclude needs both repo and title_regex to match, owner/* matches" {
    write_config '{"exclude": [
      {"repo": "playpark-llc/corporate-site", "title_regex": "factory"},
      {"repo": "it-all-playpark/*", "title_regex": "sandbox"},
      {"repo": "playpark-llc/other", "title_regex": "Jev"}
    ]}'
    run harvest --no-commits
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r .excluded)" = "6" ]
    [ "$(echo "$output" | jq -r .candidates)" = "1" ]
    [ "$(jq -c '[.prs[].number]' "$SEED/_topics/jev.json")" = '[728]' ]
}

@test "harvest: broken config JSON is exit 2 and fetches nothing" {
    write_config '{"owners": ['
    run harvest --no-commits
    [ "$status" -eq 2 ]
    [[ "$output" == *"invalid config"* ]]
    [ ! -e "$GH_CALLS_LOG" ]
    [ ! -e "$SEED/.seed-harvest-state.json" ]
}

@test "harvest: invalid title_regex in config is exit 2" {
    write_config '{"exclude": [{"repo": "playpark-llc/corporate-site", "title_regex": "blog(" }]}'
    run harvest --no-commits
    [ "$status" -eq 2 ]
    [[ "$output" == *"title_regex"* ]]
    [ ! -e "$GH_CALLS_LOG" ]
}

@test "harvest: topics with a client repo are client:true, others false, and an append raises it" {
    write_config '{"client_repos": ["playpark-llc/yeg", "Cistree-dev/*"]}'
    cat > "$FIXTURES/search_prs.json" << 'EOF'
[
  {"repository": {"nameWithOwner": "it-all-playpark/skills"}, "number": 728,
   "title": "feat(dev-flow): Jev 判定を prerun に入れる", "body": "一致率 92% → 97%",
   "url": "https://github.com/it-all-playpark/skills/pull/728", "closedAt": "2026-09-22T00:00:00Z",
   "author": {"login": "naramoto"}},
  {"repository": {"nameWithOwner": "Cistree-dev/app"}, "number": 3,
   "title": "feat: Deno でビルドする", "body": "ビルド時間 40秒 → 12秒",
   "url": "https://github.com/Cistree-dev/app/pull/3", "closedAt": "2026-09-22T00:00:00Z",
   "author": {"login": "naramoto"}}
]
EOF
    run harvest --no-commits
    [ "$status" -eq 0 ]
    [ "$(jq -r .client "$SEED/_topics/jev.json")" = "false" ]
    [ "$(jq -r .client "$SEED/_topics/deno.json")" = "true" ]

    cat > "$FIXTURES/search_prs.json" << 'EOF'
[
  {"repository": {"nameWithOwner": "playpark-llc/yeg"}, "number": 41,
   "title": "feat: Jev で分類する", "body": "一致率 97%",
   "url": "https://github.com/playpark-llc/yeg/pull/41", "closedAt": "2026-09-23T00:00:00Z",
   "author": {"login": "naramoto"}}
]
EOF
    run harvest --no-commits
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -c .topics)" = '["jev"]' ]
    [ "$(jq -c '[.prs[].number]' "$SEED/_topics/jev.json")" = '[728,41]' ]
    [ "$(jq -r .client "$SEED/_topics/jev.json")" = "true" ]
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

@test "slice: a client topic starts with the no-implementation-details note, others do not" {
    run harvest --no-commits
    [ "$status" -eq 0 ]
    echo '{"title": "feat: Jev", "body": "本文", "comments": []}' > "$FIXTURES/pr_view.json"
    printf 'diff --git a/x b/x\n+one\n' > "$FIXTURES/pr_diff.txt"

    run python3 "$SCRIPT" slice jev --seed "$SEED"
    [ "$status" -eq 0 ]
    [ "$(head -n 1 "$SEED/_topics/slices/jev.md")" = "# Topic: Jev" ]
    run grep -q "顧客案件由来" "$SEED/_topics/slices/jev.md"
    [ "$status" -ne 0 ]

    jq '.client = true' "$SEED/_topics/jev.json" > "$BATS_TEST_TMPDIR/jev.json"
    mv "$BATS_TEST_TMPDIR/jev.json" "$SEED/_topics/jev.json"
    run python3 "$SCRIPT" slice jev --seed "$SEED"
    [ "$status" -eq 0 ]
    first="$(head -n 1 "$SEED/_topics/slices/jev.md")"
    [[ "$first" == *"顧客案件由来"* ]]
    [[ "$first" == *"実装の詳細"*"記事に載せない"* ]]
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
