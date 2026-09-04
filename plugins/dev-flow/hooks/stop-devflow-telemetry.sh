#!/usr/bin/env bash
# Stop hook: dev-flow telemetry handoff flush
#
# Claude Code の Stop event で呼び出される hook。dev-flow が pending dir に書き出した
# handoff JSON を読み取り、journal.sh log コマンドへ転送して telemetry を記録する。
#
# pending dir: ${CLAUDE_JOURNAL_DIR:-$HOME/.claude/journal}/pending/
# 各 *.json を atomic claim（mv + PID suffix）してから処理し、成功なら削除、
# 失敗なら元のファイル名に戻す（次回 Stop で再試行）。
#
# malformed replay runbook（pending/malformed/ に落ちた handoff の回収手順）:
#   1. mv ~/.claude/journal/pending/malformed/<file>.json ~/.claude/journal/pending/
#   2. echo '{}' | bash "${CLAUDE_PLUGIN_ROOT}/hooks/stop-devflow-telemetry.sh"  # または次の Stop event
#   3. ~/.claude/logs/stop-devflow-telemetry.log に journal-failed が無いことを確認
#   注: outcome=failure かつ error_category/error_msg を欠く payload は journal.sh 契約
#   （outcome != success で両キー必須）で journal-failed → pending/ に残り続ける。
#   再投入前に payload へ error_category（enum: lint|test|build|runtime|config|env|merge|
#   type-check|needs_clarification|empty_diff）と error_msg を手で追記すること。
#
# 無効化:
#   - 環境変数 CLAUDE_DEVFLOW_TELEMETRY_HOOK=0（escape hatch）
#   - pending dir が存在しない
#
# journal.sh の解決順: payload path → payload bare 名(command -v) → command -v journal
#   → 隣接 playpark-core（skills#572）
#
# stdout: なし
# stderr: なし（ログは $HOME/.claude/logs/stop-devflow-telemetry.log へ）
# 終了コード: 常に 0（Stop を絶対にブロックしない）
#
# Ref: https://code.claude.com/docs/en/hooks

set -euo pipefail

# stdin は JSON payload 前提。SIGPIPE 回避のため drain する。
cat >/dev/null 2>&1 || true

# Escape hatch
if [[ ${CLAUDE_DEVFLOW_TELEMETRY_HOOK:-1} == "0" ]]; then
  exit 0
fi

PENDING_DIR="${CLAUDE_JOURNAL_DIR:-${HOME}/.claude/journal}/pending"

if [[ ! -d $PENDING_DIR ]]; then
  exit 0
fi

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# repo checkout / link mode: dev-flow plugin root の隣に playpark-core がある
SIBLING_JOURNAL="${HOOK_DIR}/../../playpark-core/skill-retrospective/scripts/journal.sh"
LOG_FILE="${HOME}/.claude/logs/stop-devflow-telemetry.log"

# Process each *.json in pending dir
for f in "${PENDING_DIR}"/*.json; do
  # No files matched (glob literal returned)
  [[ -e $f ]] || continue

  claimed="${f}.claimed.$$"

  # Atomic claim: mv 失敗 = 他プロセスが処理中 → skip
  if ! mv "$f" "$claimed" 2>/dev/null; then
    continue
  fi

  # --- Parse JSON ---
  skill=""
  outcome=""
  issue=""
  journal_sh_field=""
  merge_tier=""
  gate_policy=""
  danger_hits_json=""
  shape=""
  shape_refloored=""
  plan_iter=""
  eval_iter=""
  eval_verdict=""
  iterate_status=""
  eval_staleness=""
  repo=""
  pr_number=""
  ci_wait_seconds=""
  ci_poll_attempts=""
  trust_run_id=""
  trust_receipts_json=""
  trust_surfaceproof_json=""
  trust_evalseal_missing_reason=""
  trust_effectdelta_pr_missing_reason=""
  error_category=""
  error_msg=""
  vdelta_verdicts_json=""
  vdelta_fail_open=""
  redgreen_deny_json=""
  testsurf_hits_json=""
  duration_seconds=""
  phase_durations_json=""
  merge_tier_reasons_json=""
  route=""
  guard_id=""
  eval_confidence=""
  review_confidence=""
  review_decision=""
  passthrough_telemetry_json=""

  if ! parsed=$(jq -e '{
    skill: .skill,
    outcome: .outcome,
    issue: .issue,
    journal_sh: .journal_sh,
    repo: .repo,
    pr_number: .pr_number,
    error_category: .error_category,
    error_msg: .error_msg,
    merge_tier: .telemetry.merge_tier,
    gate_policy: .telemetry.gate_policy,
    danger_hits: (.telemetry.danger_hits // []),
    shape: .telemetry.shape,
    shape_refloored: .telemetry.shape_refloored,
    plan_iter: .telemetry.plan_iter,
    eval_iter: .telemetry.eval_iter,
    eval_verdict: .telemetry.eval_verdict,
    iterate_status: .telemetry.iterate_status,
    eval_staleness: .telemetry.eval_staleness,
    ci_wait_seconds: .telemetry.ci_wait_seconds,
    ci_poll_attempts: .telemetry.ci_poll_attempts,
    trust_run_id: .telemetry.trust_run_id,
    trust_receipts: .telemetry.trust_receipts,
    trust_surfaceproof: .telemetry.trust_surfaceproof_shadow,
    trust_evalseal_missing_reason: .telemetry.trust_evalseal_missing_reason,
    trust_effectdelta_pr_missing_reason: .telemetry.trust_effectdelta_pr_missing_reason,
    vdelta_verdicts: .telemetry.vdelta_verdicts,
    vdelta_fail_open: .telemetry.vdelta_fail_open,
    redgreen_deny: .telemetry.redgreen_deny,
    testsurf_hits: .telemetry.testsurf_hits,
    duration_seconds: .telemetry.duration_seconds,
    phase_durations: .telemetry.phase_durations,
    merge_tier_reasons: .telemetry.merge_tier_reasons,
    route: .telemetry.route,
    guard_id: .telemetry.guard_id,
    eval_confidence: ((.telemetry // {}) | if has("eval_confidence") then (.eval_confidence | tojson) else null end),
    review_confidence: ((.telemetry // {}) | if has("review_confidence") then (.review_confidence | tojson) else null end),
    review_decision: .telemetry.review_decision,
    passthrough_telemetry: ((.telemetry // {}) | {
      iterate_rounds,
      fixes_applied,
      fix_null_retries,
      review_null_retries,
      fix_uncommitted_recovered,
      subagent_invocations
    } | with_entries(select(.value != null)))
  }' "$claimed" 2>/dev/null); then
    # JSON parse error
    mkdir -p "${PENDING_DIR}/malformed"
    mv "$claimed" "${PENDING_DIR}/malformed/$(basename "$f")"
    mkdir -p "$(dirname "$LOG_FILE")"
    printf '%s malformed-json %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    continue
  fi

  skill=$(echo "$parsed" | jq -r '.skill // empty')
  outcome=$(echo "$parsed" | jq -r '.outcome // empty')
  merge_tier=$(echo "$parsed" | jq -r '.merge_tier // empty')

  # Required key check（producer 契約 _lib/journal-handoff.mjs と一致: skill/outcome のみ必須。
  # merge_tier は standard/complex shape 由来で micro shape や pr-iterate 単体起動には存在しない
  # ため required から除外し、下流で conditional 転送する）
  if [[ -z $skill || -z $outcome ]]; then
    mkdir -p "${PENDING_DIR}/malformed"
    mv "$claimed" "${PENDING_DIR}/malformed/$(basename "$f")"
    mkdir -p "$(dirname "$LOG_FILE")"
    printf '%s missing-required-key %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    continue
  fi

  issue=$(echo "$parsed" | jq -r '.issue // empty')
  journal_sh_field=$(echo "$parsed" | jq -r '.journal_sh // empty')
  gate_policy=$(echo "$parsed" | jq -r '.gate_policy // empty')
  danger_hits_json=$(echo "$parsed" | jq -c '.danger_hits // []')
  shape=$(echo "$parsed" | jq -r '.shape // empty')
  shape_refloored=$(echo "$parsed" | jq -r 'if .shape_refloored == null then "" else (.shape_refloored | tostring) end')
  plan_iter=$(echo "$parsed" | jq -r '.plan_iter // empty')
  eval_iter=$(echo "$parsed" | jq -r '.eval_iter // empty')
  eval_verdict=$(echo "$parsed" | jq -r '.eval_verdict // empty')
  iterate_status=$(echo "$parsed" | jq -r '.iterate_status // empty')
  eval_staleness=$(echo "$parsed" | jq -r '.eval_staleness // empty')
  repo=$(echo "$parsed" | jq -r '.repo // empty')
  pr_number=$(echo "$parsed" | jq -r '.pr_number // empty')
  error_category=$(echo "$parsed" | jq -r '.error_category // empty')
  error_msg=$(echo "$parsed" | jq -r '.error_msg // empty')
  ci_wait_seconds=$(echo "$parsed" | jq -r '.ci_wait_seconds // empty')
  ci_poll_attempts=$(echo "$parsed" | jq -r '.ci_poll_attempts // empty')
  trust_run_id=$(echo "$parsed" | jq -r '.trust_run_id // empty')
  trust_receipts_json=$(echo "$parsed" | jq -c '.trust_receipts // empty')
  trust_surfaceproof_json=$(echo "$parsed" | jq -c '.trust_surfaceproof // empty')
  trust_evalseal_missing_reason=$(echo "$parsed" | jq -r '.trust_evalseal_missing_reason // empty')
  trust_effectdelta_pr_missing_reason=$(echo "$parsed" | jq -r '.trust_effectdelta_pr_missing_reason // empty')
  vdelta_verdicts_json=$(echo "$parsed" | jq -c '.vdelta_verdicts // empty')
  vdelta_fail_open=$(echo "$parsed" | jq -r '.vdelta_fail_open // empty')
  redgreen_deny_json=$(echo "$parsed" | jq -c '.redgreen_deny // empty')
  testsurf_hits_json=$(echo "$parsed" | jq -c '.testsurf_hits // empty')
  duration_seconds=$(echo "$parsed" | jq -r '.duration_seconds // empty')
  phase_durations_json=$(echo "$parsed" | jq -c '.phase_durations // empty')
  merge_tier_reasons_json=$(echo "$parsed" | jq -c '.merge_tier_reasons // empty')
  route=$(echo "$parsed" | jq -r '.route // empty')
  guard_id=$(echo "$parsed" | jq -r '.guard_id // empty')
  # tojson 経由の projection のため、値は「キー欠落」時のみ empty（JSON null は
  # 文字列 "null" として非空で抽出される。confidence forwarding が "null" を drop
  # しないのはこの区別を保つため）。
  eval_confidence=$(echo "$parsed" | jq -r '.eval_confidence // empty')
  review_confidence=$(echo "$parsed" | jq -r '.review_confidence // empty')
  review_decision=$(echo "$parsed" | jq -r '.review_decision // empty')
  passthrough_telemetry_json=$(echo "$parsed" | jq -c '.passthrough_telemetry // {}')

  # --- Resolve journal.sh ---
  journal_sh=""
  resolved=""
  if [[ -n $journal_sh_field && -x $journal_sh_field ]]; then
    journal_sh="$journal_sh_field"
  elif [[ -n $journal_sh_field && $journal_sh_field != */* ]] && resolved=$(command -v -- "$journal_sh_field" 2>/dev/null); then
    # payload が bare 名（dev-flow.js は journal_sh: 'journal'）→ PATH 上の playpark-core bin/journal
    journal_sh="$resolved"
  elif resolved=$(command -v journal 2>/dev/null); then
    journal_sh="$resolved"
  elif [[ -x $SIBLING_JOURNAL ]]; then
    journal_sh="$SIBLING_JOURNAL"
  else
    mkdir -p "$(dirname "$LOG_FILE")"
    printf '%s no-journal-sh %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    mv "$claimed" "$f"
    continue
  fi

  # --- Build command args ---
  cmd_args=(
    log "$skill" "$outcome"
    --issue "$issue"
  )

  # merge_tier は standard/complex shape 由来の optional field（producer 契約は skill/outcome
  # のみ必須）。micro shape run や pr-iterate 単体起動には存在しないため conditional 転送とし、
  # 既存呼び出しとの引数順序 byte 互換のため --issue 直後に挿入する。
  if [[ -n $merge_tier && $merge_tier != "null" ]]; then
    cmd_args+=(--merge-tier "$merge_tier")
  fi

  cmd_args+=(
    --gate-policy "$gate_policy"
    --danger-hits "$danger_hits_json"
    --shape "$shape"
    --shape-refloored "$shape_refloored"
    --plan-iter "$plan_iter"
    --eval-iter "$eval_iter"
  )

  # Optional fields: only append if non-empty and not null
  if [[ -n $eval_verdict && $eval_verdict != "null" ]]; then
    cmd_args+=(--eval-verdict "$eval_verdict")
  fi
  if [[ -n $iterate_status && $iterate_status != "null" ]]; then
    cmd_args+=(--iterate-status "$iterate_status")
  fi
  if [[ -n $eval_staleness && $eval_staleness != "null" ]]; then
    cmd_args+=(--eval-staleness "$eval_staleness")
  fi
  if [[ -n $repo && $repo != "null" ]]; then
    cmd_args+=(--repo "$repo")
  fi
  if [[ -n $pr_number && $pr_number != "null" ]]; then
    cmd_args+=(--pr-number "$pr_number")
  fi
  if [[ -n $ci_wait_seconds && $ci_wait_seconds != "null" ]]; then
    cmd_args+=(--ci-wait-seconds "$ci_wait_seconds")
  fi
  if [[ -n $ci_poll_attempts && $ci_poll_attempts != "null" ]]; then
    cmd_args+=(--ci-poll-attempts "$ci_poll_attempts")
  fi
  # journal.sh は outcome != success のとき --error-category / --error-msg を必須とする
  # （journal.sh L128-133）。これを欠くと失敗 run が journal-failed で pending に留まり続ける。
  if [[ -n $error_category && $error_category != "null" ]]; then
    cmd_args+=(--error-category "$error_category")
  fi
  if [[ -n $error_msg && $error_msg != "null" ]]; then
    cmd_args+=(--error-msg "$error_msg")
  fi

  # --- trust telemetry (epic #390 Phase 5 / issue #413) ---
  # journal.sh は --trust-receipts / --trust-surfaceproof を closed enum で検証し、契約違反時は
  # exit 1 する。無検査で転送すると entry 全体が pending へ差し戻され、merge_tier 等の基本
  # telemetry ごと恒久的に失われる。trust キーは optional な付加情報なので、契約を満たす値だけを
  # 転送し、満たさない値は drop してログに残す（fail-open — base entry の記録を最優先する）。
  # 例: SurfaceProof が advisory/blocking へ昇格した run は verdict:null を出すため drop される
  #     （journal.sh 側 enum の拡張は昇格 PR の責務であり本 hook の責務ではない）。
  if [[ -n $trust_run_id && $trust_run_id != "null" ]]; then
    cmd_args+=(--trust-run-id "$trust_run_id")
  fi
  if [[ -n $trust_receipts_json && $trust_receipts_json != "null" ]]; then
    if echo "$trust_receipts_json" | jq -e '
      type == "array" and length > 0 and all(.[];
        (.layer // "") as $l | (.mode // "") as $m | (.verdict // "") as $v |
        (["surfaceproof","evalseal","effectdelta"] | index($l)) != null and
        (["off","shadow","advisory","blocking"] | index($m)) != null and
        (["pass","fail","inconclusive"] | index($v)) != null)' >/dev/null 2>&1; then
      cmd_args+=(--trust-receipts "$trust_receipts_json")
    else
      mkdir -p "$(dirname "$LOG_FILE")"
      printf '%s %s trust-key-dropped: trust_receipts (journal.sh closed-enum 契約を満たさない)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    fi
  fi
  if [[ -n $trust_surfaceproof_json && $trust_surfaceproof_json != "null" ]]; then
    if echo "$trust_surfaceproof_json" | jq -e '
      type == "object" and
      ((.mode // "") as $m | (.verdict // "") as $v |
       (["off","shadow","advisory","blocking"] | index($m)) != null and
       (["pass","fail","inconclusive"] | index($v)) != null)' >/dev/null 2>&1; then
      cmd_args+=(--trust-surfaceproof "$trust_surfaceproof_json")
    else
      mkdir -p "$(dirname "$LOG_FILE")"
      printf '%s %s trust-key-dropped: trust_surfaceproof_shadow (journal.sh closed-enum 契約を満たさない)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    fi
  fi
  if [[ -n $trust_evalseal_missing_reason && $trust_evalseal_missing_reason != "null" ]]; then
    case "$trust_evalseal_missing_reason" in
    eval_skipped | agent_throw | agent_null | seal_error | mode_off | unknown)
      cmd_args+=(--trust-evalseal-missing-reason "$trust_evalseal_missing_reason")
      ;;
    *)
      mkdir -p "$(dirname "$LOG_FILE")"
      printf '%s %s trust-key-dropped: trust_evalseal_missing_reason (journal.sh closed-enum 契約を満たさない)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
      ;;
    esac
  fi
  # EffectDelta PR stage receipt の欠落理由（skills#476 Phase 1 の送り側）。enum は
  # journal.sh の --trust-effectdelta-pr-missing-reason と一致させること。EvalSeal 側とは
  # 独立定義であり（skills#476 D-3）、値集合が違うので case を共有しない。
  # journal.sh は out-of-enum・空文字の両方で die_json する（fail-closed）ため、
  # 契約を満たさない値は必ず送り側で drop する（entry ごと失わないため）。
  if [[ -n $trust_effectdelta_pr_missing_reason && $trust_effectdelta_pr_missing_reason != "null" ]]; then
    case "$trust_effectdelta_pr_missing_reason" in
    agent_throw | agent_null | mode_off | gh_failed | script_error | agent_error | schema_invalid | unknown)
      cmd_args+=(--trust-effectdelta-pr-missing-reason "$trust_effectdelta_pr_missing_reason")
      ;;
    *)
      mkdir -p "$(dirname "$LOG_FILE")"
      printf '%s %s trust-key-dropped: trust_effectdelta_pr_missing_reason (journal.sh closed-enum 契約を満たさない)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
      ;;
    esac
  fi

  # --- telemetry 8-key forwarding (issue #143 / #430) ---
  # vdelta_verdicts / vdelta_fail_open / redgreen_deny / testsurf_hits /
  # duration_seconds / phase_durations / merge_tier_reasons / route を journal.sh
  # へ転送する。journal.sh（skill-retrospective/scripts/journal.sh）は受け側でも
  # 同一の型/enum 検証で契約違反を drop するが、drop の観測点を hook ログに残す
  # ため送り側でも同じ検証を行う（trust telemetry と同じ fail-open 方式。
  # base entry の記録は必ず成功させる）。
  if [[ -n $vdelta_verdicts_json && $vdelta_verdicts_json != "null" ]]; then
    if echo "$vdelta_verdicts_json" | jq -e 'type == "array" and all(.[]; type == "object")' >/dev/null 2>&1; then
      cmd_args+=(--vdelta-verdicts "$vdelta_verdicts_json")
    else
      mkdir -p "$(dirname "$LOG_FILE")"
      printf '%s %s telemetry-key-dropped: vdelta_verdicts (journal.sh 契約を満たさない)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    fi
  fi
  if [[ -n $redgreen_deny_json && $redgreen_deny_json != "null" ]]; then
    if echo "$redgreen_deny_json" | jq -e 'type == "array" and all(.[]; type == "object")' >/dev/null 2>&1; then
      cmd_args+=(--redgreen-deny "$redgreen_deny_json")
    else
      mkdir -p "$(dirname "$LOG_FILE")"
      printf '%s %s telemetry-key-dropped: redgreen_deny (journal.sh 契約を満たさない)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    fi
  fi
  if [[ -n $testsurf_hits_json && $testsurf_hits_json != "null" ]]; then
    if echo "$testsurf_hits_json" | jq -e 'type == "array" and all(.[]; type == "string")' >/dev/null 2>&1; then
      cmd_args+=(--testsurf-hits "$testsurf_hits_json")
    else
      mkdir -p "$(dirname "$LOG_FILE")"
      printf '%s %s telemetry-key-dropped: testsurf_hits (journal.sh 契約を満たさない)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    fi
  fi
  if [[ -n $merge_tier_reasons_json && $merge_tier_reasons_json != "null" ]]; then
    if echo "$merge_tier_reasons_json" | jq -e 'type == "array" and all(.[]; type == "string")' >/dev/null 2>&1; then
      cmd_args+=(--merge-tier-reasons "$merge_tier_reasons_json")
    else
      mkdir -p "$(dirname "$LOG_FILE")"
      printf '%s %s telemetry-key-dropped: merge_tier_reasons (journal.sh 契約を満たさない)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    fi
  fi
  if [[ -n $phase_durations_json && $phase_durations_json != "null" ]]; then
    if echo "$phase_durations_json" | jq -e 'type == "object" and all(.[]; type == "number")' >/dev/null 2>&1; then
      cmd_args+=(--phase-durations "$phase_durations_json")
    else
      mkdir -p "$(dirname "$LOG_FILE")"
      printf '%s %s telemetry-key-dropped: phase_durations (journal.sh 契約を満たさない)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    fi
  fi
  if [[ -n $vdelta_fail_open && $vdelta_fail_open != "null" ]]; then
    if [[ $vdelta_fail_open =~ ^[0-9]+$ ]]; then
      cmd_args+=(--vdelta-fail-open "$vdelta_fail_open")
    else
      mkdir -p "$(dirname "$LOG_FILE")"
      printf '%s %s telemetry-key-dropped: vdelta_fail_open (journal.sh 契約を満たさない)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    fi
  fi
  if [[ -n $duration_seconds && $duration_seconds != "null" ]]; then
    if [[ $duration_seconds =~ ^[0-9]+$ ]]; then
      cmd_args+=(--duration-seconds "$duration_seconds")
    else
      mkdir -p "$(dirname "$LOG_FILE")"
      printf '%s %s telemetry-key-dropped: duration_seconds (journal.sh 契約を満たさない)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
    fi
  fi
  if [[ -n $route && $route != "null" ]]; then
    case "$route" in
    lite | full)
      cmd_args+=(--route "$route")
      ;;
    *)
      mkdir -p "$(dirname "$LOG_FILE")"
      printf '%s %s telemetry-key-dropped: route (journal.sh 契約を満たさない)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
      ;;
    esac
  fi
  if [[ -n $guard_id && $guard_id != "null" ]]; then
    cmd_args+=(--guard-id "$guard_id")
  fi

  # --- confidence telemetry (skills#561) ---
  # eval_confidence / review_confidence は記録専用の optional [0,1] 値。他の optional
  # キーと異なり "null" 文字列を drop しない — agent が実行されたが confidence を
  # 返さなかった run（キーあり値 null）を journal.sh 側で JSON null として記録する契約
  # （AC-3）を守るため。キー欠落（agent 自体が非実行）のときだけ非空判定で drop される。
  if [[ -n $eval_confidence ]]; then
    cmd_args+=(--eval-confidence "$eval_confidence")
  fi
  if [[ -n $review_confidence ]]; then
    cmd_args+=(--review-confidence "$review_confidence")
  fi
  if [[ -n $review_decision && $review_decision != "null" ]]; then
    case "$review_decision" in
    approve | request-changes | comment)
      cmd_args+=(--review-decision "$review_decision")
      ;;
    *)
      mkdir -p "$(dirname "$LOG_FILE")"
      printf '%s %s telemetry-key-dropped: review_decision (journal.sh 契約を満たさない)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >>"$LOG_FILE"
      ;;
    esac
  fi

  # --- passthrough telemetry (skills#535) ---
  # journal.sh の汎用 --telemetry-json 口（任意 JSON object を telemetry へマージ）へ載せる。
  # この projection は固定キー列挙なので、per-key フラグを持たないキーは列挙漏れすると
  # エラーも出さずに落ちる（実測: fix_null_retries / review_null_retries /
  # fix_uncommitted_recovered / subagent_invocations が payload に存在したまま journal に
  # 到達していなかった）。新規キーは per-key フラグではなくこのリストへ足すこと。
  if [[ -n $passthrough_telemetry_json && $passthrough_telemetry_json != "{}" ]]; then
    cmd_args+=(--telemetry-json "$passthrough_telemetry_json")
  fi

  # --- Execute journal.sh ---
  journal_stderr=""
  if journal_stderr=$(bash "$journal_sh" "${cmd_args[@]}" 2>&1 >/dev/null); then
    # Success: remove claimed file
    rm -f "$claimed"
  else
    # Failure: restore original filename, write log
    mv "$claimed" "$f"
    mkdir -p "$(dirname "$LOG_FILE")"
    printf '%s %s journal-failed: %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$(basename "$f")" \
      "$(echo "$journal_stderr" | head -1 | tr '\n' ' ')" >>"$LOG_FILE"
  fi
done

exit 0
