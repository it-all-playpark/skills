#!/usr/bin/env bash
# daily.sh - dev-flow ヘルスレポートの日次実行（launchd から起動）
#
# 1. health-report.sh で当日のレポートを <out-dir>/YYYY-MM-DD.json に書く。
#    窓の始点は前回レポートの generated_at（無ければ health-report.sh の既定 = 24 時間前）。
#    実行できなかった日があっても、その間に出た new / regressed を取りこぼさない。
# 2. new / regressed が 1 件以上の日だけ、`claude -p "/dev-flow:dev-flow-health <report>"` で
#    原因の推定と issue 起票を LLM に任せる。0 件の日は LLM を呼ばない。出力は <out-dir>/YYYY-MM-DD.llm.log。
#
# Usage:
#   daily.sh [--out-dir DIR] [--date YYYY-MM-DD] [--journal-dir DIR] [--repo DIR] [--now ISO8601]
#
#   --out-dir      既定 ~/.claude/logs/dev-flow-health
#   --date         レポートのファイル名に使う日付。既定は今日（ローカル時刻）
#   --journal-dir / --repo / --now は health-report.sh へそのまま渡す
#
# 出力: stdout に {report, needs_llm, llm_invoked, llm_exit} の JSON 1 行。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HOME/.claude/logs/dev-flow-health"
DATE=""
PASS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --out-dir) OUT_DIR="${2:?}"; shift 2 ;;
        --date) DATE="${2:?}"; shift 2 ;;
        --journal-dir|--repo|--now) PASS+=("$1" "${2:?}"); shift 2 ;;
        -h|--help) sed -n '/^# Usage:/,/^# 出力:/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) jq -n --arg e "unknown option: $1" '{error: $e}' >&2; exit 2 ;;
    esac
done

[[ -n "$DATE" ]] || DATE="$(date +%Y-%m-%d)"
if [[ ! "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    jq -n --arg e "invalid --date: $DATE" '{error: $e}' >&2
    exit 2
fi

mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/$DATE.json"

# 前回レポート（当日分を除く最新）の generated_at を窓の始点にする
SINCE=""
prev=""
for f in "$OUT_DIR"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json; do
    [[ -f "$f" && "$f" != "$REPORT" ]] || continue
    prev="$f"
done
if [[ -n "$prev" ]]; then
    SINCE="$(jq -r '.generated_at // empty' "$prev" 2>/dev/null || true)"
fi

ARGS=()
[[ -z "$SINCE" ]] || ARGS+=(--since "$SINCE")
if [[ ${#PASS[@]} -gt 0 ]]; then
    ARGS+=("${PASS[@]}")
fi

TMP="$(mktemp "$OUT_DIR/.report.XXXXXX")"
if [[ ${#ARGS[@]} -gt 0 ]]; then
    bash "$SCRIPT_DIR/health-report.sh" "${ARGS[@]}" > "$TMP"
else
    bash "$SCRIPT_DIR/health-report.sh" > "$TMP"
fi
mv "$TMP" "$REPORT"

NEEDS_LLM="$(jq -r '.needs_llm' "$REPORT")"
LLM_INVOKED=false
LLM_EXIT=null
if [[ "$NEEDS_LLM" == "true" ]]; then
    LLM_INVOKED=true
    if claude -p "/dev-flow:dev-flow-health $REPORT" > "$OUT_DIR/$DATE.llm.log" 2>&1; then
        LLM_EXIT=0
    else
        LLM_EXIT=$?
    fi
fi

jq -nc --arg report "$REPORT" --argjson needs "$NEEDS_LLM" --argjson invoked "$LLM_INVOKED" --argjson rc "$LLM_EXIT" \
    '{report: $report, needs_llm: $needs, llm_invoked: $invoked, llm_exit: $rc}'
