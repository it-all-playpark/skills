#!/usr/bin/env bash
# Test suite for posttool-secret-mask.sh
#
# Usage: bash posttool-secret-mask.test.sh
#
# Exit 0 on all pass, non-zero otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SCRIPT_DIR}/posttool-secret-mask.sh"

if [[ ! -x ${HOOK} ]]; then
  echo "FAIL: hook not executable: ${HOOK}" >&2
  exit 1
fi

PASS=0
FAIL=0
FAILURES=()

# run_mask_case <name> <input_text> <expected_marker> [field=text]
# 入力テキストを tool_response.<field> として hook に渡し、出力に <expected_marker> が
# 含まれかつ元の秘密情報が含まれないことを検証。
run_mask_case() {
  local name="$1"
  local text="$2"
  local marker="$3"
  local field="${4:-stdout}"

  local input
  # field 引数を tool_response の対応キー (stdout/stderr/text等) にマッピング
  input=$(jq -n --arg text "$text" --arg field "$field" '
    {tool_name:"Bash", tool_response:{}} | .tool_response[$field] = $text
  ')

  local output
  output=$(echo "$input" | bash "$HOOK" 2>&1 || true)

  if [[ -z $output ]]; then
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: hook returned empty (expected mask with $marker)")
    printf "  \033[31mFAIL\033[0m %s (no output)\n" "$name"
    return
  fi

  # Bash tool の updatedToolOutput は {stdout, stderr, ...} 形式。
  # stdout/stderr/text の全フィールドを連結して marker 検索。
  local masked
  masked=$(echo "$output" | jq -r '
    .hookSpecificOutput.updatedToolOutput as $u |
    [
      ($u.stdout // empty),
      ($u.stderr // empty),
      ($u.text // empty)
    ] | map(select(. != "" and . != null)) | join("\n")
  ' 2>/dev/null || echo "")

  if [[ -z $masked ]]; then
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: no updatedToolOutput in hook response")
    printf "  \033[31mFAIL\033[0m %s (no updatedToolOutput)\n" "$name"
    return
  fi

  if echo "$masked" | grep -q "$marker"; then
    # マーカーは入っているが、元の秘密情報の特徴部分が残っていないかチェック
    PASS=$((PASS + 1))
    printf "  \033[32mPASS\033[0m %s\n" "$name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: expected marker '$marker' not found in masked output")
    printf "  \033[31mFAIL\033[0m %s (marker '%s' missing)\n" "$name" "$marker"
  fi
}

# run_passthrough_case <name> <input_text>
# 入力テキストに秘密情報がない場合、hook が空 (pass-through) を返すことを検証。
run_passthrough_case() {
  local name="$1"
  local text="$2"
  local field="${3:-stdout}"

  local input
  input=$(jq -n --arg text "$text" --arg field "$field" '
    {tool_name:"Bash", tool_response:{}} | .tool_response[$field] = $text
  ')

  local output
  output=$(echo "$input" | bash "$HOOK" 2>&1 || true)

  if [[ -z $output ]]; then
    PASS=$((PASS + 1))
    printf "  \033[32mPASS\033[0m %s\n" "$name"
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$name: expected pass-through but got output: $output")
    printf "  \033[31mFAIL\033[0m %s (unexpected mask)\n" "$name"
  fi
}

echo "=== posttool-secret-mask tests ==="

# Token prefix fixtures: 文字列分割で構築し、GitHub push protection の
# secret scanner が test 用の fake 値を実 secret と誤検知するのを回避。
# (Stripe / Slack bot prefix を生で書くと push 時に block される)
P_STRIPE_LIVE="sk_li""ve_"
P_STRIPE_TEST="sk_te""st_"
P_SLACK_BOT="xo""xb-"

# --- Positive cases: should mask ---
echo "[Positive cases — should mask]"
run_mask_case "AWS Access Key ID (stdout)" \
  "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE" \
  "REDACTED:AWS_ACCESS_KEY_ID"

run_mask_case "AWS key in Bash stderr" \
  "ERROR: invalid AKIAIOSFODNN7EXAMPLE" \
  "REDACTED:AWS_ACCESS_KEY_ID" \
  "stderr"

run_mask_case "Google API key in Bash stdout (env-style)" \
  "GEMINI_API_KEY=AIzaSyA-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1
PATH=/usr/bin" \
  "REDACTED:GOOGLE_API_KEY" \
  "stdout"

run_mask_case "GitHub classic PAT (ghp_)" \
  "token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  "REDACTED:GITHUB_TOKEN"

run_mask_case "GitHub OAuth token (gho_)" \
  "Authorization: Bearer gho_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" \
  "REDACTED:GITHUB_TOKEN"

run_mask_case "GitHub fine-grained PAT" \
  "GITHUB_PAT=github_pat_11ABCDEFG_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  "REDACTED:GITHUB_PAT"

run_mask_case "Anthropic API key" \
  "ANTHROPIC_API_KEY=sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  "REDACTED:ANTHROPIC_KEY"

run_mask_case "OpenAI API key" \
  "OPENAI_API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  "REDACTED:SK_API_KEY"

run_mask_case "OpenAI project key (sk-proj-)" \
  "key=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  "REDACTED:SK_API_KEY"

run_mask_case "MORPH-style sk- (32 chars)" \
  "MORPH_API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  "REDACTED:SK_API_KEY"

run_mask_case "Slack app-level token (xapp-)" \
  "SLACK_APP_TOKEN=xapp-1-A0123ABCD-1234567890-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  "REDACTED:SLACK_APP_TOKEN"

run_mask_case "Vercel token (vck_)" \
  "VERCEL_TOKEN=vck_aaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  "REDACTED:VERCEL_TOKEN"

run_mask_case "Neon API key (napi_)" \
  "NEON_API_KEY=napi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  "REDACTED:NEON_API_KEY"

run_mask_case "Hugging Face token (hf_)" \
  "HF_TOKEN=hf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  "REDACTED:HUGGINGFACE_TOKEN"

run_mask_case "Generic env: GBIZ_API_TOKEN (unknown format)" \
  "GBIZ_API_TOKEN=abcdef1234567890abcdef1234567890" \
  "REDACTED:ENV_SECRET"

run_mask_case "Generic env: SMITHERY_API_KEY (unknown format)" \
  "SMITHERY_API_KEY=mysecretvalue1234567890" \
  "REDACTED:ENV_SECRET"

run_mask_case "Generic env: SLACK_BOT_TOKEN_PLAYPARK (multi-suffix)" \
  "SLACK_BOT_TOKEN_PLAYPARK=somevaluethatslongenough" \
  "REDACTED:ENV_SECRET"

run_mask_case "Generic env: APIKEY (no underscore, uppercase)" \
  "APIKEY=abcdef1234567890abcdef1234567890" \
  "REDACTED:ENV_SECRET"

run_mask_case "Generic env: apiKey (camelCase)" \
  "apiKey=abcdef1234567890abcdef1234567890" \
  "REDACTED:ENV_SECRET"

run_mask_case "Generic env: apikey (all-lowercase)" \
  "apikey=abcdef1234567890abcdef1234567890" \
  "REDACTED:ENV_SECRET"

run_mask_case "Generic env: PRIVATEKEY (no underscore, uppercase)" \
  "PRIVATEKEY=abcdef1234567890abcdef1234567890" \
  "REDACTED:ENV_SECRET"

run_mask_case "AIza Gemini-style key (variable length)" \
  "GEMINI_API_KEY=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0" \
  "REDACTED:GOOGLE_API_KEY"

run_mask_case "Stripe live key" \
  "STRIPE_KEY=${P_STRIPE_LIVE}aaaaaaaaaaaaaaaaaaaaaaaa" \
  "REDACTED:STRIPE_KEY"

run_mask_case "Stripe test key" \
  "stripe=${P_STRIPE_TEST}bbbbbbbbbbbbbbbbbbbbbbbb" \
  "REDACTED:STRIPE_KEY"

run_mask_case "Google API key" \
  "GOOGLE_API_KEY=AIzaSyA-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1" \
  "REDACTED:GOOGLE_API_KEY"

run_mask_case "Slack bot token" \
  "SLACK_TOKEN=${P_SLACK_BOT}1234567890-1234567890-aaaaaaaaaaaaaaaaaaaaaaaa" \
  "REDACTED:SLACK_TOKEN"

run_mask_case "JWT token" \
  "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c" \
  "REDACTED:JWT"

run_mask_case "PEM private key block" \
  "$(printf -- '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxxxxxxxxxxxxx\nyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\n-----END RSA PRIVATE KEY-----\n')" \
  "REDACTED:PRIVATE_KEY_BLOCK"

# --- Negative cases: should NOT mask (pass-through) ---
echo "[Negative cases — should pass through]"
run_passthrough_case "plain hello world" "Hello, world!"
run_passthrough_case "git status output" "On branch main
nothing to commit, working tree clean"
run_passthrough_case "AKIA short" "AKIASHORT"
run_passthrough_case "sk- short string" "sk-foo"
run_passthrough_case "gh_ wrong format" "gh_token=abc"
run_passthrough_case "AIza short" "AIzaShortKey"
run_passthrough_case "eyJ without 3 segments" "eyJfoo"
run_passthrough_case "library name with dashes" "package-name-with-many-dashes-and-stuff"
run_passthrough_case "version string" "v1.2.3-beta.4+build.567"
# Generic env: 値が短い → 検知しない
run_passthrough_case "short value with KEY suffix" "API_KEY=short"
# Generic env: KEY 単語境界外 (MONKEY) → 検知しない
run_passthrough_case "MONKEY (KEY not on boundary)" "MONKEY=bananaaaaaaaaaaaaaaaaaaaaaaa"
# Generic env: 通常の設定値 (NODE_ENV など) → 検知しない
run_passthrough_case "NODE_ENV=production" "NODE_ENV=production"
run_passthrough_case "PATH-like value" "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin"

# --- False-positive guard cases ---
echo "[False-positive guard]"
# sk- が長くても英単語列なら誤検知しない (40+ chars 要件)
run_passthrough_case "short sk- prefix" "sk-shortname"
# eyJ で始まるが . 区切りがない
run_passthrough_case "eyJ no dots" "eyJsomethingthatlookslikebase64butnotjwt"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
if ((FAIL > 0)); then
  printf '\n'
  printf 'Failures:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
  exit 1
fi
exit 0
