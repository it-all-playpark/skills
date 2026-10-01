#!/usr/bin/env bash
# gmail-cleanup: 共通の GAS (gas/Code.gs) を、各 repo の設定 JSON に書かれた
# アカウントごとの Apps Script プロジェクトへ反映する。
#
# Usage:
#   gmail-cleanup.sh list   <config.json>
#   gmail-cleanup.sh render <config.json> <target-id> <out-dir>
#   gmail-cleanup.sh deploy <config.json> <target-id|all>
#   gmail-cleanup.sh create <config.json> <target-id>
#
# 設定 JSON:
#   {
#     "defaults": { ...target と同じキー。各 target に下敷きとしてマージされる },
#     "targets": [
#       { "id": "company", "account": "me@example.com", "scriptId": "...",
#         "gwsConfigDir": "~/.config/gws/accounts/x",   # 任意。gws の設定ディレクトリ
#         "retentionDays": 30, "queries": ["category:promotions"],
#         "protectedLabelPrefixes": ["領収書"] }
#     ]
#   }
#
# 出力: 成功は標準出力に JSON 1行/target。失敗は標準エラーに {"status":"error","message":...}。
# Exit: 0 成功 / 1 設定・引数エラー / 4 gws 失敗
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAS_DIR="$SCRIPT_DIR/../gas"
PROJECT_TITLE="Gmail自動クリーンアップ"
MIN_RETENTION_DAYS=7

die() {
  local msg="$1" code="${2:-1}"
  jq -nc --arg m "$msg" '{status:"error", message:$m}' >&2
  exit "$code"
}

# 設定を読み、defaults をマージした targets 配列を返す。不正なら die。
# 空クエリは全メール一致になるので必ず弾く(fail-closed)。
load_targets() {
  local config="$1" errors
  [ -f "$config" ] || die "設定ファイルがありません: $config"
  jq -e . "$config" > /dev/null 2>&1 || die "JSON として読めません: $config"

  errors="$(jq -r --argjson min "$MIN_RETENTION_DAYS" '
    (.defaults // {}) as $d
    | if (.targets | type) != "array" or (.targets | length) == 0 then "targets が空です"
      else
        .targets[] | ($d * .) as $t | ($t.id // "?") as $id
        | (if ($t.id | type) != "string" or ($t.id | test("^[a-z0-9-]+$") | not)
             then "\($id): id は英小文字・数字・ハイフンで指定してください" else empty end),
          (if ($t.account | type) != "string" or $t.account == "" then "\($id): account がありません" else empty end),
          (if ($t.scriptId // "" | type) != "string" then "\($id): scriptId は文字列で指定してください" else empty end),
          (if ($t.retentionDays | type) != "number" or $t.retentionDays != ($t.retentionDays | floor) or $t.retentionDays < $min
             then "\($id): retentionDays は \($min) 以上の整数にしてください" else empty end),
          (if ($t.queries | type) != "array" or ($t.queries | length) == 0 then "\($id): queries が空です"
           elif any($t.queries[]; type != "string" or test("^\\s*$")) then "\($id): 空のクエリがあります(全メールが対象になるため不可)"
           else empty end),
          (if ($t.protectedLabelPrefixes | type) != "array" or any($t.protectedLabelPrefixes[]; type != "string" or . == "")
             then "\($id): protectedLabelPrefixes は空でない文字列の配列にしてください" else empty end)
      end
  ' "$config")"
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
    printf '// 生成物: gmail-cleanup.sh render が設定 JSON から作る。直接編集しない。\n'
    printf 'const CONFIG = %s;\n' "$(printf '%s' "$target" | jq '{retentionDays, queries, protectedLabelPrefixes}')"
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

gws_hint() {
  local target="$1" dir
  dir="$(printf '%s' "$target" | jq -r '.gwsConfigDir // empty')"
  if [ -n "$dir" ]; then
    printf 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR=%s gws auth login --services gmail,drive,script' "$dir"
  else
    printf 'gws auth login --services gmail,drive,script'
  fi
}

cmd_list() {
  load_targets "$1" | jq -c '.[] | {id, account, scriptId: (.scriptId // ""), retentionDays, queries, protectedLabelPrefixes}'
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
    out="$(mktemp -d "${TMPDIR:-/tmp}/gmail-cleanup.XXXXXX")"
    render_target "$target" "$out"
    rc=0
    gws_for "$target" script +push --script "$script_id" --dir "$out" > "$out.log" 2>&1 || rc=$?
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

  log="$(mktemp "${TMPDIR:-/tmp}/gmail-cleanup.XXXXXX")"
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

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    list)   [ $# -eq 1 ] || die "Usage: gmail-cleanup.sh list <config.json>"; cmd_list "$@" ;;
    render) [ $# -eq 3 ] || die "Usage: gmail-cleanup.sh render <config.json> <target-id> <out-dir>"; cmd_render "$@" ;;
    deploy) [ $# -eq 2 ] || die "Usage: gmail-cleanup.sh deploy <config.json> <target-id|all>"; cmd_deploy "$@" ;;
    create) [ $# -eq 2 ] || die "Usage: gmail-cleanup.sh create <config.json> <target-id>"; cmd_create "$@" ;;
    *) die "Usage: gmail-cleanup.sh {list|render|deploy|create} ..." ;;
  esac
}

main "$@"
