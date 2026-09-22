#!/usr/bin/env bash
# prerun-analyze.sh - dev-flow prerun の analyze 段 (issue #690)
#
# `analyze-issue <N> [--repo R] --contract` の決定論 parse を実行し、決定論で解けない 2 理由
# （breaking keyword hit / comments present）だけを Jev（有界判定モデル、_shared/scripts/jev-classify.sh）
# に回して、dev-flow.js の Setup 末尾の analyze ゲートが whitelist 検証するだけで REQ を組める analyze JSON を
# stdout 1 行で返す。LLM が issue を転写する工程は持たない（転写者がいなければ provenance 突合も
# comment_count 突合も要らない — その代わり Jev の低確信・応答なし・無効は全て fail-closed で
# `uncertain[]` に積み、Workflow 側のゲートが needs_clarification に倒す）。
#
# Usage: prerun-analyze.sh --issue <N> [--repo <owner/name>]
#
# 出力（常に exit 0。失敗は ok:false + reason で報告し prerun.sh は他段を巻き込まない）:
#   { ok: true, analyze_path: "contract"|"jev", jev_reasons: [..],
#     issue_title, issue_type, acceptance_criteria: [..], scope, scope_truncated, scope_total_chars,
#     issue_body, issue_body_truncated, breaking_keyword_scan, breaking_change, breaking_evidence,
#     comment_count, comment_overrides: [..], comment_conflicts: [..], uncertain: [..],
#     contract, ac_heading_near_miss: [..] }
#   { ok: false, reason: "...", analyze_path: "contract" }
#
# Jev 判定の規則（閾値 JEV_CONF_MIN=0.9。低確信は常に安全側）:
#   breaking_keyword_scan true  → noul「非互換変更 / migration を要するか」。p>=0.9 で breaking_change=true、
#                                 p<=0.1 で false、それ以外は uncertain。title の `!` marker は決定論で true
#   comments present            → comment ごとに choice {override, conflict, unrelated}（確信 = choice の確率）。
#                                 override かつ権限あり（author == issue 報告者 or association が
#                                 OWNER/MEMBER/COLLABORATOR）→ comment_overrides、override だが権限なし /
#                                 conflict / 低確信 → comment_conflicts（fail-closed）、unrelated（高確信）→ 無視
#   Jev が空 stdout（失敗）      → 該当判定は uncertain
#   DEVFLOW_JEV_DISABLE=1       → Jev を呼ばず該当判定は uncertain（private repo 向け opt-out）
#
# 環境変数: DEVFLOW_JEV_DISABLE=1 / DEVFLOW_JEV_MAX_TIME（既定 10 秒。hook 既定の 2 秒では issue 本文が
# 長いと落ちる）。jev-classify.sh には常に --redact を付ける。

set -euo pipefail

_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"
has_jq || { echo "jq is required" >&2; exit 127; }

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ANALYZE_ISSUE="$PLUGIN_ROOT/dev-issue-analyze/scripts/analyze-issue.sh"
JEV_CLASSIFY="$PLUGIN_ROOT/_shared/scripts/jev-classify.sh"
JEV_CONF_MIN="0.9"
export JEV_MAX_TIME="${DEVFLOW_JEV_MAX_TIME:-10}"

ISSUE=""
REPO=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --issue) [[ $# -ge 2 ]] || { echo "--issue requires a value" >&2; exit 2; }; ISSUE="$2"; shift 2 ;;
        --repo) [[ $# -ge 2 ]] || { echo "--repo requires a value" >&2; exit 2; }; REPO="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done
[[ "$ISSUE" =~ ^[1-9][0-9]*$ ]] || { echo "--issue must be a positive integer" >&2; exit 2; }

fail_json() {
    jq -n --arg r "$1" '{ok: false, reason: $r, analyze_path: "contract"}'
    exit 0
}

# ============================================================================
# 1. contract 決定論 parse（issue 取得は analyze-issue.sh が bare gh で内蔵）
# ============================================================================

ANALYZE_ARGS=("$ISSUE")
[[ -n "$REPO" ]] && ANALYZE_ARGS+=(--repo "$REPO")
ANALYZE_ARGS+=(--contract)
ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/dev-flow-prerun-analyze.XXXXXX")"
trap 'rm -f "$ERR_FILE" "${COMMENTS_FILE:-}"' EXIT
if ! CONTRACT="$("$ANALYZE_ISSUE" "${ANALYZE_ARGS[@]}" 2>"$ERR_FILE")"; then
    ERR_MSG="$(tr '\n' ' ' <"$ERR_FILE")"
    # analyze-issue.sh は die_json で {"error": ...} を stdout に出す。あれば理由に載せる
    if [[ -n "$CONTRACT" ]] && printf '%s' "$CONTRACT" | jq -e '.error? | type == "string"' >/dev/null 2>&1; then
        ERR_MSG="$(printf '%s' "$CONTRACT" | jq -r '.error')"
    fi
    fail_json "analyze-issue --contract failed: ${ERR_MSG:-exit non-zero}"
fi
if ! printf '%s' "$CONTRACT" | jq -e 'type == "object" and (.acceptance_criteria | type == "array") and (.title | type == "string")' >/dev/null 2>&1; then
    fail_json "analyze-issue --contract returned non-object / malformed JSON"
fi

TITLE="$(printf '%s' "$CONTRACT" | jq -r '.title')"
ISSUE_BODY="$(printf '%s' "$CONTRACT" | jq -r '.issue_body // ""')"
ISSUE_AUTHOR="$(printf '%s' "$CONTRACT" | jq -r '.issue_author // ""')"
BREAKING_KW="$(printf '%s' "$CONTRACT" | jq -r '.breaking_keyword_scan')"
TITLE_BANG="$(printf '%s' "$CONTRACT" | jq -r '.title_breaking_marker // false')"
COMMENT_COUNT="$(printf '%s' "$CONTRACT" | jq -r '.comment_count // 0')"

# ============================================================================
# 2. Jev 判定
# ============================================================================

JEV_DISABLED=false
[[ "${DEVFLOW_JEV_DISABLE:-0}" == "1" ]] && JEV_DISABLED=true

# jev_call <state> <questions-json> → 応答 JSON（失敗 / 無効は空）
jev_call() {
    local state="$1" questions="$2"
    [[ "$JEV_DISABLED" == true ]] && return 0
    printf '%s' "$state" | "$JEV_CLASSIFY" --redact --questions "$questions" 2>/dev/null || true
}

jev_unavailable_reason() {
    if [[ "$JEV_DISABLED" == true ]]; then
        printf 'Jev 無効（DEVFLOW_JEV_DISABLE=1）'
    else
        printf 'Jev 応答なし'
    fi
}

# jq の数値比較で閾値判定する（bash は小数を扱えない）
conf_at_least() { jq -n --argjson p "$1" --argjson m "$2" '$p >= $m' | grep -q true; }
conf_at_most() { jq -n --argjson p "$1" --argjson m "$2" '$p <= $m' | grep -q true; }

JEV_REASONS=()
UNCERTAIN=()
OVERRIDES=()
CONFLICTS=()
BREAKING_CHANGE=false
BREAKING_EVIDENCE=""

# ---- breaking ----
if [[ "$TITLE_BANG" == "true" ]]; then
    BREAKING_CHANGE=true
    BREAKING_EVIDENCE="title の breaking marker (!): ${TITLE}"
elif [[ "$BREAKING_KW" == "true" ]]; then
    JEV_REASONS+=("breaking_keyword_scan true")
    BREAKING_Q='{"breaking":{"type":"noul","instructions":"この issue の実装は、既存の API / schema / データ形式 / 設定形式の非互換変更や migration を必要とするか。『breaking を避ける』『非互換にしない』『breaking floor を変更しない』のような回避・不変条件への言及だけなら no。"}}'
    RESP="$(jev_call "# Issue: ${TITLE}"$'\n\n'"${ISSUE_BODY}" "$BREAKING_Q")"
    P="$(printf '%s' "$RESP" | jq -r '.answers.breaking.noul // empty' 2>/dev/null || true)"
    if [[ -z "$P" ]]; then
        UNCERTAIN+=("breaking_keyword_scan: title/body に breaking 系キーワードがあるが $(jev_unavailable_reason) — 非互換変更 / migration の有無を issue に明記せよ")
    elif conf_at_least "$P" "$JEV_CONF_MIN"; then
        BREAKING_CHANGE=true
        BREAKING_EVIDENCE="Jev noul p=${P}（breaking 系キーワード hit）"
    elif conf_at_most "$P" "$(jq -n --argjson m "$JEV_CONF_MIN" '1 - $m')"; then
        BREAKING_CHANGE=false
        BREAKING_EVIDENCE=""
    else
        UNCERTAIN+=("breaking_keyword_scan: 非互換変更 / migration の要否を Jev が低確信（p=${P}）で判定できない — issue に明記せよ")
    fi
fi

# ---- comments ----
comment_excerpt() {
    local b
    b="$(printf '%s' "$1" | tr '\n' ' ')"
    printf '%s' "${b:0:200}"
}

if [[ "$COMMENT_COUNT" -gt 0 ]]; then
    JEV_REASONS+=("comments present (${COMMENT_COUNT})")
    COMMENT_Q='{"kind":{"type":"choice","instructions":"この comment は issue body の要件に対してどれに当たるか。","criteria":{"override":"body の記述を明示的に訂正・上書きしている（『訂正』『前倒し』『X ではなく Y』等。要件が変わる）","conflict":"body と食い違う内容だが、どちらが有効か comment からは確定できない","unrelated":"要件を変えない（了解・質問・進捗報告・感想・無関係な話題）"}}}'
    COMMENTS_FILE="$(mktemp "${TMPDIR:-/tmp}/dev-flow-prerun-comments.XXXXXX")"
    printf '%s' "$CONTRACT" | jq -c '.comments // [] | .[]' >"$COMMENTS_FILE"
    IDX=0
    while IFS= read -r C || [[ -n "$C" ]]; do
        [[ -z "$C" ]] && continue
        IDX=$((IDX + 1))
        C_AUTHOR="$(printf '%s' "$C" | jq -r '.author // ""')"
        C_ASSOC="$(printf '%s' "$C" | jq -r '.author_association // ""')"
        C_AT="$(printf '%s' "$C" | jq -r '.created_at // ""')"
        C_BODY="$(printf '%s' "$C" | jq -r '.body // ""')"
        C_LABEL="comment #${IDX} by ${C_AUTHOR:-unknown}（${C_ASSOC:-?}, ${C_AT:-?}）: $(comment_excerpt "$C_BODY")"
        # 権限は gh JSON から決定論判定（空文字列・不明は一致とみなさない）
        TRUSTED=false
        if [[ -n "$C_AUTHOR" && -n "$ISSUE_AUTHOR" && "$C_AUTHOR" == "$ISSUE_AUTHOR" ]]; then
            TRUSTED=true
        elif [[ "$C_ASSOC" == "OWNER" || "$C_ASSOC" == "MEMBER" || "$C_ASSOC" == "COLLABORATOR" ]]; then
            TRUSTED=true
        fi
        STATE="# Issue（author: ${ISSUE_AUTHOR:-unknown}）: ${TITLE}"$'\n\n'"${ISSUE_BODY}"$'\n\n'"# Comment（author: ${C_AUTHOR:-unknown}, association: ${C_ASSOC:-?}, created_at: ${C_AT:-?}）"$'\n'"${C_BODY}"
        RESP="$(jev_call "$STATE" "$COMMENT_Q")"
        CHOICE="$(printf '%s' "$RESP" | jq -r '.answers.kind.choice // empty' 2>/dev/null || true)"
        CP="$(printf '%s' "$RESP" | jq -r '.answers.kind as $k | $k.probabilities[$k.choice] // empty' 2>/dev/null || true)"
        if [[ -z "$CHOICE" || -z "$CP" ]]; then
            UNCERTAIN+=("${C_LABEL} — $(jev_unavailable_reason)。comment が body を訂正しているなら issue body に反映せよ")
            continue
        fi
        if ! conf_at_least "$CP" "$JEV_CONF_MIN"; then
            CONFLICTS+=("low-confidence（${CHOICE} p=${CP}）: ${C_LABEL}")
            continue
        fi
        case "$CHOICE" in
            override)
                if [[ "$TRUSTED" == true ]]; then
                    OVERRIDES+=("override: ${C_LABEL}")
                else
                    CONFLICTS+=("override（権限なし: author_association=${C_ASSOC:-?}）: ${C_LABEL}")
                fi ;;
            conflict)
                CONFLICTS+=("conflict: ${C_LABEL}") ;;
            unrelated) ;;
            *)
                CONFLICTS+=("unknown-choice（${CHOICE}）: ${C_LABEL}") ;;
        esac
    done <"$COMMENTS_FILE"
fi

ANALYZE_PATH="contract"
[[ ${#JEV_REASONS[@]} -gt 0 ]] && ANALYZE_PATH="jev"

# ============================================================================
# 3. 出力
# ============================================================================

to_json_array() {
    if [[ $# -eq 0 ]]; then printf '[]'; return; fi
    printf '%s\n' "$@" | jq -R . | jq -sc .
}

JEV_REASONS_JSON="$(to_json_array "${JEV_REASONS[@]+"${JEV_REASONS[@]}"}")"
UNCERTAIN_JSON="$(to_json_array "${UNCERTAIN[@]+"${UNCERTAIN[@]}"}")"
OVERRIDES_JSON="$(to_json_array "${OVERRIDES[@]+"${OVERRIDES[@]}"}")"
CONFLICTS_JSON="$(to_json_array "${CONFLICTS[@]+"${CONFLICTS[@]}"}")"

printf '%s' "$CONTRACT" | jq -c \
    --arg analyze_path "$ANALYZE_PATH" \
    --argjson jev_reasons "$JEV_REASONS_JSON" \
    --argjson breaking_change "$BREAKING_CHANGE" \
    --arg breaking_evidence "$BREAKING_EVIDENCE" \
    --argjson comment_overrides "$OVERRIDES_JSON" \
    --argjson comment_conflicts "$CONFLICTS_JSON" \
    --argjson uncertain "$UNCERTAIN_JSON" \
    '{
      ok: true,
      analyze_path: $analyze_path,
      jev_reasons: $jev_reasons,
      issue_title: .title,
      issue_type: .issue_type,
      acceptance_criteria: .acceptance_criteria,
      scope: (.scope // ""),
      scope_truncated: (.scope_truncated // false),
      scope_total_chars: (.scope_total_chars // 0),
      issue_body: (.issue_body // ""),
      issue_body_truncated: (.issue_body_truncated // false),
      breaking_keyword_scan: (.breaking_keyword_scan // false),
      breaking_change: $breaking_change,
      breaking_evidence: $breaking_evidence,
      comment_count: (.comment_count // 0),
      comment_overrides: $comment_overrides,
      comment_conflicts: $comment_conflicts,
      uncertain: $uncertain,
      contract: (.contract // "none"),
      ac_heading_near_miss: (.ac_heading_near_miss // [])
    }'

exit 0
