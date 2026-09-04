#!/usr/bin/env bash
# PostToolUse hook: 全 tool 出力からの秘匿情報マスク (Phase 1)
#
# 目的:
#   pretool-bash-credential-guard.sh は「入力側」での prod credential 露出を
#   ask 介入で防ぐが、外部コマンド (env, curl, cat <設定> 等) の「出力側」に
#   含まれる秘密情報がそのまま会話履歴・コンテキストに残るのを防ぐ
#   セーフティネット。
#
#   v2.1.136+ で hookSpecificOutput.updatedToolOutput が全 tool で利用可能に
#   なったのを活用 (以前は MCP tool のみ)。
#
# 検知対象:
#   特定 prefix (誤検知率低):
#     - PEM private key blocks (BEGIN/END PRIVATE KEY)
#     - AWS Access Key ID (AKIA + 16 chars)
#     - GitHub tokens (ghp_/gho_/ghs_/ghu_/ghr_/github_pat_)
#     - Anthropic API key (sk-ant-...)
#     - sk- 系 generic (OpenAI / MORPH / 互換 API; 32+ chars)
#     - Stripe keys (sk_live_/sk_test_)
#     - Google API key (AIza + 30+ chars; Gemini 含む)
#     - Slack tokens (xoxb/xoxp/xoxa/xoxr/xoxs/xapp-)
#     - Vercel token (vck_...)
#     - Neon API key (napi_...)
#     - Hugging Face token (hf_...)
#     - JWT tokens (eyJ.eyJ.signature)
#   Generic fallback (誤検知ありうるが backstop として):
#     - 環境変数形式 <NAME_WITH_KEY|TOKEN|SECRET|PASSWORD|...>=<value 16+chars>
#       (行頭 whitespace / インデント付きも対象)
# 対象外 (Phase 2 候補):
#   - 小文字 env 名 (password=..., apiKey: ...)
#   - URL 埋め込み credential (postgres://user:secret@host)
#   - YAML/JSON inline (apiKey: "...", "token": "...")
#   - Read/Edit/Write tool 出力 (現在 Bash のみ対応)
#
# 出力:
#   - マスク発生時 (Bash tool): stdout に
#       {"hookSpecificOutput":{"hookEventName":"PostToolUse",
#         "updatedToolOutput": <元 tool_response に stdout/stderr を上書きした object>}}
#   - 他 tool (Read/Edit/Write/MCP 等): stdout 空で exit 0 (pass-through)
#   - マスクなし: stdout 空で exit 0 (Claude はオリジナル出力を見る)
#
# 注意:
#   updatedToolOutput を返すと Claude はオリジナル出力を見ない。
#   汎用フィルタにすると debug 困難になるため、特定フォーマットのみ対象。
#
# 参考:
#   - Claude Code Changelog v2.1.136: PostToolUse output replacement for all tools

set -euo pipefail

INPUT=$(cat)
[[ -z $INPUT ]] && exit 0

# Debug: CLAUDE_HOOK_DEBUG=1 で入力 JSON を /tmp に保存
# 注意: 本ログは append-only で size 制限なし。CLAUDE_HOOK_DEBUG=1 を export した
# まま長期間運用すると蓄積するため、debug 完了後は env を unset し、ログファイル
# を手動削除すること。
if [[ ${CLAUDE_HOOK_DEBUG:-0} == 1 ]]; then
  {
    printf '=== %s tool=%s ===\n' "$(date -Iseconds 2>/dev/null || date)" "$(echo "$INPUT" | jq -r '.tool_name // "?"')"
    printf 'TOOL_RESPONSE_KEYS: %s\n' "$(echo "$INPUT" | jq -rc '.tool_response | if type == "object" then keys else type end')"
    printf 'INPUT_FULL: %s\n' "$INPUT"
    printf '\n'
  } >>"${TMPDIR:-/tmp}/claude-secret-mask-debug.log"
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# テキストに対して秘匿パターンを適用するヘルパ。
# 引数: 文字列を stdin から受け取り、masked を stdout に出力。
# 順序が重要: より具体的なパターンを先に処理
#   sk-ant-     before sk-          (Anthropic vs generic sk-)
#   github_pat_ before gh[pousr]_    (PAT vs classic)
#   sk_live_    before sk-           (Stripe vs sk- generic; 区切り違うが念のため)
mask_text() {
  perl -0777 -pe '
    # PEM private key blocks (複数行対応)
    s/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/[REDACTED:PRIVATE_KEY_BLOCK]/g;

    # AWS Access Key ID (AKIA + 16 大文字英数字、合計 20 chars)
    s/\bAKIA[0-9A-Z]{16}\b/[REDACTED:AWS_ACCESS_KEY_ID]/g;

    # GitHub fine-grained PAT (github_pat_ + 82+ chars)
    s/\bgithub_pat_[A-Za-z0-9_]{82,}/[REDACTED:GITHUB_PAT]/g;

    # GitHub classic tokens (ghp_/gho_/ghs_/ghu_/ghr_ + 36+ chars)
    s/\bgh[pousr]_[A-Za-z0-9]{36,255}\b/[REDACTED:GITHUB_TOKEN]/g;

    # Anthropic API key (sk-ant- prefix; 必ず sk- より先)
    s/\bsk-ant-[A-Za-z0-9_-]{20,}/[REDACTED:ANTHROPIC_KEY]/g;

    # Stripe live/test keys
    s/\bsk_(?:live|test)_[A-Za-z0-9]{24,}/[REDACTED:STRIPE_KEY]/g;

    # sk- 系 generic (OpenAI / MORPH / 互換 API; 32+ chars)
    s/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/[REDACTED:SK_API_KEY]/g;

    # Google API key (AIza + 30+ chars; Gemini 含む)
    s/\bAIza[0-9A-Za-z_-]{30,}/[REDACTED:GOOGLE_API_KEY]/g;

    # Slack bot/user tokens
    s/\bxox[baprs]-[A-Za-z0-9-]{20,}/[REDACTED:SLACK_TOKEN]/g;

    # Slack app-level tokens
    s/\bxapp-\d+-[A-Z0-9]+-\d+-[A-Za-z0-9]{20,}/[REDACTED:SLACK_APP_TOKEN]/g;

    # Vercel token
    s/\bvck_[A-Za-z0-9]{24,}/[REDACTED:VERCEL_TOKEN]/g;

    # Neon API key
    s/\bnapi_[A-Za-z0-9_-]{32,}/[REDACTED:NEON_API_KEY]/g;

    # Hugging Face token
    s/\bhf_[A-Za-z0-9]{30,}/[REDACTED:HUGGINGFACE_TOKEN]/g;

    # JWT
    s/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/[REDACTED:JWT]/g;

    # URL 埋め込み credential (scheme://[user]:PASSWORD@host) — postgres/redis/mongodb 等
    # user 部空 (redis://:pass@) も許容。password 部のみ redact。
    s{\b([a-zA-Z][a-zA-Z0-9+.\-]*://)([^:/@\s]*):([^@/\s]+)@}{${1}${2}:[REDACTED:URL_CRED]\@}g;

    # Generic env-style fallback (specific 済みは (?!\[REDACTED:) で除外)
    # keyword は underscore 区切りに依存しない (PGPASSWORD 等も捕捉)。行頭 whitespace 許容。
    s/(^|[\s])([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|BEARER|SALT)[A-Z0-9_]*)=(?!\[REDACTED:)([^\s\r\n]{16,})($|[\s])/$1$2=[REDACTED:ENV_SECRET]$4/gm;

    # 小文字/camelCase env 名 (apikey=, password=, access_token= 等; = 区切り・16+ 非空白値)
    s/(^|[\s])([A-Za-z0-9_]*(?i:token|key|secret|password|passphrase|credential|bearer|salt)[A-Za-z0-9_]*)=(?!\[REDACTED:)([^\s\r\n]{16,})($|[\s])/$1$2=[REDACTED:ENV_SECRET]$4/gm;

    # JSON/quoted inline ("apiKey":"value" 形式; keyword 名 + 12+ 値)
    s/("(?:[A-Za-z0-9_]*(?i:token|key|secret|password|credential|bearer|salt)[A-Za-z0-9_]*)"\s*:\s*")(?!\[REDACTED:)[^"\r\n]{12,}"/${1}[REDACTED:JSON_SECRET]"/g;
  '
}

# Bash tool: tool_response が {stdout, stderr, interrupted, isImage, ...} 形式。
# updatedToolOutput は同じ stdout/stderr 構造で置換する必要がある。
# (v2.1.136+ で全 tool 対応になったが shape は tool 由来構造を維持)
if [[ $TOOL_NAME == Bash ]]; then
  STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // ""')
  STDERR=$(echo "$INPUT" | jq -r '.tool_response.stderr // ""')

  if [[ -z $STDOUT && -z $STDERR ]]; then
    exit 0
  fi

  MASKED_STDOUT=$(printf '%s' "$STDOUT" | mask_text)
  MASKED_STDERR=$(printf '%s' "$STDERR" | mask_text)

  if [[ $MASKED_STDOUT == "$STDOUT" && $MASKED_STDERR == "$STDERR" ]]; then
    exit 0
  fi

  echo "$INPUT" | jq \
    --arg stdout "$MASKED_STDOUT" \
    --arg stderr "$MASKED_STDERR" '
      {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          updatedToolOutput: (.tool_response + {stdout: $stdout, stderr: $stderr})
        }
      }
    '
  exit 0
fi

# 他 tool (Read/Edit/Write/MCP 等) は現時点で shape 未確定のため pass-through。
# 必要になったら tool 別 branch を追加。
exit 0
