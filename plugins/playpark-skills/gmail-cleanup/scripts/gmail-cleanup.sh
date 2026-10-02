#!/usr/bin/env bash
# gmail-cleanup: 共通の GAS (gas/Code.gs) を、各 repo の設定 JSON に書かれた
# アカウントごとの Apps Script プロジェクトへ反映する。
#
# Usage:
#   gmail-cleanup.sh list   <config.json>
#   gmail-cleanup.sh render <config.json> <target-id> <out-dir>
#   gmail-cleanup.sh deploy <config.json> <target-id|all>
#   gmail-cleanup.sh create <config.json> <target-id>
#   gmail-cleanup.sh logs   <config.json> <target-id|all> [件数]
#
# target 固有のキー:
#   "retentionDays": 30, "queries": ["category:promotions"], "protectedLabelPrefixes": ["領収書"]
# 設定 JSON の共通部分・出力・Exit は _shared/scripts/gas-project.sh を参照。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../_shared/scripts/gas-project.sh
source "$SCRIPT_DIR/../../_shared/scripts/gas-project.sh"

GAS_SKILL="gmail-cleanup"
GAS_DIR="$SCRIPT_DIR/../gas"
PROJECT_TITLE="Gmail自動クリーンアップ"

# 空クエリは全メール一致になるので必ず弾く(fail-closed)。retentionDays の下限は 7。
gas_validate() {
  cat <<'JQ'
(if (.retentionDays | type) != "number" or .retentionDays != (.retentionDays | floor) or .retentionDays < 7
   then "\($id): retentionDays は 7 以上の整数にしてください" else empty end),
(if (.queries | type) != "array" or (.queries | length) == 0 then "\($id): queries が空です"
 elif any(.queries[]; type != "string" or test("^\\s*$")) then "\($id): 空のクエリがあります(全メールが対象になるため不可)"
 else empty end),
(if (.protectedLabelPrefixes | type) != "array" or any(.protectedLabelPrefixes[]; type != "string" or . == "")
   then "\($id): protectedLabelPrefixes は空でない文字列の配列にしてください" else empty end)
JQ
}

gas_config() { echo '{retentionDays, queries, protectedLabelPrefixes}'; }
gas_list() { gas_config; }

gas_main "$@"
