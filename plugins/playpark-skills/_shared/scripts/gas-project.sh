# gas-project.sh: 共通の GAS コード (<skill>/gas/) を、各 repo の設定 JSON に書かれた
# アカウントごとの Apps Script プロジェクトへ gws 経由で反映する CLI の土台。
# source して使う。GAS の Gmail / Drive 操作は所有アカウントにしか届かないので、
# アカウントごとにプロジェクトが1つ要る。
#
# source する側が定義するもの:
#   GAS_SKILL       skill 名(Usage と一時ファイル名に使う)
#   GAS_DIR         Code.gs と appsscript.json のあるディレクトリ
#   PROJECT_TITLE   create で作る Apps Script プロジェクトの名前
#   gas_validate    jq フィルタ。入力は defaults をマージした target 1件、$id はその id。
#                   エラー文字列を0個以上出す(共通キーの検証はこちらで済ませる)
#   gas_config      jq フィルタ。target 1件から config.gs の CONFIG を作る。
#                   scriptId・account・gwsConfigDir は GAS 側に要らないので含めない
#   gas_list        jq フィルタ。list で出す target 1件の要約
# その後 `gas_main "$@"` を呼ぶ。
#
# 設定 JSON:
#   {
#     "defaults": { ...target と同じキー。各 target に下敷きとしてマージされる },
#     "targets": [
#       { "id": "company", "account": "me@example.com", "scriptId": "...",
#         "gwsConfigDir": "~/.config/gws/accounts/x",   # 任意。gws の設定ディレクトリ
#         ...skill 固有のキー }
#     ]
#   }
#
# 出力: 成功は標準出力に JSON 1行/target。失敗は標準エラーに {"status":"error","message":...}。
# Exit: 0 成功 / 1 設定・引数エラー / 4 gws 失敗

die() {
  local msg="$1" code="${2:-1}"
  jq -nc --arg m "$msg" '{status:"error", message:$m}' >&2
  exit "$code"
}

# 設定を読み、defaults をマージした targets 配列を返す。不正なら die。
load_targets() {
  local config="$1" errors
  [ -f "$config" ] || die "設定ファイルがありません: $config"
  jq -e . "$config" > /dev/null 2>&1 || die "JSON として読めません: $config"

  errors="$(jq -r "
    (.defaults // {}) as \$d
    | if (.targets | type) != \"array\" or (.targets | length) == 0 then \"targets が空です\"
      else
        .targets[] | (\$d * .) as \$t | (\$t.id // \"?\") as \$id
        | (if (\$t.id | type) != \"string\" or (\$t.id | test(\"^[a-z0-9-]+\$\") | not)
             then \"\(\$id): id は英小文字・数字・ハイフンで指定してください\" else empty end),
          (if (\$t.account | type) != \"string\" or \$t.account == \"\" then \"\(\$id): account がありません\" else empty end),
          (if (\$t.scriptId // \"\" | type) != \"string\" then \"\(\$id): scriptId は文字列で指定してください\" else empty end),
          (\$t | $(gas_validate))
      end
  " "$config")"
  [ -z "$errors" ] || die "設定エラー ($config): $(printf '%s' "$errors" | paste -sd ';' -)"

  jq -c '(.defaults // {}) as $d | [.targets[] | $d * .]' "$config"
}

# 使い方: select_targets <targets-json> <id|all>
select_targets() {
  local targets="$1" sel="$2" out
  if [ "$sel" = "all" ]; then
    printf '%s' "$targets" | jq -c '.[]'
    return
  fi
  out="$(printf '%s' "$targets" | jq -c --arg id "$sel" '.[] | select(.id == $id)')"
  [ -n "$out" ] || die "未知の target: $sel (候補: $(printf '%s' "$targets" | jq -r '[.[].id] | join(", ")'))"
  printf '%s\n' "$out"
}

render_target() {
  local target="$1" out="$2"
  mkdir -p "$out"
  cp "$GAS_DIR/Code.gs" "$GAS_DIR/appsscript.json" "$out/"
  {
    printf '// 生成物: %s.sh render が設定 JSON から作る。直接編集しない。\n' "$GAS_SKILL"
    printf 'const CONFIG = %s;\n' "$(printf '%s' "$target" | jq "$(gas_config)")"
  } > "$out/config.gs"
}

# 使い方: gws_for <target-json> <gws args...>
gws_for() {
  local target="$1" dir
  shift
  dir="$(printf '%s' "$target" | jq -r '.gwsConfigDir // empty')"
  if [ -n "$dir" ]; then
    dir="${dir/#\~/$HOME}"
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$dir" gws "$@"
  else
    gws "$@"
  fi
}

# この土台が使う Apps Script API のスコープ(push / create と、実行履歴の取得)
SCRIPT_SCOPES='["https://www.googleapis.com/auth/script.projects","https://www.googleapis.com/auth/script.processes"]'

# 再ログインのコマンドを返す。`--services script` では script.* スコープが付かないので、
# 今のトークンのスコープに SCRIPT_SCOPES を足した --scopes を組み立てる(他の用途の権限を落とさない)。
gws_hint() {
  local target="$1" dir prefix="" scopes
  dir="$(printf '%s' "$target" | jq -r '.gwsConfigDir // empty')"
  [ -n "$dir" ] && prefix="GOOGLE_WORKSPACE_CLI_CONFIG_DIR=$dir "
  scopes="$(gws_for "$target" auth status 2> /dev/null \
    | jq -r --argjson add "$SCRIPT_SCOPES" '(.scopes // []) | select(length > 0) | . + $add | unique | join(",")' 2> /dev/null || true)"
  if [ -n "$scopes" ]; then
    printf "%sgws auth logout の後、%sgws auth login --scopes '%s'" "$prefix" "$prefix" "$scopes"
  else
    printf '%sgws auth login で再ログイン。scope 不足なら今のスコープ(gws auth status の scopes)に %s を足して --scopes で指定する(--services script では付かない)' \
      "$prefix" "$(printf '%s' "$SCRIPT_SCOPES" | jq -r 'join(" と ")')"
  fi
}

cmd_list() {
  load_targets "$1" | jq -c ".[] | {id, account, scriptId: (.scriptId // \"\")} + ($(gas_list))"
}

cmd_render() {
  local targets target
  targets="$(load_targets "$1")"
  target="$(select_targets "$targets" "$2")"
  render_target "$target" "$3"
  jq -nc --arg id "$2" --arg dir "$3" '{status:"ok", target:$id, dir:$dir}'
}

cmd_deploy() {
  local targets list target id script_id out rc
  targets="$(load_targets "$1")"
  list="$(select_targets "$targets" "$2")"

  # 1件でも scriptId が無ければ何も push しない(途中まで反映された状態を作らない)
  while IFS= read -r target; do
    [ -n "$(printf '%s' "$target" | jq -r '.scriptId // empty')" ] \
      || die "$(printf '%s' "$target" | jq -r .id): scriptId が未設定です。先に create してください"
  done <<< "$list"

  while IFS= read -r target; do
    id="$(printf '%s' "$target" | jq -r .id)"
    script_id="$(printf '%s' "$target" | jq -r .scriptId)"
    out="$(mktemp -d "${TMPDIR:-/tmp}/$GAS_SKILL.XXXXXX")"
    render_target "$target" "$out"
    rc=0
    # gws の --dir は相対パスしか受け付けないので、out に入ってカレントを push させる
    (cd "$out" && gws_for "$target" script +push --script "$script_id") > "$out.log" 2>&1 || rc=$?
    if [ "$rc" != "0" ]; then
      die "$id: push に失敗しました: $(tr '\n' ' ' < "$out.log")。認証やスコープ不足なら: $(gws_hint "$target")" 4
    fi
    rm -rf "$out" "$out.log"
    jq -nc --arg id "$id" --arg s "$script_id" '{status:"ok", target:$id, scriptId:$s, action:"deployed"}'
  done <<< "$list"
}

cmd_create() {
  local targets target id log rc script_id
  targets="$(load_targets "$1")"
  target="$(select_targets "$targets" "$2")"
  id="$(printf '%s' "$target" | jq -r .id)"
  [ -z "$(printf '%s' "$target" | jq -r '.scriptId // empty')" ] \
    || die "$id: scriptId が既にあります。作り直す場合は設定から消してから実行してください"

  log="$(mktemp "${TMPDIR:-/tmp}/$GAS_SKILL.XXXXXX")"
  rc=0
  gws_for "$target" script projects create --json "$(jq -nc --arg t "$PROJECT_TITLE" '{title:$t}')" > "$log" 2>&1 || rc=$?
  if [ "$rc" != "0" ]; then
    die "$id: プロジェクト作成に失敗しました: $(tr '\n' ' ' < "$log")。認証やスコープ不足なら: $(gws_hint "$target")" 4
  fi
  # gws は JSON の前に "Using keyring backend: file" 等を出すことがあるので落とす
  script_id="$(awk 'f || /^[[{]/ { f=1; print }' "$log" | jq -r '.scriptId // empty')"
  rm -f "$log"
  [ -n "$script_id" ] || die "$id: 作成結果に scriptId がありません" 4
  jq -nc --arg id "$id" --arg s "$script_id" \
    '{status:"ok", target:$id, scriptId:$s, action:"created", next:"設定 JSON の scriptId に書いてから deploy する"}'
}

# 直近の実行履歴(関数名・状態・開始時刻・所要時間)を1行1件で返す。
# 状態が FAILED / TIMED_OUT なら、エディタの「実行数」でそのログを見る。
cmd_logs() {
  local targets list target id script_id log rc limit="${3:-10}"
  [[ "$limit" =~ ^[1-9][0-9]*$ ]] || die "件数は正の整数で指定してください: $limit"
  targets="$(load_targets "$1")"
  list="$(select_targets "$targets" "$2")"

  while IFS= read -r target; do
    id="$(printf '%s' "$target" | jq -r .id)"
    script_id="$(printf '%s' "$target" | jq -r '.scriptId // empty')"
    [ -n "$script_id" ] || die "$id: scriptId が未設定です"
    log="$(mktemp "${TMPDIR:-/tmp}/$GAS_SKILL.XXXXXX")"
    rc=0
    gws_for "$target" script processes listScriptProcesses \
      --params "$(jq -nc --arg s "$script_id" --argjson n "$limit" '{scriptId:$s, pageSize:$n}')" > "$log" 2>&1 || rc=$?
    if [ "$rc" != "0" ]; then
      die "$id: 実行履歴の取得に失敗しました: $(tr '\n' ' ' < "$log")。認証やスコープ不足なら: $(gws_hint "$target")" 4
    fi
    awk 'f || /^[[{]/ { f=1; print }' "$log" | jq -c --arg id "$id" \
      '(.processes // [])[] | {target:$id, function:.functionName, type:.processType, status:.processStatus, startTime, duration}'
    rm -f "$log"
  done <<< "$list"
}

gas_main() {
  local cmd="${1:-}" s="$GAS_SKILL.sh"
  shift || true
  case "$cmd" in
    list)   [ $# -eq 1 ] || die "Usage: $s list <config.json>"; cmd_list "$@" ;;
    render) [ $# -eq 3 ] || die "Usage: $s render <config.json> <target-id> <out-dir>"; cmd_render "$@" ;;
    deploy) [ $# -eq 2 ] || die "Usage: $s deploy <config.json> <target-id|all>"; cmd_deploy "$@" ;;
    create) [ $# -eq 2 ] || die "Usage: $s create <config.json> <target-id>"; cmd_create "$@" ;;
    logs)   [ $# -eq 2 ] || [ $# -eq 3 ] || die "Usage: $s logs <config.json> <target-id|all> [件数]"; cmd_logs "$@" ;;
    *) die "Usage: $s {list|render|deploy|create|logs} ..." ;;
  esac
}
