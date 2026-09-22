#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for dev-flow/scripts/prerun-analyze.sh (issue #690)
#
# ネットワークには出ない。gh は fixture JSON を返す stub、Jev は偽 curl（PATH 先頭）で応答を
# 制御する。偽 curl は request body の state に埋め込んだマーカー `[[jev:noul:<p>]]` /
# `[[jev:<choice>:<p>]]` で応答を決める（マーカーが無ければ FAKE_CURL_MODE: garbage → 非 JSON）。
# これで comment ごとに別の判定を返せる（1 request = 1 comment）。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/prerun-analyze.sh"

setup() {
    WORK="$BATS_TEST_TMPDIR/work"
    mkdir -p "$WORK/bin"

    # ---- gh stub ----
    GH_LOG="$WORK/gh.log"
    : >"$GH_LOG"
    cat >"$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
if [[ -n "${GH_STUB_FAIL:-}" ]]; then
    echo "$GH_STUB_FAIL" >&2
    exit 1
fi
cat "$GH_STUB_FIXTURE"
STUB
    chmod +x "$WORK/bin/gh"

    # ---- curl stub (Jev) ----
    CURL_LOG="$WORK/curl.log"
    : >"$CURL_LOG"
    cat >"$WORK/bin/curl" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
body=""
while [[ $# -gt 0 ]]; do
  case "$1" in
  -d) body="$2"; shift 2 ;;
  --max-time) printf 'max-time=%s\n' "$2" >>"$CURL_LOG"; shift 2 ;;
  -H|--config) shift 2 ;;
  *) shift ;;
  esac
done
cat >/dev/null
state="$(printf '%s' "$body" | jq -r '.state')"
qkind="$(printf '%s' "$body" | jq -r '.questions | keys[0]')"
printf 'call\n' >>"$CURL_LOG"
if [[ "$qkind" == "breaking" && "$state" =~ \[\[jev:noul:([0-9.]+)\]\] ]]; then
  printf '{"model":"typesafe-ai/jev","answers":{"breaking":{"type":"noul","noul":%s}},"usage":{"input_tokens":1,"output_tokens":0}}\n' "${BASH_REMATCH[1]}"
  exit 0
fi
if [[ "$qkind" == "kind" && "$state" =~ \[\[jev:(override|conflict|unrelated):([0-9.]+)\]\] ]]; then
  c="${BASH_REMATCH[1]}"; p="${BASH_REMATCH[2]}"
  printf '{"model":"typesafe-ai/jev","answers":{"kind":{"type":"choice","choice":"%s","probabilities":{"%s":%s}}},"usage":{"input_tokens":1,"output_tokens":0}}\n' "$c" "$c" "$p"
  exit 0
fi
echo '<html>502</html>'
FAKE
    chmod +x "$WORK/bin/curl"

    export GH_LOG CURL_LOG
    export PATH="$WORK/bin:$PATH"
    export AI_GATEWAY_API_KEY="vck_test_key"
    export JEV_KEYCHAIN_SERVICE="prerun-analyze-bats-nonexistent"
    unset DEVFLOW_JEV_DISABLE
}

# fixture <path> <title> <body> [comments_json] [author_login]
fixture() {
    local path="$1" title="$2" body="$3" comments="${4:-[]}" author="${5:-reporter}"
    jq -n --arg title "$title" --arg body "$body" --argjson comments "$comments" --arg author "$author" \
        '{title: $title, state: "open", body: $body, labels: [], assignees: [], milestone: null, comments: $comments, author: {login: $author}}' \
        >"$path"
}

# comment <author> <association> <body>
comment() {
    jq -n --arg a "$1" --arg s "$2" --arg b "$3" '{author: {login: $a}, authorAssociation: $s, createdAt: "2026-01-01T00:00:00Z", body: $b}'
}

run_analyze() {
    export GH_STUB_FIXTURE="$1"
    shift
    run "$SCRIPT" --issue 7 "$@"
}

AC_BODY="## 概要

説明。

## 受け入れ基準

- [ ] AC one
- [ ] AC two"

curl_calls() { grep -c '^call$' "$CURL_LOG" || true; }

# ---- contract 経路（Jev 不要）----

@test "contract 経路: AC あり・comment 無し・breaking 無し -> ok, analyze_path=contract, Jev 未呼び出し" {
    fixture "$WORK/i.json" "feat: add button" "$AC_BODY"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .analyze_path == "contract" and .jev_reasons == []'
    echo "$output" | jq -e '.acceptance_criteria == ["AC one", "AC two"] and .issue_type == "feat" and .issue_title == "feat: add button"'
    echo "$output" | jq -e '.breaking_change == false and .breaking_keyword_scan == false and .comment_overrides == [] and .comment_conflicts == [] and .uncertain == []'
    echo "$output" | jq -e '(.issue_body | type) == "string" and .issue_body_truncated == false and .comment_count == 0 and .contract == "t1"'
    [ "$(curl_calls)" -eq 0 ]
}

@test "AC 見出し無し -> ok:true で acceptance_criteria は空（ゲート判定は Workflow 側）" {
    fixture "$WORK/i.json" "feat: add button" "本文のみ"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == true and .acceptance_criteria == [] and .contract == "none"'
}

@test "--repo は analyze-issue 経由で gh に渡る" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY"
    run_analyze "$WORK/i.json" --repo acme/skills
    [ "$status" -eq 0 ]
    grep -q -- '--repo acme/skills' "$GH_LOG"
}

@test "gh 到達不能 -> ok:false + reason（exit 0）" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY"
    GH_STUB_FAIL="HTTP 502: bad gateway" run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and (.reason | test("bad gateway")) and .analyze_path == "contract"'
}

@test "analyze-issue が JSON 以外を返す -> ok:false + reason" {
    printf 'not json' >"$WORK/i.json"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.ok == false and (.reason | length) > 0'
}

# ---- breaking noul ----

@test "breaking keyword + Jev noul p>=0.9 -> breaking_change=true, analyze_path=jev" {
    fixture "$WORK/i.json" "feat: schema migration" "$AC_BODY

[[jev:noul:0.95]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true and .breaking_change == true and .analyze_path == "jev"'
    echo "$output" | jq -e '.jev_reasons == ["breaking_keyword_scan true"] and .uncertain == []'
    echo "$output" | jq -e '.breaking_evidence | test("0.95")'
    [ "$(curl_calls)" -eq 1 ]
}

@test "breaking keyword + Jev noul p<=0.1 -> breaking_change=false, uncertain 空" {
    fixture "$WORK/i.json" "feat: keep compat" "$AC_BODY

breaking を避ける。[[jev:noul:0.04]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true and .breaking_change == false and .uncertain == [] and .analyze_path == "jev"'
}

@test "breaking keyword + Jev 低確信（0.1<p<0.9）-> breaking_change=false, uncertain に積む" {
    fixture "$WORK/i.json" "feat: maybe migration" "$AC_BODY

[[jev:noul:0.55]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_change == false and (.uncertain | length) == 1 and (.uncertain[0] | test("breaking_keyword_scan") and test("0.55"))'
}

@test "breaking keyword + Jev 空 stdout（非 JSON 応答）-> uncertain（fail-closed）" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true and .breaking_change == false and (.uncertain | length) == 1 and (.uncertain[0] | test("Jev 応答なし"))'
    [ "$(curl_calls)" -eq 1 ]
}

@test "title の ! marker -> 決定論で breaking_change=true（Jev 未呼び出し）" {
    fixture "$WORK/i.json" "feat!: drop v1" "$AC_BODY"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_change == true and (.breaking_evidence | test("!")) and .uncertain == [] and .analyze_path == "contract"'
    [ "$(curl_calls)" -eq 0 ]
}

@test "DEVFLOW_JEV_DISABLE=1 -> Jev を呼ばず breaking 判定は uncertain" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:0.99]]"
    DEVFLOW_JEV_DISABLE=1 run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_change == false and (.uncertain | length) == 1 and (.uncertain[0] | test("DEVFLOW_JEV_DISABLE=1"))'
    [ "$(curl_calls)" -eq 0 ]
}

@test "Jev の --max-time は DEVFLOW_JEV_MAX_TIME（既定 10 秒）" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:0.95]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    grep -q '^max-time=10$' "$CURL_LOG"
    : >"$CURL_LOG"
    DEVFLOW_JEV_MAX_TIME=25 run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    grep -q '^max-time=25$' "$CURL_LOG"
}

# ---- comment choice 3 分岐 × 権限 2 分岐 ----

@test "comment override × 報告者本人 -> comment_overrides" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment reporter NONE '訂正: 30 箇所 [[jev:override:0.97]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.analyze_path == "jev" and .jev_reasons == ["comments present (1)"]'
    echo "$output" | jq -e '(.comment_overrides | length) == 1 and (.comment_overrides[0] | startswith("override:") and test("reporter") and test("訂正: 30 箇所")) and .comment_conflicts == [] and .uncertain == []'
}

@test "comment override × OWNER/MEMBER/COLLABORATOR -> comment_overrides" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'A [[jev:override:0.95]]'), $(comment bob MEMBER 'B [[jev:override:0.95]]'), $(comment carol COLLABORATOR 'C [[jev:override:0.95]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(.comment_overrides | length) == 3 and .comment_conflicts == []'
}

@test "comment override × 権限なし（NONE・非報告者）-> comment_conflicts（fail-closed）" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment mallory NONE 'X ではなく Y [[jev:override:0.97]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_overrides == [] and (.comment_conflicts | length) == 1 and (.comment_conflicts[0] | startswith("override（権限なし") and test("mallory"))'
}

@test "comment conflict × 権限あり / なし -> どちらも comment_conflicts" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'hmm [[jev:conflict:0.93]]'), $(comment mallory NONE 'hmm2 [[jev:conflict:0.93]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_overrides == [] and (.comment_conflicts | length) == 2 and all(.comment_conflicts[]; startswith("conflict:"))'
}

@test "comment unrelated（高確信）× 権限あり / なし -> どちらにも積まない" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER '了解 [[jev:unrelated:0.98]]'), $(comment mallory NONE 'thanks [[jev:unrelated:0.98]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_overrides == [] and .comment_conflicts == [] and .uncertain == [] and .analyze_path == "jev"'
    [ "$(curl_calls)" -eq 2 ]
}

@test "comment 低確信（p<0.9）-> choice に関わらず comment_conflicts（fail-closed）" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'a [[jev:unrelated:0.6]]'), $(comment alice OWNER 'b [[jev:override:0.7]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_overrides == [] and (.comment_conflicts | length) == 2 and all(.comment_conflicts[]; startswith("low-confidence（"))'
}

@test "comment で Jev 空 stdout -> uncertain（fail-closed）" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'no marker here')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_overrides == [] and .comment_conflicts == [] and (.uncertain | length) == 1 and (.uncertain[0] | test("comment #1 by alice") and test("Jev 応答なし"))'
}

@test "DEVFLOW_JEV_DISABLE=1 で comments あり -> 全 comment が uncertain、curl 未呼び出し" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'a [[jev:override:0.99]]'), $(comment bob NONE 'b [[jev:unrelated:0.99]]')]" reporter
    DEVFLOW_JEV_DISABLE=1 run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(.uncertain | length) == 2 and all(.uncertain[]; test("DEVFLOW_JEV_DISABLE=1")) and .analyze_path == "jev"'
    [ "$(curl_calls)" -eq 0 ]
}

@test "breaking keyword + comments 同時 -> jev_reasons に両方、判定は独立" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:0.95]]" "[$(comment reporter NONE '訂正 [[jev:override:0.95]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.jev_reasons == ["breaking_keyword_scan true", "comments present (1)"]'
    echo "$output" | jq -e '.breaking_change == true and (.comment_overrides | length) == 1'
}

@test "Jev への state は --redact 済み（token 値が送られない）" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

TOKEN=supersecret1 [[jev:noul:0.95]]"
    cat >"$WORK/bin/curl" <<'FAKE'
#!/usr/bin/env bash
body=""
while [[ $# -gt 0 ]]; do case "$1" in -d) body="$2"; shift 2 ;; --max-time|-H|--config) shift 2 ;; *) shift ;; esac; done
cat >/dev/null
printf '%s' "$body" | jq -r '.state' >"$CURL_LOG.state"
echo '{"answers":{"breaking":{"type":"noul","noul":0.95}}}'
FAKE
    chmod +x "$WORK/bin/curl"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    ! grep -q supersecret1 "$CURL_LOG.state"
    grep -q '<redacted>' "$CURL_LOG.state"
}

# ---- 引数 ----

@test "--issue 欠落 / 非数値 -> exit 2" {
    run "$SCRIPT"
    [ "$status" -eq 2 ]
    run "$SCRIPT" --issue abc
    [ "$status" -eq 2 ]
}
