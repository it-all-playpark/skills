#!/usr/bin/env bash
# jev-classify.sh: Jev（TypeSafe の判定専用モデル）に有界な質問を投げる共通スクリプト
#
# 正本はこのファイル（plugins/dev-flow/_shared/scripts/）。dotfiles の
# claude-code/hooks/jev-classify.sh は hook 用の複製で、変更は両方に同じ内容で入れる。
#
# 目的:
#   「read_only か / どの失敗種別か / この comment は body を上書きしているか」のような、
#   正規表現では書けないが答えが有界（選択肢・yes/no・段階）な意味判定を安価に得る。
#   Jev は文章を生成せず、各選択肢の較正済み確率を返す。呼び出し側は確率を閾値で
#   切って決定論に落とし、低確信は fail-closed（uncertain）側へ倒す。
#   dev-flow では prerun（dev-flow-prerun → prerun-analyze.sh）が issue の breaking 判定と
#   comment の override/conflict/resolved 判定に使う。呼び出しは常に `--redact` と
#   `--reason-file` 付き。
#
# 経路:
#   Vercel AI Gateway の TypeSafe 互換エンドポイントを curl で直叩きする。
#   jevctl / Node は不要。課金は AI Gateway（list price そのまま、markup 0、
#   入力 $0.042/M tokens、出力無料）。
#     POST https://ai-gateway.vercel.sh/typesafe/v1/systemone
#     Authorization: Bearer <AI Gateway API key (vck_…)>
#
# 使い方:
#   echo "<state>" | jev-classify.sh --questions '<questions JSON>'
#     --questions  TypeSafe API の questions オブジェクト（必須）
#                  例: {"kind":{"type":"choice","instructions":"…",
#                        "criteria":{"a":"…","b":"…"}}}
#                  type は noul (yes/no) / choice / score
#     --max-time   curl の上限秒（既定 $JEV_MAX_TIME または 2）
#     --redact     送信前に state から token / password / api-key 系の値、
#                  URL 埋め込み credential（://user:pass@）、既知の鍵プレフィックス
#                  （vck_ ghp_ sk- AKIA 等）を伏せる
#     --reason-file <path>
#                  失敗時にその理由を 1 行で書き出す（成功時は書かない）。呼び出し側が
#                  「応答なし」を原因別（no API key / keychain unreachable / keychain read failed /
#                  broker unreachable / broker request failed / timeout / request failed /
#                  bad response 等）に人間へ示すためのもの
#   stdout: API レスポンス JSON（.answers.<id> に結果）。失敗時は空
#   exit:   常に 0（fail-open。hook の本処理を止めない）
#
# 経路の選択順:
#   1. $AI_GATEWAY_API_KEY があれば直接呼ぶ（テスト・一時上書き用）
#   2. jev-broker のソケット（$JEV_BROKER_SOCKET）があれば broker 経由。鍵はこのプロセスに来ない
#   3. どちらも無ければ macOS Keychain から鍵を読んで直接呼ぶ:
#      security find-generic-password -s $JEV_KEYCHAIN_SERVICE -w
#      登録: security add-generic-password -s vercel-ai-gateway -a claude-hooks -w 'vck_…'
#   Claude の Bash ツール環境に鍵を露出させないため、env ではなく Keychain を主とする。
#   Keychain の解除は監査セッションごとに効くので、sandbox 内の Bash と Claude Code の bg job
#   からは解除済みでも security が exit 36 になる。jev-broker（dotfiles の gui ドメイン
#   LaunchAgent）が Aqua セッションで鍵を読んで中継するのはこのため。broker に接続できない
#   （curl exit 7）ときは 3 に落ち、理由の先頭に broker unreachable を付ける。
#   security の失敗は exit code ごとに --reason-file へ載せる（36 = errSecInteractionNotAllowed:
#   Keychain に届かない（ロック中・sandbox 内・別セッション）、44 = item が無い、
#   それ以外 = 読み取り失敗）。
#
# 環境変数:
#   JEV_DISABLE=1            何もせず exit 0（kill switch）
#   JEV_API_URL              既定 https://ai-gateway.vercel.sh/typesafe/v1/systemone（直接呼ぶ経路のみ）
#   JEV_MODEL                既定 typesafe-ai/jev（broker 経由では broker が固定値で上書きする）
#   JEV_BROKER_SOCKET        既定 $HOME/.local/state/jev-broker/jev.sock
#   JEV_KEYCHAIN_SERVICE     既定 vercel-ai-gateway
#   JEV_MAX_TIME             既定 2（秒）。hook 側 timeout より短く保つ
#   JEV_STATE_MAX_BYTES      既定 24000。state をこのバイト数で切る（上限 32k tokens）
#   JEV_DEBUG=1              失敗理由を stderr に出す
#
# 注意:
#   state は外部サービスに送られる。secret を含みうる内容（コマンド文字列・
#   エラー出力）は呼び出し側で先に redact すること。AI Gateway 自体は
#   プロンプトを保持しないが、上流の TypeSafe 側の扱いは別（ZDR は Gateway の
#   設定で有効化できる）。

set -euo pipefail

debug() {
  if [[ ${JEV_DEBUG:-0} == "1" ]]; then
    echo "[jev-classify] $*" >&2
  fi
}

QUESTIONS=""
MAX_TIME="${JEV_MAX_TIME:-2}"
REDACT=0
REASON_FILE=""
# broker に接続できず Keychain 経路に落ちたとき、最終的な失敗理由の先頭に付ける
REASON_PREFIX=""

# fail <reason>: 理由を debug と --reason-file に出して fail-open で終わる
fail() {
  local reason="${REASON_PREFIX}$1"
  debug "$reason"
  if [[ -n $REASON_FILE ]]; then
    printf '%s\n' "$reason" >"$REASON_FILE" 2>/dev/null || true
  fi
  exit 0
}

# 1 行に畳んで先頭 200 文字だけ残す（reason に応答本文の断片を載せる）
oneline() {
  printf '%s' "$1" | tr '\n\r' '  ' | cut -c1-200
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --questions)
    QUESTIONS="$2"
    shift 2
    ;;
  --max-time)
    MAX_TIME="$2"
    shift 2
    ;;
  --redact)
    REDACT=1
    shift
    ;;
  --reason-file)
    REASON_FILE="$2"
    shift 2
    ;;
  *)
    fail "unknown option: $1"
    ;;
  esac
done

if [[ ${JEV_DISABLE:-0} == "1" ]]; then
  fail "disabled via JEV_DISABLE"
fi

if [[ -z $QUESTIONS ]] || ! echo "$QUESTIONS" | jq -e 'type == "object" and length > 0' >/dev/null 2>&1; then
  fail "--questions must be a non-empty JSON object"
fi

for dep in curl jq; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    fail "missing dependency: $dep"
  fi
done

# --- 経路と鍵 ---
KEYCHAIN_SERVICE="${JEV_KEYCHAIN_SERVICE:-vercel-ai-gateway}"
API_KEY="${AI_GATEWAY_API_KEY:-}"
BROKER_SOCKET="${JEV_BROKER_SOCKET:-$HOME/.local/state/jev-broker/jev.sock}"

# resolve_key: $API_KEY が空なら Keychain から読む。読めなければ fail
resolve_key() {
  if [[ -n $API_KEY ]]; then
    return
  fi
  if ! command -v security >/dev/null 2>&1; then
    fail "no API key (AI_GATEWAY_API_KEY unset, security command not found)"
  fi
  local rc=0
  API_KEY=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null) || rc=$?
  case "$rc" in
  0) ;;
  36) fail "keychain unreachable (security exit 36: errSecInteractionNotAllowed; locked, sandboxed, or another login session such as a bg job)" ;;
  44) fail "no API key (keychain item '$KEYCHAIN_SERVICE' not found: security exit 44)" ;;
  *) fail "keychain read failed (security exit $rc)" ;;
  esac
  if [[ -z $API_KEY ]]; then
    fail "no API key (AI_GATEWAY_API_KEY unset, keychain item '$KEYCHAIN_SERVICE' is empty)"
  fi
}

USE_BROKER=false
if [[ -z $API_KEY && -S $BROKER_SOCKET ]]; then
  USE_BROKER=true
else
  resolve_key
fi

# --- state ---
# 送信前 redaction。BSD sed は大文字小文字無視 (I) を持たないので perl（macOS 標準）。
# 空白区切りを許すのは `--password x` のような CLI フラグ形だけ。散文の
# "the secrets to me" まで伏せないよう、それ以外は `=` / `:` を必須にする。
redact() {
  perl -pe '
    s/(--(?:token|secret|passw(?:or)?d|api[_-]?key)\w*[= ]+)[^\s"\x27]+/$1<redacted>/gi;
    s/((?:token|secret|passw(?:or)?d|api[_-]?key)\w*\s*[=:]\s*)[^\s"\x27]+/$1<redacted>/gi;
    s/((?:authorization\s*:\s*)?(?:bearer|basic)\s+)[^\s"\x27]+/$1<redacted>/gi;
    s/(authorization\s*:\s*)[^\s"\x27]+/$1<redacted>/gi;
    s#(://[^/\s:@]+:)[^@/\s]+@#$1<redacted>@#g;
    s/\b(?:vck|ghp|gho|ghu|ghs|ghr|sk|xox[abp]|AKIA)[-_][A-Za-z0-9_-]{8,}/<redacted>/g;
  '
}
# 上限で切る。UTF-8 の途中で切れても jq -R が置換文字にして JSON としては壊れない。
if [[ $REDACT -eq 1 ]]; then
  STATE=$(head -c "${JEV_STATE_MAX_BYTES:-24000}" | redact | jq -Rs '.' 2>/dev/null || echo '""')
else
  STATE=$(head -c "${JEV_STATE_MAX_BYTES:-24000}" | jq -Rs '.' 2>/dev/null || echo '""')
fi
if [[ $STATE == '""' ]]; then
  fail "empty state"
fi

BODY=$(jq -n \
  --arg model "${JEV_MODEL:-typesafe-ai/jev}" \
  --argjson state "$STATE" \
  --argjson questions "$QUESTIONS" \
  '{model: $model, state: $state, questions: $questions}')

# --- 呼び出し ---
CURL_RC=0
if [[ $USE_BROKER == true ]]; then
  # broker が鍵を付け、model と転送先を固定して Jev に中継する。URL のホスト名は使われない
  RESPONSE=$(
    curl -sS --fail-with-body \
      --max-time "$MAX_TIME" \
      --unix-socket "$BROKER_SOCKET" \
      -H "Content-Type: application/json" \
      -d "$BODY" \
      "http://jev-broker/typesafe/v1/systemone" 2>&1
  ) || CURL_RC=$?
  case "$CURL_RC" in
  0) ;;
  7)
    # ソケットはあるが接続できない（broker 停止後に残ったソケット、sandbox の許可外など）
    REASON_PREFIX="broker unreachable (curl exit 7 on $BROKER_SOCKET); "
    USE_BROKER=false
    resolve_key
    ;;
  28) fail "timeout (curl exit 28 via broker, --max-time ${MAX_TIME}s)" ;;
  *) fail "broker request failed (curl exit $CURL_RC): $(oneline "$RESPONSE")" ;;
  esac
fi
if [[ $USE_BROKER == false ]]; then
  # 鍵は argv に載せず、curl の -K/--config 経由で stdin から渡す（ps で見えない）。
  CURL_RC=0
  RESPONSE=$(
    printf 'header = "Authorization: Bearer %s"\n' "$API_KEY" |
      curl -sS --fail-with-body \
        --max-time "$MAX_TIME" \
        --config - \
        -H "Content-Type: application/json" \
        -d "$BODY" \
        "${JEV_API_URL:-https://ai-gateway.vercel.sh/typesafe/v1/systemone}" 2>&1
  ) || CURL_RC=$?
  if [[ $CURL_RC -eq 28 ]]; then
    fail "timeout (curl exit 28, --max-time ${MAX_TIME}s)"
  elif [[ $CURL_RC -ne 0 ]]; then
    fail "request failed (curl exit $CURL_RC): $(oneline "$RESPONSE")"
  fi
fi

if ! echo "$RESPONSE" | jq -e '.answers | type == "object"' >/dev/null 2>&1; then
  fail "bad response (no .answers object): $(oneline "$RESPONSE")"
fi

echo "$RESPONSE"
exit 0
