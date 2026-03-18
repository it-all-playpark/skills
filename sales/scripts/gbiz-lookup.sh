#!/usr/bin/env bash
# gbiz-lookup.sh - gBizINFO REST API で法人公開情報を取得
# Usage:
#   gbiz-lookup.sh --name "企業名"              # 企業名で検索
#   gbiz-lookup.sh --number "1234567890123"     # 法人番号で詳細取得
#   gbiz-lookup.sh --number "1234567890123" --category finance  # カテゴリ別
# Output: JSON

set -euo pipefail

source "$(dirname "$0")/../../_lib/common.sh"

require_cmds jq curl

# ============================================================================
# Config
# ============================================================================

GBIZ_BASE_URL="https://api.info.gbiz.go.jp/hojin/v2/hojin"

# APIトークン: skill-config.json > 環境変数
load_api_token() {
  local token=""

  # 1. skill-config.json の sales.gbiz_api_token
  local cfg
  cfg="$(load_skill_config "sales")"
  token=$(echo "$cfg" | jq -r '.gbiz_api_token // empty' 2>/dev/null)

  # 2. 環境変数フォールバック
  if [[ -z "$token" ]]; then
    token="${GBIZ_API_TOKEN:-}"
  fi

  if [[ -z "$token" ]]; then
    die_json "gBizINFO APIトークンが未設定です。skill-config.json の sales.gbiz_api_token か環境変数 GBIZ_API_TOKEN を設定してください。" 1
  fi

  echo "$token"
}

# ============================================================================
# API Call
# ============================================================================

gbiz_get() {
  local path="$1"
  local token="$2"

  local url="${GBIZ_BASE_URL}${path}"
  local response
  local http_code

  # curl で API 呼び出し（HTTP ステータスコードも取得）
  response=$(curl -s -w "\n%{http_code}" \
    -H "X-hojinInfo-api-token: ${token}" \
    -H "Accept: application/json" \
    "$url")

  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')

  if [[ "$http_code" -ne 200 ]]; then
    die_json "gBizINFO API error: HTTP ${http_code} - ${body}" 1
  fi

  echo "$body"
}

# ============================================================================
# Search by name
# ============================================================================

search_by_name() {
  local name="$1"
  local token="$2"
  local limit="${3:-5}"

  # URL エンコード
  local encoded_name
  encoded_name=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$name'))")

  local result
  result=$(gbiz_get "?name=${encoded_name}&limit=${limit}" "$token")

  # 検索結果を整形して出力
  echo "$result" | jq '{
    status: "ok",
    query: "'"$name"'",
    total: (.totalCount // 0),
    corporations: [.["hojin-infos"][]? | {
      corporate_number: .corporate_number,
      name: .name,
      name_en: .name_en,
      location: .location,
      status: .status,
      capital_stock: .capital_stock,
      employee_number: .employee_number,
      date_of_establishment: .date_of_establishment,
      business_summary: .business_summary,
      company_url: .company_url,
      representative_name: .representative_name
    }]
  }'
}

# ============================================================================
# Get by corporate number
# ============================================================================

get_by_number() {
  local number="$1"
  local token="$2"
  local category="${3:-}"

  # 法人番号バリデーション（13桁数字）
  if [[ ! "$number" =~ ^[0-9]{13}$ ]]; then
    die_json "法人番号は13桁の数字です: ${number}" 1
  fi

  local path="/${number}"
  if [[ -n "$category" ]]; then
    path="/${number}/${category}"
  fi

  local result
  result=$(gbiz_get "${path}?metadata_flg=true" "$token")

  echo "$result" | jq '{
    status: "ok",
    corporate_number: "'"$number"'",
    category: "'"${category:-all}"'",
    data: .
  }'
}

# ============================================================================
# Main
# ============================================================================

MODE=""
NAME=""
NUMBER=""
CATEGORY=""
LIMIT="5"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      MODE="search"
      NAME="$2"
      shift 2
      ;;
    --number)
      MODE="detail"
      NUMBER="$2"
      shift 2
      ;;
    --category)
      CATEGORY="$2"
      shift 2
      ;;
    --limit)
      LIMIT="$2"
      shift 2
      ;;
    *)
      die_json "Unknown option: $1"
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  die_json "Usage: gbiz-lookup.sh --name <企業名> | --number <法人番号> [--category <category>]"
fi

TOKEN=$(load_api_token)

case "$MODE" in
  search)
    search_by_name "$NAME" "$TOKEN" "$LIMIT"
    ;;
  detail)
    get_by_number "$NUMBER" "$TOKEN" "$CATEGORY"
    ;;
esac
