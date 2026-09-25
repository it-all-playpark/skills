#!/usr/bin/env bats
bats_require_minimum_version 1.5.0

# Tests for dev-flow/scripts/prerun-analyze.sh (issue #690)
#
# ネットワークには出ない。gh は fixture JSON を返す stub、Jev は偽 curl（PATH 先頭）で応答を
# 制御する。偽 curl は request body の state に埋め込んだマーカーで応答を決める:
#   noul 質問 <id> → `[[jev:<id>:<p>]]`、無ければ `[[jev:noul:<p>]]`（全 noul 質問に同じ p）
#   choice 質問 kind → `[[jev:<choice>:<p>]]`
# どの質問にも値が無ければ非 JSON（<html>502</html>）を返す。FAKE_CURL_EXIT を置くとその exit code で落ちる。
# これで comment ごとに別の判定を返せる（1 request = 1 comment）。Keychain は偽 security（FAKE_SECURITY_EXIT）。

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
printf 'call\n' >>"$CURL_LOG"
printf '%s' "$body" | jq -c '.questions' >>"$CURL_LOG.questions"
printf '%s' "$state" >"$CURL_LOG.state"
if [[ -n "${FAKE_CURL_EXIT:-}" ]]; then
  echo "curl: (${FAKE_CURL_EXIT}) simulated failure" >&2
  exit "$FAKE_CURL_EXIT"
fi
answers='{}'
for q in $(printf '%s' "$body" | jq -r '.questions | to_entries[] | select(.value.type == "noul") | .key'); do
  p=""
  if [[ "$state" =~ \[\[jev:${q}:([0-9.]+)\]\] ]]; then
    p="${BASH_REMATCH[1]}"
  elif [[ "$state" =~ \[\[jev:noul:([0-9.]+)\]\] ]]; then
    p="${BASH_REMATCH[1]}"
  fi
  [[ -n "$p" ]] && answers="$(jq -c --arg q "$q" --argjson p "$p" '. + {($q): {type: "noul", noul: $p}}' <<<"$answers")"
done
if printf '%s' "$body" | jq -e '.questions.kind.type == "choice"' >/dev/null \
  && [[ "$state" =~ \[\[jev:(override|conflict|resolved|unrelated):([0-9.]+)\]\] ]]; then
  c="${BASH_REMATCH[1]}"; p="${BASH_REMATCH[2]}"
  answers="$(jq -c --arg c "$c" --argjson p "$p" '. + {kind: {type: "choice", choice: $c, probabilities: {($c): $p}}}' <<<"$answers")"
fi
if [[ "$answers" == '{}' ]]; then
  echo '<html>502</html>'
  exit 0
fi
jq -cn --argjson a "$answers" '{model: "typesafe-ai/jev", answers: $a, usage: {input_tokens: 1, output_tokens: 0}}'
FAKE
    chmod +x "$WORK/bin/curl"

    # ---- security stub (Keychain) ----
    cat >"$WORK/bin/security" <<'FAKE'
#!/usr/bin/env bash
exit "${FAKE_SECURITY_EXIT:-44}"
FAKE
    chmod +x "$WORK/bin/security"

    export GH_LOG CURL_LOG
    export PATH="$WORK/bin:$PATH"
    export AI_GATEWAY_API_KEY="vck_test_key"
    export JEV_KEYCHAIN_SERVICE="prerun-analyze-bats-nonexistent"
    unset DEVFLOW_JEV_DISABLE
}

# fixture <path> <title> <body> [comments_json] [author_login] [updated_at]
fixture() {
    local path="$1" title="$2" body="$3" comments="${4:-[]}" author="${5:-reporter}" updated="${6:-}"
    jq -n --arg title "$title" --arg body "$body" --argjson comments "$comments" --arg author "$author" --arg updated "$updated" \
        '{title: $title, state: "open", body: $body, labels: [], assignees: [], milestone: null, comments: $comments, author: {login: $author}}
         + (if $updated == "" then {} else {updatedAt: $updated} end)' \
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
    echo "$output" | jq -e '.breaking_keyword_scan == true and .breaking_change == false and (.uncertain | length) == 1 and (.uncertain[0] | test("Jev 応答なし（応答不正: bad response"))'
    [ "$(curl_calls)" -eq 1 ]
}

# ---- 互換性判定の 2 問分割（issue #728）----

@test "互換性判定は breaking / migration の 2 問を 1 request で聞き、読み込み時破棄を後方互換・変換不要と明示する" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:0.02]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    [ "$(curl_calls)" -eq 1 ]
    jq -e 'keys == ["breaking", "migration"] and .breaking.type == "noul" and .migration.type == "noul"' "$CURL_LOG.questions"
    jq -e '.breaking.instructions | test("後方互換") and test("読み込み時に無視・破棄")' "$CURL_LOG.questions"
    jq -e '.migration.instructions | test("既存データ") and test("読み込み時に無視・破棄")' "$CURL_LOG.questions"
}

@test "設定項目を削除し古い値は読み込み時に捨てる issue -> 互換性判定で uncertain にならない（breaking_change=false）" {
    fixture "$WORK/i.json" "feat: 設定項目 legacy_mode を削除する" "## 概要

設定項目 legacy_mode を削除する。古い値は読み込み時に捨てるので、既存の設定ファイルはそのまま読める。
既存データの変換（migration）は不要。

## 受け入れ基準

- [ ] legacy_mode を読まない
- [ ] 古い設定ファイルに legacy_mode があっても読み込みが成功する

[[jev:breaking:0.06]] [[jev:migration:0.03]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_keyword_scan == true and .analyze_path == "jev"'
    echo "$output" | jq -e '.breaking_change == false and .uncertain == [] and .comment_conflicts == []'
}

@test "互換性判定: どちらか一方が p>=0.9 -> breaking_change=true（根拠に両方の p）" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:breaking:0.04]] [[jev:migration:0.97]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_change == true and .uncertain == []'
    echo "$output" | jq -e '.breaking_evidence | test("p=0.04") and test("p=0.97")'
}

@test "互換性判定: 片方だけ低確信 -> uncertain に両方の p、明記の指示文は breaking キーワードを含まない" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:breaking:0.62]] [[jev:migration:0.03]]"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.breaking_change == false and (.uncertain | length) == 1 and (.uncertain[0] | test("p=0.62") and test("p=0.03"))'
    # 指示どおり body に書いた語で analyze-issue.sh のキーワード判定（breaking|incompatible|migration|破壊的|非互換）に
    # 再び掛からないこと
    echo "$output" | jq -e '.uncertain[0] | split("— ")[1] | (test("明記せよ") and (test("breaking|incompatible|migration|破壊的|非互換"; "i") | not))'
}

# ---- Jev が判定を返さない理由（issue #728）----

@test "Keychain ロック（security exit 36）-> uncertain に Keychain ロックと exit code が出る、curl 未呼び出し" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:0.95]]"
    unset AI_GATEWAY_API_KEY
    FAKE_SECURITY_EXIT=36 run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(.uncertain | length) == 1 and (.uncertain[0] | test("Keychain がロック中") and test("security exit 36"))'
    [ "$(curl_calls)" -eq 0 ]
}

@test "Keychain を読めない（sandbox 内等、security がその他の exit code）-> uncertain に読み取り失敗と exit code" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'a [[jev:override:0.99]]')]" reporter
    unset AI_GATEWAY_API_KEY
    FAKE_SECURITY_EXIT=51 run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.comment_conflicts == [] and (.uncertain | length) == 1 and (.uncertain[0] | test("comment #1 by alice") and test("Keychain から API 鍵を読めない") and test("security exit 51"))'
    [ "$(curl_calls)" -eq 0 ]
}

@test "Keychain に item が無い（security exit 44）-> uncertain に API 鍵なし" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:0.95]]"
    unset AI_GATEWAY_API_KEY
    FAKE_SECURITY_EXIT=44 run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.uncertain[0] | test("API 鍵が無い") and test("not found: security exit 44")'
}

@test "curl タイムアウト（exit 28）/ 通信失敗 -> uncertain に原因別の文言" {
    fixture "$WORK/i.json" "feat: migration" "$AC_BODY

[[jev:noul:0.95]]"
    FAKE_CURL_EXIT=28 run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.uncertain[0] | test("タイムアウト") and test("curl exit 28") and test("--max-time 10s")'
    FAKE_CURL_EXIT=7 run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.uncertain[0] | test("通信失敗") and test("curl exit 7")'
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

@test "comment の未決事項が本文で決着済み（resolved 高確信）-> comment_conflicts にも overrides にも積まない（issue #728）" {
    fixture "$WORK/i.json" "feat: 通知の再送間隔" "## 概要

通知の再送間隔を設定可能にする。

## 決定事項

再送間隔の既定値は 30 分とする（comment で挙がった 15 分 / 30 分の未決事項はこの本文で決着済み）。

## 受け入れ基準

- [ ] 再送間隔の既定値が 30 分
- [ ] 設定で再送間隔を変えられる" \
        "[$(comment alice OWNER '既定値は 15 分と 30 分のどちらにしますか？未決です。[[jev:resolved:0.96]]')]" reporter "2026-01-02T00:00:00Z"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.analyze_path == "jev" and .comment_conflicts == [] and .comment_overrides == [] and .uncertain == []'
    # choice に resolved があり、state に前後関係（issue updated_at > 最新 comment created_at）が載る
    tail -n 1 "$CURL_LOG.questions" | jq -e '.kind.criteria | keys == ["conflict", "override", "resolved", "unrelated"]'
    grep -q 'issue の updated_at: 2026-01-02T00:00:00Z' "$CURL_LOG.state"
    grep -q '最新 comment の created_at: 2026-01-01T00:00:00Z' "$CURL_LOG.state"
    grep -q 'issue は最新 comment より後に更新されている' "$CURL_LOG.state"
}

@test "comment 後に issue が更新されていない -> state に「後に更新されている」行を載せない" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'q [[jev:unrelated:0.98]]')]" reporter "2026-01-01T00:00:00Z"
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    grep -q 'issue の updated_at: 2026-01-01T00:00:00Z' "$CURL_LOG.state"
    ! grep -q 'issue は最新 comment より後に更新されている' "$CURL_LOG.state"
}

@test "comment resolved でも低確信（p<0.9）-> comment_conflicts（fail-closed）" {
    fixture "$WORK/i.json" "feat: x" "$AC_BODY" "[$(comment alice OWNER 'q [[jev:resolved:0.55]]')]" reporter
    run_analyze "$WORK/i.json"
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '(.comment_conflicts | length) == 1 and (.comment_conflicts[0] | startswith("low-confidence（resolved p=0.55"))'
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
