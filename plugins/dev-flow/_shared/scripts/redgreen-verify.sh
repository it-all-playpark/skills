#!/usr/bin/env bash
# red→green 実証: 実装だけ退避して base に戻し、test が red→green に転じるか決定論判定する。
# untracked(新規)・tracked-modified いずれの impl ファイルにも対応する。
# 使い方: redgreen-verify.sh <worktree> <test_files_csv> <impl_files_csv> [<test_files_csv> <impl_files_csv> ...]
#   (test_files, impl_files) ペアを複数受け、引数順に 1 ペアずつ退避→red→復元→green を実行する。
#   ペアごとの red 意味論は 1 ペア呼び出しと同一(当該ペアの impl だけを外す)。worktree を書き換えるため
#   ペア間の並列化は不可で、Evaluate の全 AC を 1 呼び出しにまとめるのは spawn 数削減のため(issue #683)。
# 受理する test_files glob: *.test.mjs / *.bats / *.test.ts / *.test.tsx
# 出力(stdout, JSON 1行。results は引数順の配列。root を object にするのは workflow の agent() schema が
# root object を要求するため — haiku proxy に配列を包み直させず verbatim 転写で済ませる):
#   {"results":[{"index":N,"red":bool,"green":bool,"reason":"...","testcmd_ran":bool[,"headdiff":{new,modified,unchanged,total}][,"verdict":{...}]}, ...]}
# 入力・分離エラーのペアは {"index":N,"red":false,"green":false,"reason":"..."} で続行する(testcmd_ran なし)。
# headdiff は test_cmd 経路が走らなかったペア(testcmd_ran=false)でのみ付く。
# test_files を HEAD 基準で new(HEAD に無い)/modified(HEAD にあり差分あり)/unchanged(HEAD と同一)
# に三分類した件数で、runner の種類・拡張子に依存しない fallback 信号。red/green の判定には影響しない。
# exit 0 = 1 ペア以上が判定完了(red/green は JSON 参照) / exit 2 = 全ペアが入力・分離エラー、
# または引数不正(stdout は {"results":[]})(= deterministic 昇格しないこと)
set -uo pipefail

WT="${1:?worktree required}"
shift
if [ "$#" -lt 2 ] || [ $(( $# % 2 )) -ne 0 ]; then
  echo "usage: redgreen-verify.sh <worktree> <test_files_csv> <impl_files_csv> [<test_files_csv> <impl_files_csv> ...]" >&2
  echo '{"results":[]}'; exit 2
fi

cd "$WT" 2>/dev/null || { echo "cd failed: $WT" >&2; echo '{"results":[]}'; exit 2; }

# opt-in 設定(.claude/redgreen.conf, key=value 平文, source は使わない)
# 不在・キー不在・値なしなら空文字のまま = 従来挙動と完全不変。
RG_CONF="$WT/.claude/redgreen.conf"
RG_TEST_CMD=""
RG_VERDICT_CMD=""
if [ -f "$RG_CONF" ]; then
  RG_TEST_CMD="$(grep -E '^test_cmd=' "$RG_CONF" | head -1 | cut -d= -f2-)"
  RG_VERDICT_CMD="$(grep -E '^verdict_cmd=' "$RG_CONF" | head -1 | cut -d= -f2-)"
fi

# --- ペア単位の状態(verify_pair の冒頭で毎回リセットする) ---
TESTS=()
IMPLS=()
# verdict_cmd は当該ペアで test_cmd(vdelta run) 経路が実際に実行された
# 場合のみ起動する。bats-only 等 test_cmd 未実行のペアでは RunStore に
# 当該 red/green の run pair が存在せず、無条件実行すると spurious な
# baseline-missing/malformed verdict を招くため。
VDELTA_TESTCMD_RAN=false
# impl ファイルを HEAD 基準で三分類する。共有 stash スタック(main checkout・全 worktree・
# 全セッションで共有)には一切読み書きしない — 位置指定 pop は「自分が積んだ entry」を
# 保証せず、他セッションの WIP を worktree に適用する(issue #630)。
#   UNTRACKED_IMPLS: HEAD に無い(未追跡 / git add のみの新規) → cp -p 退避 + rm
#   TRACKED_IMPLS  : HEAD にあり worktree と差分あり → cp -p 退避 + git checkout HEAD -- で base 化
#   UNCHANGED_IMPLS: HEAD と同一 → 退避対象外(base 化しても red 判定に寄与しない)
TMPDIR_IMPL=""
UNTRACKED_IMPLS=()
TRACKED_IMPLS=()
UNCHANGED_IMPLS=()
UNTRACKED_SAVED=false
TRACKED_SAVED=false
PAIR_JSON=""

run_tests() {
  local rc=0 node_tests=() vitest_tests=() bats_tests=() cmd_tests=()
  for t in "${TESTS[@]}"; do
    case "$t" in
      *.test.mjs) node_tests+=("$t"); cmd_tests+=("$t") ;;
      *.test.ts|*.test.tsx) vitest_tests+=("$t"); cmd_tests+=("$t") ;;
      *.bats) bats_tests+=("$t") ;;
    esac
  done
  if [ -n "$RG_TEST_CMD" ] && [ "${#cmd_tests[@]}" -gt 0 ]; then
    local _tc=()
    read -r -a _tc <<< "$RG_TEST_CMD"
    "${_tc[@]}" "${cmd_tests[@]}" >/dev/null 2>&1 || rc=1
    # test_cmd(vdelta run) 経路を実行した事実を記録する(rc とは独立。
    # red phase の失敗は期待値であり test_cmd 未実行を意味しない)。
    VDELTA_TESTCMD_RAN=true
  else
    if [ "${#node_tests[@]}" -gt 0 ]; then node --test "${node_tests[@]}" >/dev/null 2>&1 || rc=1; fi
    if [ "${#vitest_tests[@]}" -gt 0 ]; then npx vitest run "${vitest_tests[@]}" >/dev/null 2>&1 || rc=1; fi
  fi
  if [ "${#bats_tests[@]}" -gt 0 ]; then bats "${bats_tests[@]}" >/dev/null 2>&1 || rc=1; fi
  return $rc
}

# 退避済み impl を $TMPDIR_IMPL から相対パス保持で書き戻す(cp -p で mode も戻す)。
# 本文と EXIT trap の両方から呼ぶ。配列展開は set -u のため必ず件数 guard 下で行う。
restore_saved() {
  local f
  if [ "$UNTRACKED_SAVED" = true ] && [ "${#UNTRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${UNTRACKED_IMPLS[@]}"; do
      if [ -f "$TMPDIR_IMPL/$f" ]; then mkdir -p "$(dirname "$f")"; cp -p "$TMPDIR_IMPL/$f" "$f"; fi
    done
  fi
  if [ "$TRACKED_SAVED" = true ] && [ "${#TRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${TRACKED_IMPLS[@]}"; do
      if [ -f "$TMPDIR_IMPL/$f" ]; then mkdir -p "$(dirname "$f")"; cp -p "$TMPDIR_IMPL/$f" "$f"; fi
    done
  fi
}

# --- cleanup / restore(二段構え: 各ペアの終端で本文から呼び、途中終了時は EXIT trap が現ペア分を戻す) ---
restore_impl() {
  restore_saved
  UNTRACKED_SAVED=false
  TRACKED_SAVED=false
  if [ -n "$TMPDIR_IMPL" ]; then rm -rf "$TMPDIR_IMPL"; TMPDIR_IMPL=""; fi
}
trap restore_impl EXIT

# 1 ペアを判定する。PAIR_JSON に index 抜きの JSON 本体を残し、判定完了なら 0・入力/分離エラーなら 2 を返す。
# 退避した impl の復元は呼び出し側の restore_impl が担う(return 経路を問わず必ず呼ぶ)。
verify_pair() {
  local test_csv="$1" impl_csv="$2" t i f
  TESTS=(); IMPLS=()
  UNTRACKED_IMPLS=(); TRACKED_IMPLS=(); UNCHANGED_IMPLS=()
  UNTRACKED_SAVED=false; TRACKED_SAVED=false
  VDELTA_TESTCMD_RAN=false
  PAIR_JSON=""

  IFS=',' read -r -a TESTS <<< "$test_csv"
  IFS=',' read -r -a IMPLS <<< "$impl_csv"

  # 層2: runner glob で test_files を検証(*.test.mjs / *.bats / *.test.ts / *.test.tsx 以外は拒否。
  # playwright の *.spec.ts は scope 外で拒否)
  for t in "${TESTS[@]}"; do
    case "$t" in
      *.test.mjs|*.bats|*.test.ts|*.test.tsx) : ;;
      *) PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"non-test file declared: $t\""; return 2 ;;
    esac
  done
  # 層4: test と impl の混在(同一ファイル)は曖昧 → 昇格しない
  for t in "${TESTS[@]}"; do
    for i in "${IMPLS[@]}"; do
      [ "$t" = "$i" ] && { PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"file is both test and impl: $t\""; return 2; }
    done
  done

  TMPDIR_IMPL="$(mktemp -d)"
  for f in "${IMPLS[@]}"; do
    # cat-file -e は HEAD に無いと rc 128 + stderr メッセージ → 抑止して成否だけ使う
    if git cat-file -e "HEAD:$f" >/dev/null 2>&1; then
      if git diff --quiet HEAD -- "$f"; then
        UNCHANGED_IMPLS+=("$f")
      else
        TRACKED_IMPLS+=("$f")
      fi
    else
      UNTRACKED_IMPLS+=("$f")
    fi
  done

  # 0. 退避対象(untracked + 変更あり tracked)の存在を、worktree に何も加える前に全件検証する
  #    (部分退避による消失防止。削除済み tracked impl も base 化しても red 判定に意味が無いのでここで弾く)
  if [ "${#UNTRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${UNTRACKED_IMPLS[@]}"; do
      [ -f "$f" ] || { PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"impl file not found: $f\""; return 2; }
    done
  fi
  if [ "${#TRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${TRACKED_IMPLS[@]}"; do
      [ -f "$f" ] || { PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"impl file not found: $f\""; return 2; }
    done
  fi

  # 有効 impl が 0 件 = 何も外せないので red 判定に意味が無い → 判定せず 2(deterministic 昇格しない契約)
  if [ "${#UNTRACKED_IMPLS[@]}" -eq 0 ] && [ "${#TRACKED_IMPLS[@]}" -eq 0 ]; then
    PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"no impl changed vs HEAD: $impl_csv\""; return 2
  fi

  # 1. untracked impl: cp -p 退避 → rm
  if [ "${#UNTRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${UNTRACKED_IMPLS[@]}"; do
      mkdir -p "$TMPDIR_IMPL/$(dirname "$f")"
      cp -p "$f" "$TMPDIR_IMPL/$f"
      rm -f "$f"
    done
    UNTRACKED_SAVED=true
  fi

  # 2. 変更あり tracked impl: 全件 cp -p 退避 → TRACKED_SAVED=true(以降の失敗は restore_impl が戻す) → git checkout HEAD -- で base 化
  if [ "${#TRACKED_IMPLS[@]}" -gt 0 ]; then
    for f in "${TRACKED_IMPLS[@]}"; do
      mkdir -p "$TMPDIR_IMPL/$(dirname "$f")"
      cp -p "$f" "$TMPDIR_IMPL/$f"
    done
    TRACKED_SAVED=true
    for f in "${TRACKED_IMPLS[@]}"; do
      if ! git checkout HEAD -- "$f" >/dev/null 2>&1; then
        PAIR_JSON="\"red\":false,\"green\":false,\"reason\":\"base checkout failed: $f\""; return 2
      fi
    done
  fi

  # red 判定(impl 退避中: test は落ちるべき)
  local red green
  if run_tests; then red=false; else red=true; fi

  # 復元(本文側。EXIT trap / restore_impl も呼ばれるがフラグを落として二重復元を防ぐ)
  restore_saved
  UNTRACKED_SAVED=false
  TRACKED_SAVED=false

  # green 判定(復元後: test は通るべき)
  if run_tests; then green=true; else green=false; fi

  # headdiff: test_cmd 経路が走らなかったペア(VDELTA_TESTCMD_RAN=false)でのみ、
  # test_files を HEAD 基準で三分類する(拡張子非依存の fallback 信号。判定には使わない)。
  local headdiff_json="" hd_new=0 hd_mod=0 hd_unch=0
  if [ "$VDELTA_TESTCMD_RAN" = false ] && git rev-parse --verify -q HEAD >/dev/null 2>&1; then
    for t in "${TESTS[@]}"; do
      if git cat-file -e "HEAD:$t" >/dev/null 2>&1; then
        if git diff --quiet HEAD -- "$t"; then hd_unch=$((hd_unch+1)); else hd_mod=$((hd_mod+1)); fi
      else
        hd_new=$((hd_new+1))
      fi
    done
    headdiff_json=",\"headdiff\":{\"new\":$hd_new,\"modified\":$hd_mod,\"unchanged\":$hd_unch,\"total\":${#TESTS[@]}}"
  fi

  PAIR_JSON="\"red\":$red,\"green\":$green,\"reason\":\"ok\",\"testcmd_ran\":$VDELTA_TESTCMD_RAN$headdiff_json"

  # post-green verdict フック(opt-in, fail-open): red/green 判定が確定した後にのみ走る。
  # 非ゼロ exit・空出力・不正 JSON・jq 不在のいずれでも PAIR_JSON をそのまま返す。
  # 当該ペアで test_cmd 経路が実行されていない場合(bats-only AC 等)は
  # RunStore に run pair が存在しないため起動しない(VDELTA_TESTCMD_RAN guard)。
  if [ -n "$RG_VERDICT_CMD" ] && [ "$VDELTA_TESTCMD_RAN" = true ] && command -v jq >/dev/null 2>&1; then
    local vc=() hook_json hook_rc merged
    read -r -a vc <<< "$RG_VERDICT_CMD"
    hook_json="$("${vc[@]}" 2>/dev/null)"
    hook_rc=$?
    if [ "$hook_rc" -eq 0 ] && [ -n "$hook_json" ] && jq -c . >/dev/null 2>&1 <<< "$hook_json"; then
      merged="$(jq -c --argjson v "$hook_json" '. + {verdict: $v}' <<< "{$PAIR_JSON}")"
      PAIR_JSON="${merged#\{}"
      PAIR_JSON="${PAIR_JSON%\}}"
    fi
  fi
  return 0
}

RESULTS=()
COMPLETED=0
INDEX=0
while [ "$#" -ge 2 ]; do
  if verify_pair "$1" "$2"; then COMPLETED=$((COMPLETED+1)); fi
  restore_impl
  RESULTS+=("{\"index\":$INDEX,$PAIR_JSON}")
  INDEX=$((INDEX+1))
  shift 2
done

OUT='{"results":['
for ((k = 0; k < ${#RESULTS[@]}; k++)); do
  [ "$k" -gt 0 ] && OUT="$OUT,"
  OUT="$OUT${RESULTS[$k]}"
done
echo "$OUT]}"
[ "$COMPLETED" -gt 0 ] && exit 0
exit 2
