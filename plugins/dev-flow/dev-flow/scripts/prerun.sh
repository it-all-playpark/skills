#!/usr/bin/env bash
# prerun.sh - dev-flow Setup phase の決定論処理を 1 コマンドに集約する (issue #641)
#
# top-level Bash が bare 名 launcher (bin/dev-flow-prerun) 経由でこのスクリプトを実行し、
# stdout の JSON 1行を `Workflow({ args: { issue, setup: <JSON> } })` の args.setup へそのまま渡す。
#
# 行う処理: base 解決 (origin/dev → origin/HEAD フォールバック) → worktree 作成/再利用 +
# 起点(base)一致検証 + 書き込み probe → .devflow-tmp の git clean -fdx → deps install →
# detect-stack。各段は独立に ok/error を報告し、後続段を巻き込まない。
#
# 禁止: GitHub CLI 経由の呼び出しやリモート更新系の書き込みコマンド（資格情報不要な
# 読み取り専用 git 操作のみで完結させる契約。.claude/rules/dev-flow.md 参照）。

set -euo pipefail

# _lib/common.sh は playpark-core plugin にある。core の bin/journal（PATH）を起点に解決する（plugin 境界を ../ で跨がない）
_CORE_BIN="$(command -v journal)" || { echo "playpark-core plugin (bin/journal) not on PATH" >&2; exit 127; }
source "$(dirname "$_CORE_BIN")/../_lib/common.sh"

has_jq || { echo "jq is required" >&2; exit 127; }

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
    echo "Usage: dev-flow-prerun --issue <N> --worktree <abs-path> [--base <ref>]" >&2
}

# ============================================================================
# Args
# ============================================================================

ISSUE=""
WT=""
BASE_ARG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --issue)
            [[ $# -ge 2 ]] || { usage; exit 2; }
            ISSUE="$2"; shift 2 ;;
        --worktree)
            [[ $# -ge 2 ]] || { usage; exit 2; }
            WT="$2"; shift 2 ;;
        --base)
            [[ $# -ge 2 ]] || { usage; exit 2; }
            BASE_ARG="$2"; shift 2 ;;
        *)
            echo "Unknown option: $1" >&2
            usage
            exit 2 ;;
    esac
done

[[ -n "$ISSUE" ]] || { echo "--issue is required" >&2; usage; exit 2; }
[[ "$ISSUE" =~ ^[1-9][0-9]*$ ]] || { echo "--issue must be a positive integer" >&2; exit 2; }
[[ -n "$WT" ]] || { echo "--worktree is required" >&2; usage; exit 2; }
[[ "$WT" == /* ]] || { echo "--worktree must be an absolute path" >&2; exit 2; }
if [[ -n "$BASE_ARG" ]]; then
    [[ "$BASE_ARG" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || {
        echo "--base contains invalid characters (allowed: [A-Za-z0-9][A-Za-z0-9._/-]*)" >&2
        exit 2
    }
fi

# ============================================================================
# ROOT resolution (main worktree is always the first block; cwd may be any worktree)
# ============================================================================

WTLIST_RAW="$(git worktree list --porcelain 2>&1)" || {
    echo "not a git repository (git worktree list failed): ${WTLIST_RAW}" >&2
    exit 2
}
ROOT="$(printf '%s\n' "$WTLIST_RAW" | awk '/^worktree /{print substr($0,10); exit}')"
[[ -n "$ROOT" ]] || { echo "failed to resolve git root from worktree list" >&2; exit 2; }

# git worktree list --porcelain はディレクトリの物理パス (シンボリックリンク解決済み) を報告する
# (macOS の /var -> /private/var 等)。引数 --worktree は raw のまま JSON へ出力する契約
# (常に引数値) だが、既存 worktree ブロックとの突合せだけはこの物理パスで行う。
canon_path() {
    local p="$1" dir base
    if [[ -e "$p" ]]; then
        (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "$p"
    else
        dir="$(dirname "$p")"
        base="$(basename "$p")"
        if [[ -d "$dir" ]]; then
            printf '%s/%s' "$(cd "$dir" && pwd -P)" "$base"
        else
            printf '%s' "$p"
        fi
    fi
}

RECOVERY_STEPS_FOR() {
    local wt="$1" base_name="$2"
    printf 'このいずれかで復旧して再実行せよ: (1) git worktree remove %s（失敗時は --force）で当該 worktree を削除して dev-flow を再実行する（origin/%s 起点で作り直される）、(2) 既存 worktree の起点を意図しているなら --base を明示して一致させて再実行する。' "$wt" "$base_name"
}

# ============================================================================
# Segment 0: repo (owner/name) resolution — best-effort, independent of other segments
# ============================================================================

repo=""
ORIGIN_URL="$(git -C "$ROOT" remote get-url origin 2>/dev/null)" || ORIGIN_URL=""
REPO_BODY=""
if [[ "$ORIGIN_URL" =~ ^https://github\.com/(.+)$ ]]; then
    REPO_BODY="${BASH_REMATCH[1]}"
elif [[ "$ORIGIN_URL" =~ ^git@github\.com:(.+)$ ]]; then
    REPO_BODY="${BASH_REMATCH[1]}"
elif [[ "$ORIGIN_URL" =~ ^ssh://git@github\.com/(.+)$ ]]; then
    REPO_BODY="${BASH_REMATCH[1]}"
fi
if [[ -n "$REPO_BODY" ]]; then
    REPO_BODY="${REPO_BODY%/}"
    REPO_BODY="${REPO_BODY%.git}"
    if [[ "$REPO_BODY" =~ ^([^/]+)/([^/]+)$ ]]; then
        repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    fi
fi

# ============================================================================
# Segment 1: base resolution
# ============================================================================

base=""
base_source=""
base_error=""
BASE_OK=false

if FETCH_OUT="$(git -C "$ROOT" fetch origin --quiet 2>&1)"; then
    if [[ -n "$BASE_ARG" ]]; then
        if git -C "$ROOT" ls-remote --exit-code --heads origin "refs/heads/$BASE_ARG" >/dev/null 2>&1; then
            base="$BASE_ARG"
            base_source="explicit"
            BASE_OK=true
        else
            base_error="指定された base origin/${BASE_ARG} が origin に存在しない"
        fi
    else
        if git -C "$ROOT" ls-remote --exit-code --heads origin "refs/heads/dev" >/dev/null 2>&1; then
            base="dev"
            base_source="origin/dev"
            BASE_OK=true
        else
            HEAD_REF="$(git -C "$ROOT" ls-remote --symref origin HEAD 2>/dev/null | awk '/^ref:/{sub("refs/heads/","",$2); print $2; exit}')"
            if [[ -n "$HEAD_REF" ]]; then
                base="$HEAD_REF"
                base_source="origin/HEAD"
                BASE_OK=true
            else
                base_error="origin/dev が存在せず origin/HEAD の default branch も取得できない"
            fi
        fi
    fi
else
    base_error="git fetch origin failed: ${FETCH_OUT}"
fi

# ============================================================================
# Segment 2: worktree create/reuse + base-origin match verification + write probe
# ============================================================================

BRANCH="feature/issue-${ISSUE}"
worktree_status=""
worktree_error=""
worktree_removed=false
head=""
SEG2_OK=false

validate_upstream() {
    # sets global worktree_error on mismatch. echoes "match" / "mismatch" to stdout.
    local br="$1" remote merge short upstream expected pushed
    remote="$(git -C "$ROOT" config --get "branch.${br}.remote" 2>/dev/null)" || remote=""
    merge="$(git -C "$ROOT" config --get "branch.${br}.merge" 2>/dev/null)" || merge=""
    short="${merge#refs/heads/}"
    if [[ -n "$remote" && -n "$short" ]]; then
        upstream="${remote}/${short}"
    else
        upstream=""
    fi
    expected="origin/${base}"
    pushed="origin/feature/issue-${ISSUE}"
    if [[ "$upstream" == "$expected" || "$upstream" == "$pushed" ]]; then
        return 0
    fi
    if [[ -z "$upstream" ]]; then
        worktree_error="既存 worktree の起点を判定できなかった（upstream tracking 未設定）。期待する起点: ${expected}。$(RECOVERY_STEPS_FOR "$WT" "$base")"
    else
        worktree_error="既存 worktree の起点が一致しない。実際の起点: ${upstream} / 期待する起点: ${expected}。$(RECOVERY_STEPS_FOR "$WT" "$base")"
    fi
    return 1
}

if [[ "$BASE_OK" == true ]]; then
    WTLIST2="$(git -C "$ROOT" worktree list --porcelain 2>&1)" || WTLIST2=""
    CANON_WT="$(canon_path "$WT")"
    BLOCK_INFO="$(printf '%s\n' "$WTLIST2" | awk -v target="worktree ${CANON_WT}" '
        BEGIN { RS=""; FS="\n"; found=0; prunable=0; branch=""; detached=0 }
        {
            if ($1 == target) {
                found=1
                for (i = 2; i <= NF; i++) {
                    if ($i ~ /^branch refs\/heads\//) { b=$i; sub(/^branch refs\/heads\//, "", b); branch=b }
                    else if ($i ~ /^prunable/) prunable=1
                    else if ($i == "detached") detached=1
                }
            }
        }
        END {
            print "FOUND=" found
            print "PRUNABLE=" prunable
            print "BRANCH=" branch
            print "DETACHED=" detached
        }
    ')"

    FOUND=0; PRUNABLE=0; BRANCH_FOUND=""; DETACHED=0
    while IFS='=' read -r k v; do
        case "$k" in
            FOUND) FOUND="$v" ;;
            PRUNABLE) PRUNABLE="$v" ;;
            BRANCH) BRANCH_FOUND="$v" ;;
            DETACHED) DETACHED="$v" ;;
        esac
    done <<<"$BLOCK_INFO"

    CREATED_THIS_CALL=false
    SEG2_CORE_OK=false

    if [[ "$FOUND" == "1" && "$PRUNABLE" == "0" ]]; then
        # (a) 既存 worktree を再利用
        worktree_status="reused"
        if [[ -z "$BRANCH_FOUND" ]]; then
            worktree_error="既存 worktree の起点を判定できなかった（detached HEAD）。$(RECOVERY_STEPS_FOR "$WT" "$base")"
        else
            if validate_upstream "$BRANCH_FOUND"; then
                SEG2_CORE_OK=true
            fi
        fi
    else
        if [[ "$FOUND" == "1" && "$PRUNABLE" == "1" ]]; then
            git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
        fi
        # (c) 未登録: 新規作成経路
        if [[ -d "$WT" ]]; then
            worktree_status="error"
            worktree_error="path exists but is not a registered git worktree: ${WT}"
        elif git -C "$ROOT" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
            if ADD_ERR="$(git -C "$ROOT" worktree add "$WT" "$BRANCH" 2>&1)"; then
                worktree_status="created"
                CREATED_THIS_CALL=true
                if validate_upstream "$BRANCH"; then
                    SEG2_CORE_OK=true
                fi
            else
                worktree_status="error"
                worktree_error="$ADD_ERR"
            fi
        else
            if ADD_ERR="$(git -C "$ROOT" worktree add --track -b "$BRANCH" "$WT" "origin/${base}" 2>&1)"; then
                worktree_status="created"
                CREATED_THIS_CALL=true
                SEG2_CORE_OK=true
            else
                worktree_status="error"
                worktree_error="$ADD_ERR"
            fi
        fi
    fi

    if [[ "$SEG2_CORE_OK" == true ]]; then
        # (d) 書き込み probe
        if PROBE_ERR="$( { mkdir -p "$WT/.devflow-tmp" && touch "$WT/.devflow-tmp/.prerun-write-probe" && rm -f "$WT/.devflow-tmp/.prerun-write-probe"; } 2>&1 )"; then
            SEG2_OK=true
            head="$(git -C "$WT" rev-parse HEAD)"
        else
            worktree_status="unwritable"
            worktree_error="$PROBE_ERR"
            if [[ "$CREATED_THIS_CALL" == true ]]; then
                git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
                worktree_removed=true
            fi
        fi
    fi
else
    worktree_status="skipped"
    worktree_error="skipped: base unresolved"
fi

# ============================================================================
# Segment 3: .devflow-tmp の git clean -fdx (段2成功時のみ)
# ============================================================================

if [[ "$SEG2_OK" == true ]]; then
    if CLEAN_ERR="$(git -C "$WT" clean -fdx -- .devflow-tmp 2>&1)"; then
        clean_json='{"ok":true}'
    else
        clean_json="$(jq -n --arg e "$CLEAN_ERR" '{ok:false, error:$e}')"
    fi
else
    clean_json='{"ok":false,"error":"skipped: worktree unavailable"}'
fi

# ============================================================================
# Segment 4: deps install (段2成功時のみ)
# ============================================================================

summarize_deps() {
    local raw="$1"
    if [[ -z "$raw" ]] || ! printf '%s' "$raw" | jq -e . >/dev/null 2>&1; then
        jq -n '{ok:false, note:"依存インストール結果を確認できなかった（ensure-worktree-deps 応答不正）"}'
        return
    fi
    printf '%s' "$raw" | jq -c '
        def failing: [ (.results // [])[] | select(.status == "failed" or .status == "pm_not_found") ];
        if .status == "no_dependencies" then
            {ok: true, note: ""}
        elif .status == "success" then
            (failing) as $f
            | if ($f | length) == 0 then
                {ok: true, note: ([ (.results // [])[] | (.pm + ":" + .status) ] | join(", "))}
              else
                {ok: false, note: ("依存インストールに失敗した項目あり — " + ([ $f[] | (.ecosystem + "/" + .pm + " (" + .command + "): " + .status) ] | join(", ")))}
              end
        elif (.status == "partial" or .status == "failed") then
            (failing) as $f
            | if ($f | length) > 0 then
                {ok: false, note: ("依存インストールが " + .status + " で終了 — " + ([ $f[] | (.ecosystem + "/" + .pm + " (" + .command + "): " + .status) ] | join(", ")))}
              else
                {ok: false, note: ("依存インストールが " + .status + " で終了 — " + (.error // "詳細不明"))}
              end
        else
            {ok: false, note: "依存インストール結果を確認できなかった（ensure-worktree-deps 応答不正）"}
        end
    '
}

if [[ "$SEG2_OK" == true ]]; then
    DEPS_RAW="$("$PLUGIN_ROOT/_shared/scripts/ensure-worktree-deps.sh" --path "$WT" --lockfile-only --skip-custom 2>/dev/null)" || DEPS_RAW=""
    # jq フィルタ自体が応答不正で落ちても段4 だけ ok:false に留める（set -e で script 全体を巻き込まない）
    deps_json="$(summarize_deps "$DEPS_RAW")" \
        || deps_json='{"ok":false,"note":"依存インストール結果を確認できなかった（ensure-worktree-deps 応答不正）"}'
else
    deps_json='{"ok":false,"note":"skipped: worktree unavailable"}'
fi

# ============================================================================
# Segment 5: detect-stack (段2成功時のみ)
# ============================================================================

if [[ "$SEG2_OK" == true ]]; then
    STACK_ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/dev-flow-prerun-stack.XXXXXX")"
    if STACK_RAW="$("$PLUGIN_ROOT/_lib/scripts/detect-stack.sh" "$WT" 2>"$STACK_ERR_FILE")" \
        && printf '%s' "$STACK_RAW" | jq -e 'type == "object"' >/dev/null 2>&1; then
        FRAMEWORKS_JSON="$(printf '%s' "$STACK_RAW" | jq -c '[ (.frameworks | if type == "array" then . else [] end)[] | select(type == "string") ]')"
        stack_json="$(jq -n --argjson f "$FRAMEWORKS_JSON" '{frameworks: $f}')"
    else
        STACK_ERR_CONTENT="$(cat "$STACK_ERR_FILE" 2>/dev/null || true)"
        stack_json="$(jq -n --arg e "${STACK_ERR_CONTENT:-detect-stack failed}" '{frameworks: [], error: $e}')"
    fi
    rm -f "$STACK_ERR_FILE"
else
    stack_json='{"frameworks":[],"error":"skipped: worktree unavailable"}'
fi

# ============================================================================
# Output
# ============================================================================

epoch="$(date +%s)"

if [[ "$BASE_OK" == true && "$SEG2_OK" == true ]]; then
    OK_JSON=true
else
    OK_JSON=false
fi

HAVE_REPO=false
[[ -n "$repo" ]] && HAVE_REPO=true
HAVE_BASE=false
[[ "$BASE_OK" == true ]] && HAVE_BASE=true
HAVE_HEAD=false
[[ -n "$head" ]] && HAVE_HEAD=true
HAVE_WT_ERROR=false
[[ -n "$worktree_error" ]] && HAVE_WT_ERROR=true

jq -n \
    --argjson ok "$OK_JSON" \
    --argjson issue "$ISSUE" \
    --arg repo "$repo" \
    --argjson have_repo "$HAVE_REPO" \
    --arg base "$base" \
    --arg base_source "$base_source" \
    --arg base_error "$base_error" \
    --argjson have_base "$HAVE_BASE" \
    --arg worktree "$WT" \
    --arg branch "$BRANCH" \
    --arg head "$head" \
    --argjson have_head "$HAVE_HEAD" \
    --arg worktree_status "$worktree_status" \
    --arg worktree_error "$worktree_error" \
    --argjson have_worktree_error "$HAVE_WT_ERROR" \
    --argjson worktree_removed "$worktree_removed" \
    --argjson clean "$clean_json" \
    --argjson deps "$deps_json" \
    --argjson stack "$stack_json" \
    --argjson epoch "$epoch" \
    '
    {ok: $ok, issue: $issue}
    + (if $have_repo then {repo: $repo} else {} end)
    + (if $have_base then {base: $base, base_source: $base_source} else {base_error: $base_error} end)
    + {worktree: $worktree, branch: $branch}
    + (if $have_head then {head: $head} else {} end)
    + (if $have_worktree_error then {worktree_error: $worktree_error} else {} end)
    + {worktree_status: $worktree_status, worktree_removed: $worktree_removed}
    + {clean: $clean, deps: $deps, stack: $stack, epoch: $epoch}
    '

exit 0
