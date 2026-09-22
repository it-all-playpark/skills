#!/usr/bin/env bash
# jev-classify.sh: Jev（TypeSafe の判定専用モデル）に有界な質問を投げる共通スクリプト
#
# 正本はこのファイル（plugins/dev-flow/_shared/scripts/）。dotfiles の hook 群も同じ
# スクリプトを参照する（dotfiles 側の切り替えは別 PR）。
#
# 目的:
#   「read_only か / どの失敗種別か / この comment は body を上書きしているか」のような、
#   正規表現では書けないが答えが有界（選択肢・yes/no・段階）な意味判定を安価に得る。
#   Jev は文章を生成せず、各選択肢の較正済み確率を返す。呼び出し側は確率を閾値で
#   切って決定論に落とし、低確信は fail-closed（uncertain）側へ倒す。
#   dev-flow では prerun（dev-flow-prerun → prerun-analyze.sh）が issue の breaking 判定と
#   comment の override/conflict 判定に使う。呼び出しは常に `--redact` 付き。
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
#   stdout: API レスポンス JSON（.answers.<id> に結果）。失敗時は空
#   exit:   常に 0（fail-open。hook の本処理を止めない）
#
# 鍵の解決順:
#   1. $AI_GATEWAY_API_KEY（テスト・一時上書き用）
#   2. macOS Keychain: security find-generic-password -s $JEV_KEYCHAIN_SERVICE -w
#      登録: security add-generic-password -s vercel-ai-gateway -a claude-hooks -w 'vck_…'
#   Claude の Bash ツール環境に鍵を露出させないため、env ではなく Keychain を主とする
#   （hook は sandbox / permissions の外で走るので security コマンドが使える）。
#
# 環境変数:
#   JEV_DISABLE=1            何もせず exit 0（kill switch）
#   JEV_API_URL              既定 https://ai-gateway.vercel.sh/typesafe/v1/systemone
#   JEV_MODEL                既定 typesafe-ai/jev
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

if [[ ${JEV_DISABLE:-0} == "1" ]]; then
  debug "disabled via JEV_DISABLE"
  exit 0
fi

QUESTIONS=""
MAX_TIME="${JEV_MAX_TIME:-2}"
REDACT=0

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
  *)
    debug "unknown option: $1"
    exit 0
    ;;
  esac
done

if [[ -z $QUESTIONS ]] || ! echo "$QUESTIONS" | jq -e 'type == "object" and length > 0' >/dev/null 2>&1; then
  debug "--questions must be a non-empty JSON object"
  exit 0
fi

for dep in curl jq; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    debug "missing dependency: $dep"
    exit 0
  fi
done

# --- 鍵 ---
API_KEY="${AI_GATEWAY_API_KEY:-}"
if [[ -z $API_KEY ]] && command -v security >/dev/null 2>&1; then
  API_KEY=$(security find-generic-password -s "${JEV_KEYCHAIN_SERVICE:-vercel-ai-gateway}" -w 2>/dev/null || true)
fi
if [[ -z $API_KEY ]]; then
  debug "no API key (AI_GATEWAY_API_KEY or keychain '${JEV_KEYCHAIN_SERVICE:-vercel-ai-gateway}')"
  exit 0
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
  debug "empty state"
  exit 0
fi

BODY=$(jq -n \
  --arg model "${JEV_MODEL:-typesafe-ai/jev}" \
  --argjson state "$STATE" \
  --argjson questions "$QUESTIONS" \
  '{model: $model, state: $state, questions: $questions}')

# --- 呼び出し ---
# 鍵は argv に載せず、curl の -K/--config 経由で stdin から渡す（ps で見えない）。
RESPONSE=$(
  printf 'header = "Authorization: Bearer %s"\n' "$API_KEY" |
    curl -sS --fail-with-body \
      --max-time "$MAX_TIME" \
      --config - \
      -H "Content-Type: application/json" \
      -d "$BODY" \
      "${JEV_API_URL:-https://ai-gateway.vercel.sh/typesafe/v1/systemone}" 2>&1
) || {
  debug "request failed: ${RESPONSE:0:300}"
  exit 0
}

if ! echo "$RESPONSE" | jq -e '.answers | type == "object"' >/dev/null 2>&1; then
  debug "unexpected response: ${RESPONSE:0:300}"
  exit 0
fi

echo "$RESPONSE"
exit 0
