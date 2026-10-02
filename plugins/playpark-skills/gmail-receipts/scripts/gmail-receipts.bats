#!/usr/bin/env bats
# gmail-receipts.sh と gas/Code.gs のテスト。gws は PATH 先頭の偽物で置き換え、呼び出しを記録する。
# deploy / logs / 再ログイン案内の共通部分(_shared/scripts/gas-project.sh)は gmail-cleanup.bats が見る。

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/gmail-receipts.sh"
  GAS_DIR="$BATS_TEST_DIRNAME/../gas"
  WORK="$BATS_TEST_TMPDIR"
  export TMPDIR="$WORK/tmp"
  mkdir -p "$TMPDIR" "$WORK/bin"

  cat > "$WORK/bin/gws" <<'EOF'
#!/usr/bin/env bash
echo "args=$* cfg=${GOOGLE_WORKSPACE_CLI_CONFIG_DIR:-}" >> "$GWS_LOG"
if [ "$2" = "+push" ]; then cp config.gs "$GWS_LOG.$4.config.gs"; fi
if [ "$2" = "projects" ]; then echo "Using keyring backend: file"; echo '{"scriptId":"NEWID","title":"x"}'; fi
EOF
  chmod +x "$WORK/bin/gws"
  export PATH="$WORK/bin:$PATH"
  export GWS_LOG="$WORK/gws.log"

  cat > "$WORK/config.json" <<'EOF'
{
  "defaults": { "label": "領収書" },
  "targets": [
    { "id": "company", "account": "me@example.com", "scriptId": "SID-CO", "folderId": "FOLDER_co-1" },
    { "id": "ny", "account": "ny@example.com", "scriptId": "SID-NY", "gwsConfigDir": "~/gws/ny",
      "label": "経費/領収書", "folderId": "FOLDER_ny", "notifyEmail": "notify@example.com" }
  ]
}
EOF
}

write_config() { printf '%s\n' "$1" > "$WORK/bad.json"; }

@test "list: defaults をマージし、notifyEmail の既定は account" {
  run bash "$SCRIPT" list "$WORK/config.json"
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | jq -c '[.id, .label, .folderId, .notifyEmail]' | paste -sd ' ' -)" = '["company","領収書","FOLDER_co-1","me@example.com"] ["ny","経費/領収書","FOLDER_ny","notify@example.com"]' ]
}

@test "render: 共通 GAS と target の CONFIG を書き出し、scriptId やアカウント設定は含めない" {
  run bash "$SCRIPT" render "$WORK/config.json" ny "$WORK/out"
  [ "$status" -eq 0 ]
  cmp "$GAS_DIR/Code.gs" "$WORK/out/Code.gs"
  cmp "$GAS_DIR/appsscript.json" "$WORK/out/appsscript.json"
  json="$(sed '1d; s/^const CONFIG = //; s/^};$/}/' "$WORK/out/config.gs")"
  [ "$(printf '%s' "$json" | jq -c .)" = '{"label":"経費/領収書","folderId":"FOLDER_ny","notifyEmail":"notify@example.com"}' ]
  ! grep -q 'SID-NY\|gwsConfigDir' "$WORK/out/config.gs"
}

@test "deploy all: target ごとに設定を切り替えて push する" {
  run bash "$SCRIPT" deploy "$WORK/config.json" all
  [ "$status" -eq 0 ]
  grep -q "args=script +push --script SID-NY cfg=$HOME/gws/ny$" "$GWS_LOG"
  grep -q 'FOLDER_co-1' "$GWS_LOG.SID-CO.config.gs"
  grep -q 'FOLDER_ny' "$GWS_LOG.SID-NY.config.gs"
}

@test "create: この skill のプロジェクト名で作る" {
  write_config '{"targets":[{"id":"a","account":"a@x","scriptId":"","label":"領収書","folderId":"F"}]}'
  run bash "$SCRIPT" create "$WORK/bad.json" a
  [ "$status" -eq 0 ]
  grep -q 'args=script projects create --json {"title":"Gmail領収書のDrive保存"}' "$GWS_LOG"
}

@test "検証: label の欠落・前後の / や空白を拒否する" {
  for label in '""' '"/領収書"' '"領収書/"' '" 領収書"' '"領収書//AWS"' 'null'; do
    write_config "{\"targets\":[{\"id\":\"a\",\"account\":\"a@x\",\"scriptId\":\"S\",\"label\":$label,\"folderId\":\"F\"}]}"
    run bash "$SCRIPT" list "$WORK/bad.json"
    [ "$status" -eq 1 ]
    [[ "$output" == *"label は空でなく"* ]]
  done
  write_config '{"targets":[{"id":"a","account":"a@x","scriptId":"S","label":"経費/領収書 2026","folderId":"F"}]}'
  run bash "$SCRIPT" list "$WORK/bad.json"
  [ "$status" -eq 0 ]
}

@test "検証: folderId に URL を書いたら・notifyEmail がアドレスでなければ拒否する" {
  write_config '{"targets":[{"id":"a","account":"a@x","scriptId":"S","label":"領収書","folderId":"https://drive.google.com/drive/folders/F","notifyEmail":"me"}]}'
  run bash "$SCRIPT" list "$WORK/bad.json"
  [ "$status" -eq 1 ]
  [[ "$output" == *"folderId には Drive フォルダの ID"* ]]
  [[ "$output" == *"notifyEmail はメールアドレス"* ]]
}

# 使い方: simulate <collect|dryRun|setup> <state-json>
simulate() {
  bash "$SCRIPT" render "$WORK/config.json" company "$WORK/out" > /dev/null
  printf '%s\n' "$2" > "$WORK/state.json"
  node "$BATS_TEST_DIRNAME/gas-sim.js" "$WORK/out" "$1" "$WORK/state.json"
}

STATE='{
  "folderId": "FOLDER_co-1",
  "existing": ["2026/09/2026-09-20_AWS_dup.pdf"],
  "threads": [
    { "id": "t-aws", "labels": ["領収書/AWS"], "inbox": true, "messages": [
      { "date": "2026-09-30T16:30:00Z", "subject": "Invoice", "attachments": [
        { "name": "invoice.pdf" }, { "name": "logo.png", "inline": true } ] } ] },
    { "id": "t-nested", "labels": ["領収書", "領収書/AWS/JP"], "inbox": true, "messages": [
      { "date": "2026-09-12T01:00:00Z", "subject": "ご利用明細" } ] },
    { "id": "t-top", "labels": ["領収書"], "inbox": true, "messages": [
      { "date": "2026-09-13T01:00:00Z", "subject": "a/b receipt" } ] },
    { "id": "t-dup", "labels": ["領収書/AWS"], "inbox": true, "messages": [
      { "date": "2026-09-20T01:00:00Z", "attachments": [{ "name": "dup.pdf" }] } ] },
    { "id": "t-archived", "labels": ["領収書/AWS"], "inbox": false, "messages": [
      { "date": "2026-09-14T01:00:00Z", "attachments": [{ "name": "old.pdf" }] } ] },
    { "id": "t-lookalike", "labels": ["領収書以外"], "inbox": true, "messages": [
      { "date": "2026-09-15T01:00:00Z", "attachments": [{ "name": "x.pdf" }] } ] }
  ]
}'

@test "Code.gs: 受信トレイの対象ラベルのスレッドを YYYY/MM/日付_発行元_名前 で保存してアーカイブする" {
  run simulate collect "$STATE"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r .error)" = null ]
  # 日付は Asia/Tokyo (16:30Z は翌日)。インライン画像・同名ファイルは保存しない。
  # 配下ラベルの階層は - でつなぐ。発行元の無い親ラベルだけのスレッドは日付_件名.pdf
  [ "$(printf '%s' "$output" | jq -c .files)" = '["2026/09/2026-09-12_AWS-JP_ご利用明細.pdf","2026/09/2026-09-13_a_b receipt.pdf","2026/10/2026-10-01_AWS_invoice.pdf"]' ]
  [ "$(printf '%s' "$output" | jq -c '.archived | sort')" = '["t-aws","t-dup","t-nested","t-top"]' ]
}

@test "Code.gs: 保存したら件数と一覧を notifyEmail に送る" {
  run simulate collect "$STATE"
  [ "$(printf '%s' "$output" | jq -c '[.mails[] | [.to, .subject]]')" = '[["me@example.com","領収書を保存しました"]]' ]
  [[ "$(printf '%s' "$output" | jq -r '.mails[0].body')" == "保存: 3 件"* ]]
}

@test "Code.gs: 対象が無ければメールを送らない" {
  run simulate collect '{"folderId":"FOLDER_co-1","threads":[{"id":"t","labels":["領収書"],"inbox":false,"messages":[]}]}'
  [ "$(printf '%s' "$output" | jq -c '[.files, .archived, .mails]')" = '[[],[],[]]' ]
}

@test "Code.gs: dryRun は保存もアーカイブもメールもせず、保存名をログに出す" {
  run simulate dryRun "$STATE"
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '[.files, .archived, .mails]')" = '[[],[],[]]' ]
  [ "$(printf '%s' "$output" | jq -c '[.logs[] | select(startswith("[dry-run] 2026/"))] | sort')" = '["[dry-run] 2026/09/2026-09-12_AWS-JP_ご利用明細.pdf","[dry-run] 2026/09/2026-09-13_a_b receipt.pdf","[dry-run] 2026/10/2026-10-01_AWS_invoice.pdf"]' ]
}

@test "Code.gs: Drive フォルダが見つからなければエラーメールを送って失敗する" {
  run simulate collect '{"folderId":"OTHER","threads":[]}'
  [ "$(printf '%s' "$output" | jq -r .error)" != null ]
  [ "$(printf '%s' "$output" | jq -r '.mails[0].subject')" = "領収書の保存中にエラーが発生しました" ]
}

@test "Code.gs: ラベルが無ければエラーにする(フィルタの付け忘れに気づけるように)" {
  run simulate collect '{"folderId":"FOLDER_co-1","threads":[{"id":"t","labels":["その他"],"inbox":true,"messages":[]}]}'
  [[ "$(printf '%s' "$output" | jq -r .error)" == *"ラベル「領収書」がありません"* ]]
}

@test "Code.gs: 時間切れになったら残りのスレッドに手を付けずに終わる" {
  # Date.now() のたびに 3分進む → 2つ目のスレッドに入る前に 4分の予算を超える
  SIM_TICK_MS=180000 run simulate collect "$STATE"
  [ "$(printf '%s' "$output" | jq .threadCalls)" = 1 ]
  [ "$(printf '%s' "$output" | jq '.archived | length')" = 1 ]
  [[ "$(printf '%s' "$output" | jq -r '.mails[0].body')" == *"時間切れ"* ]]
}

@test "Code.gs: setup は旧コードのトリガーを消して collect の日次トリガーを1つ作る" {
  run simulate setup '{"folderId":"FOLDER_co-1","triggers":["saveRecipts","collect"],"threads":[]}'
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c .triggers)" = '[{"handler":"collect","hour":0}]' ]
}
