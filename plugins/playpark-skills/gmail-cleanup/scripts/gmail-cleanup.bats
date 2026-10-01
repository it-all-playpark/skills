#!/usr/bin/env bats
# gmail-cleanup.sh のテスト。gws は PATH 先頭の偽物で置き換え、呼び出しを記録する。

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/gmail-cleanup.sh"
  GAS_DIR="$BATS_TEST_DIRNAME/../gas"
  WORK="$BATS_TEST_TMPDIR"
  export TMPDIR="$WORK/tmp"
  mkdir -p "$TMPDIR" "$WORK/bin"

  # 偽 gws: 引数・設定ディレクトリ・push された config.gs を記録する
  # 本物の +push は --dir に絶対パスを渡すと validationError で落ち、省略時はカレントを使う
  cat > "$WORK/bin/gws" <<'EOF'
#!/usr/bin/env bash
if [ "$1 $2" = "auth status" ]; then
  [ -n "${GWS_SCOPES:-}" ] || exit 1
  echo "{\"scopes\":$GWS_SCOPES}"; exit 0
fi
echo "args=$* cfg=${GOOGLE_WORKSPACE_CLI_CONFIG_DIR:-}" >> "$GWS_LOG"
if [ "$2" = "+push" ]; then
  dir="."
  [ "${5:-}" = "--dir" ] && dir="$6"
  case "$dir" in /*) echo "--dir must be a relative path, got absolute path '$dir'" >&2; exit 3 ;; esac
  cp "$dir/config.gs" "$GWS_LOG.$4.config.gs"
  [ -f "$dir/Code.gs" ] && [ -f "$dir/appsscript.json" ] || exit 9
fi
if [ "${GWS_FAIL:-}" = "1" ]; then echo "insufficient authentication scopes" >&2; exit 1; fi
if [ "$2" = "projects" ]; then echo "Using keyring backend: file"; echo '{"scriptId":"NEWID","title":"x"}'; fi
if [ "$2" = "processes" ]; then
  echo "Using keyring backend: file"
  echo '{"processes":[{"projectName":"p","functionName":"cleanup","processType":"TIME_DRIVEN","processStatus":"TIMED_OUT","startTime":"2026-10-01T19:00:03Z","duration":"360.1s"}]}'
fi
EOF
  chmod +x "$WORK/bin/gws"
  export PATH="$WORK/bin:$PATH"
  export GWS_LOG="$WORK/gws.log"

  cat > "$WORK/config.json" <<'EOF'
{
  "defaults": {
    "retentionDays": 30,
    "queries": ["category:promotions"],
    "protectedLabelPrefixes": ["po"]
  },
  "targets": [
    { "id": "ny", "account": "ny@example.com", "scriptId": "SID-NY", "gwsConfigDir": "~/gws/ny" },
    { "id": "company", "account": "me@example.com", "scriptId": "SID-CO",
      "queries": ["category:promotions", "label:Blocked"],
      "protectedLabelPrefixes": ["領収書", "永久保存メール"] }
  ]
}
EOF
}

write_config() { printf '%s\n' "$1" > "$WORK/bad.json"; }

@test "list: defaults を各 target にマージする" {
  run bash "$SCRIPT" list "$WORK/config.json"
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | sed -n 1p | jq -c '[.id, .retentionDays, .queries, .protectedLabelPrefixes]')" = '["ny",30,["category:promotions"],["po"]]' ]
  [ "$(printf '%s\n' "$output" | sed -n 2p | jq -c '[.id, .queries, .protectedLabelPrefixes]')" = '["company",["category:promotions","label:Blocked"],["領収書","永久保存メール"]]' ]
}

@test "render: 共通 GAS と target の CONFIG を書き出す" {
  run bash "$SCRIPT" render "$WORK/config.json" company "$WORK/out"
  [ "$status" -eq 0 ]
  cmp "$GAS_DIR/Code.gs" "$WORK/out/Code.gs"
  cmp "$GAS_DIR/appsscript.json" "$WORK/out/appsscript.json"
  json="$(sed '1d; s/^const CONFIG = //; s/^};$/}/' "$WORK/out/config.gs")"
  [ "$(printf '%s' "$json" | jq -c .)" = '{"retentionDays":30,"queries":["category:promotions","label:Blocked"],"protectedLabelPrefixes":["領収書","永久保存メール"]}' ]
}

@test "render: CONFIG に scriptId やアカウント情報を含めない" {
  bash "$SCRIPT" render "$WORK/config.json" ny "$WORK/out"
  ! grep -q 'SID-NY\|ny@example.com\|gwsConfigDir' "$WORK/out/config.gs"
}

@test "deploy all: target ごとに scriptId と gws 設定ディレクトリを切り替えて push する" {
  run bash "$SCRIPT" deploy "$WORK/config.json" all
  [ "$status" -eq 0 ]
  grep -q "args=script +push --script SID-NY cfg=$HOME/gws/ny$" "$GWS_LOG"
  grep -q "args=script +push --script SID-CO cfg=$" "$GWS_LOG"
  grep -q 'label:Blocked' "$GWS_LOG.SID-CO.config.gs"
  ! grep -q 'label:Blocked' "$GWS_LOG.SID-NY.config.gs"
  [ "$(printf '%s\n' "$output" | jq -r .action | sort -u)" = "deployed" ]
}

@test "deploy: scriptId が無い target が混ざっていたら1件も push しない" {
  write_config '{"defaults":{"retentionDays":30,"queries":["q"],"protectedLabelPrefixes":[]},
    "targets":[{"id":"a","account":"a@x","scriptId":"SA"},{"id":"b","account":"b@x","scriptId":""}]}'
  run bash "$SCRIPT" deploy "$WORK/bad.json" all
  [ "$status" -eq 1 ]
  [[ "$output" == *"b: scriptId が未設定"* ]]
  [ ! -f "$GWS_LOG" ]
}

@test "deploy: gws が失敗したら exit 4 と再ログイン方法を返す" {
  GWS_FAIL=1 run bash "$SCRIPT" deploy "$WORK/config.json" ny
  [ "$status" -eq 4 ]
  [[ "$output" == *"insufficient authentication scopes"* ]]
  [[ "$output" == *"GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/gws/ny gws auth login で再ログイン"* ]]
  [[ "$output" == *"script.projects"* ]]
}

@test "deploy: 失敗時は今のスコープに script.projects / script.processes を足した --scopes を案内する" {
  GWS_FAIL=1 GWS_SCOPES='["openid","https://www.googleapis.com/auth/gmail.modify","https://www.googleapis.com/auth/script.projects"]' \
    run bash "$SCRIPT" deploy "$WORK/config.json" ny
  [ "$status" -eq 4 ]
  [[ "$output" == *"GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/gws/ny gws auth login --scopes 'https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/script.processes,https://www.googleapis.com/auth/script.projects,openid'"* ]]
  [[ "$output" != *"--services"* ]]
}

@test "logs: target ごとに実行履歴を1行1件で返す" {
  run bash "$SCRIPT" logs "$WORK/config.json" all 5
  [ "$status" -eq 0 ]
  grep -q "args=script processes listScriptProcesses --params {\"scriptId\":\"SID-NY\",\"pageSize\":5} cfg=$HOME/gws/ny$" "$GWS_LOG"
  [ "$(printf '%s\n' "$output" | jq -c '[.target, .function, .status, .duration]' | paste -sd ' ' -)" = '["ny","cleanup","TIMED_OUT","360.1s"] ["company","cleanup","TIMED_OUT","360.1s"]' ]
}

@test "logs: 取得に失敗したら exit 4 と script.processes を含む再ログイン方法を返す" {
  GWS_FAIL=1 run bash "$SCRIPT" logs "$WORK/config.json" ny
  [ "$status" -eq 4 ]
  [[ "$output" == *"実行履歴の取得に失敗"*"script.processes"* ]]
  run bash "$SCRIPT" logs "$WORK/config.json" ny 0
  [ "$status" -eq 1 ]
}

@test "deploy: 未知の target は候補を出して失敗する" {
  run bash "$SCRIPT" deploy "$WORK/config.json" nope
  [ "$status" -eq 1 ]
  [[ "$output" == *"未知の target: nope"*"ny, company"* ]]
}

@test "create: scriptId が空の target にプロジェクトを作って ID を返す" {
  write_config '{"targets":[{"id":"a","account":"a@x","scriptId":"","retentionDays":30,"queries":["q"],"protectedLabelPrefixes":[]}]}'
  run bash "$SCRIPT" create "$WORK/bad.json" a
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r .scriptId)" = "NEWID" ]
  grep -q 'args=script projects create --json {"title":"Gmail自動クリーンアップ"}' "$GWS_LOG"
}

@test "create: scriptId が既にある target は作らない" {
  run bash "$SCRIPT" create "$WORK/config.json" ny
  [ "$status" -eq 1 ]
  [ ! -f "$GWS_LOG" ]
}

@test "検証: 空白だけのクエリは全メール一致になるので拒否する" {
  write_config '{"targets":[{"id":"a","account":"a@x","scriptId":"S","retentionDays":30,"queries":["category:promotions","  "],"protectedLabelPrefixes":[]}]}'
  run bash "$SCRIPT" list "$WORK/bad.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"空のクエリ"* ]]
}

@test "検証: queries が空配列なら拒否する" {
  write_config '{"targets":[{"id":"a","account":"a@x","scriptId":"S","retentionDays":30,"queries":[],"protectedLabelPrefixes":[]}]}'
  run bash "$SCRIPT" list "$WORK/bad.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"queries が空"* ]]
}

@test "検証: retentionDays が下限未満・小数なら拒否する" {
  write_config '{"targets":[{"id":"a","account":"a@x","scriptId":"S","retentionDays":3,"queries":["q"],"protectedLabelPrefixes":[]}]}'
  run bash "$SCRIPT" list "$WORK/bad.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"retentionDays は 7 以上"* ]]
  write_config '{"targets":[{"id":"a","account":"a@x","scriptId":"S","retentionDays":30.5,"queries":["q"],"protectedLabelPrefixes":[]}]}'
  run bash "$SCRIPT" list "$WORK/bad.json"
  [ "$status" -eq 1 ]
}

@test "検証: 必須キー欠落・空ラベル・JSON 不正を拒否する" {
  write_config '{"targets":[{"id":"a","scriptId":"S","retentionDays":30,"queries":["q"],"protectedLabelPrefixes":[""]}]}'
  run bash "$SCRIPT" list "$WORK/bad.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"account がありません"* ]]
  [[ "$output" == *"protectedLabelPrefixes"* ]]
  write_config '{"targets":'
  run bash "$SCRIPT" list "$WORK/bad.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"JSON として読めません"* ]]
}

simulate() {
  bash "$SCRIPT" render "$WORK/config.json" company "$WORK/out" > /dev/null
  # 1行 = 1メール。threadId が同じものは同じスレッド
  cat > "$WORK/messages.json" <<'EOF'
[
  { "id": "old-promo",        "query": "category:promotions", "ageDays": 40 },
  { "id": "old-blocked",      "query": "label:Blocked",       "ageDays": 90 },
  { "id": "reply-old",        "threadId": "t-reply",   "query": "category:promotions", "ageDays": 40 },
  { "id": "reply-new",        "threadId": "t-reply",   "query": "other",               "ageDays": 5 },
  { "id": "star-old",         "threadId": "t-star",    "query": "category:promotions", "ageDays": 40 },
  { "id": "star-other",       "threadId": "t-star",    "query": "other",               "ageDays": 40, "starred": true },
  { "id": "trash-reply-old",  "threadId": "t-trashed", "query": "category:promotions", "ageDays": 40 },
  { "id": "trash-reply-new",  "threadId": "t-trashed", "query": "other",               "ageDays": 3, "trashed": true },
  { "id": "receipt-child",    "query": "category:promotions", "ageDays": 40, "labels": ["領収書/2026"] },
  { "id": "keep-exact",       "query": "label:Blocked",       "ageDays": 40, "labels": ["永久保存メール"] },
  { "id": "prefix-lookalike", "query": "category:promotions", "ageDays": 40, "labels": ["領収書以外"] }
]
EOF
  node "$BATS_TEST_DIRNAME/gas-sim.js" "$WORK/out" "$1" "$WORK/messages.json"
}

@test "Code.gs: 各クエリに older_than と -is:starred を付けて検索する" {
  run simulate cleanup
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '[.searched[] | select(test("older_than"))]')" = '["category:promotions older_than:30d -is:starred","label:Blocked older_than:30d -is:starred"]' ]
}

@test "Code.gs: スター・保護ラベル(配下含む)・新しい返信(ゴミ箱内も)を含むスレッドを残し、それ以外をゴミ箱へ移す" {
  run simulate cleanup
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '.trashed - ["trash-reply-new"]')" = '["old-blocked","old-promo","prefix-lookalike"]' ]
}

@test "Code.gs: dryRun は何もゴミ箱へ移さない" {
  run simulate dryRun
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c .trashed)" = '["trash-reply-new"]' ]
  [ "$(printf '%s' "$output" | jq .modifyCalls)" = 0 ]
}

@test "Code.gs: 大量のメールを 500件ずつ列挙し 1000件ずつまとめてゴミ箱へ移す" {
  bash "$SCRIPT" render "$WORK/config.json" ny "$WORK/out" > /dev/null
  jq -n '[range(2500) | {id: "m\(.)", query: "category:promotions", ageDays: 40}]' > "$WORK/many.json"
  run node "$BATS_TEST_DIRNAME/gas-sim.js" "$WORK/out" cleanup "$WORK/many.json"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq '.trashed | length')" = 2500 ]
  [ "$(printf '%s' "$output" | jq .modifyCalls)" = 3 ]
  # is:starred + newer_than (各1ページ) + 候補 5ページ
  [ "$(printf '%s' "$output" | jq .listCalls)" = 7 ]
}

@test "Code.gs: 残すスレッドを集めきる前に時間切れになったら何も消さない" {
  # Date.now() のたびに 1.5分進む → 3つ目の残す対象(保護ラベル)の列挙前に 4分の予算を超える
  SIM_TICK_MS=90000 run simulate cleanup
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq .modifyCalls)" = 0 ]
  [ "$(printf '%s' "$output" | jq -c '.trashed - ["trash-reply-new"]')" = '[]' ]
}
