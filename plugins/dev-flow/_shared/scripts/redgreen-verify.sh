#!/usr/bin/env bash
# red→green 実証: 実装だけ退避して base に戻し、test が red→green に転じるか決定論判定する。
# untracked(新規)・tracked-modified いずれの impl ファイルにも対応する。
# 使い方: redgreen-verify.sh <worktree> <test_files_csv> <impl_files_csv>
# 出力(stdout, JSON 1行): {"red":bool,"green":bool,"reason":"..."}
# exit 0 = 判定完了(red/green は JSON 参照) / exit 2 = 入力・分離エラー(= deterministic 昇格しないこと)
set -uo pipefail

WT="${1:?worktree required}"
TEST_CSV="${2:?test_files required}"
IMPL_CSV="${3:?impl_files required}"

cd "$WT" 2>/dev/null || { echo '{"red":false,"green":false,"reason":"cd failed"}'; exit 2; }

# opt-in 設定(.claude/redgreen.conf, key=value 平文, source は使わない)
# 不在・キー不在・値なしなら空文字のまま = 従来挙動と完全不変。
RG_CONF="$WT/.claude/redgreen.conf"
RG_TEST_CMD=""
RG_VERDICT_CMD=""
if [ -f "$RG_CONF" ]; then
  RG_TEST_CMD="$(grep -E '^test_cmd=' "$RG_CONF" | head -1 | cut -d= -f2-)"
  RG_VERDICT_CMD="$(grep -E '^verdict_cmd=' "$RG_CONF" | head -1 | cut -d= -f2-)"
fi

# verdict_cmd は当該 invocation で test_cmd(vdelta run) 経路が実際に実行された
# 場合のみ起動する。bats-only 等 test_cmd 未実行の invocation では RunStore に
# 当該 red/green の run pair が存在せず、無条件実行すると spurious な
# baseline-missing/malformed verdict を招くため。
VDELTA_TESTCMD_RAN=false

IFS=',' read -r -a TESTS <<< "$TEST_CSV"
IFS=',' read -r -a IMPLS <<< "$IMPL_CSV"

# 層2: runner glob で test_files を検証(*.test.mjs / *.bats 以外は拒否)
for t in "${TESTS[@]}"; do
  case "$t" in
    *.test.mjs|*.bats) : ;;
    *) echo "{\"red\":false,\"green\":false,\"reason\":\"non-test file declared: $t\"}"; exit 2 ;;
  esac
done
# 層4: test と impl の混在(同一ファイル)は曖昧 → 昇格しない
for t in "${TESTS[@]}"; do
  for i in "${IMPLS[@]}"; do
    [ "$t" = "$i" ] && { echo "{\"red\":false,\"green\":false,\"reason\":\"file is both test and impl: $t\"}"; exit 2; }
  done
done

run_tests() {
  local rc=0 node_tests=() bats_tests=()
  for t in "${TESTS[@]}"; do
    case "$t" in
      *.test.mjs) node_tests+=("$t") ;;
      *.bats) bats_tests+=("$t") ;;
    esac
  done
  if [ "${#node_tests[@]}" -gt 0 ]; then
    if [ -n "$RG_TEST_CMD" ]; then
      local _tc=()
      read -r -a _tc <<< "$RG_TEST_CMD"
      "${_tc[@]}" "${node_tests[@]}" >/dev/null 2>&1 || rc=1
      # test_cmd(vdelta run) 経路を実行した事実を記録する(rc とは独立。
      # red phase の失敗は期待値であり test_cmd 未実行を意味しない)。
      VDELTA_TESTCMD_RAN=true
    else
      node --test "${node_tests[@]}" >/dev/null 2>&1 || rc=1
    fi
  fi
  if [ "${#bats_tests[@]}" -gt 0 ]; then bats "${bats_tests[@]}" >/dev/null 2>&1 || rc=1; fi
  return $rc
}

# impl ファイルを HEAD 基準で三分類する。共有 stash スタック(main checkout・全 worktree・
# 全セッションで共有)には一切読み書きしない — 位置指定 pop は「自分が積んだ entry」を
# 保証せず、他セッションの WIP を worktree に適用する(issue #630)。
#   UNTRACKED_IMPLS: HEAD に無い(未追跡 / git add のみの新規) → cp -p 退避 + rm
#   TRACKED_IMPLS  : HEAD にあり worktree と差分あり → cp -p 退避 + git checkout HEAD -- で base 化
#   UNCHANGED_IMPLS: HEAD と同一 → 退避対象外(base 化しても red 判定に寄与しない)
TMPDIR_IMPL="$(mktemp -d)"
UNTRACKED_IMPLS=()
TRACKED_IMPLS=()
UNCHANGED_IMPLS=()

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

UNTRACKED_SAVED=false
TRACKED_SAVED=false

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

# --- cleanup / restore trap(二段構えの片方。exit code は trap 内で exit しない限り伝播する) ---
restore_impl() {
  restore_saved
  UNTRACKED_SAVED=false
  TRACKED_SAVED=false
  rm -rf "$TMPDIR_IMPL"
}
trap restore_impl EXIT

# 0. 退避対象(untracked + 変更あり tracked)の存在を、worktree に何も加える前に全件検証する
#    (部分退避による消失防止。削除済み tracked impl も base 化しても red 判定に意味が無いのでここで弾く)
if [ "${#UNTRACKED_IMPLS[@]}" -gt 0 ]; then
  for f in "${UNTRACKED_IMPLS[@]}"; do
    [ -f "$f" ] || { echo "{\"red\":false,\"green\":false,\"reason\":\"impl file not found: $f\"}"; exit 2; }
  done
fi
if [ "${#TRACKED_IMPLS[@]}" -gt 0 ]; then
  for f in "${TRACKED_IMPLS[@]}"; do
    [ -f "$f" ] || { echo "{\"red\":false,\"green\":false,\"reason\":\"impl file not found: $f\"}"; exit 2; }
  done
fi

# 有効 impl が 0 件 = 何も外せないので red 判定に意味が無い → 判定せず exit 2(deterministic 昇格しない契約)
if [ "${#UNTRACKED_IMPLS[@]}" -eq 0 ] && [ "${#TRACKED_IMPLS[@]}" -eq 0 ]; then
  echo "{\"red\":false,\"green\":false,\"reason\":\"no impl changed vs HEAD: $IMPL_CSV\"}"; exit 2
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

# 2. 変更あり tracked impl: 全件 cp -p 退避 → TRACKED_SAVED=true(以降の失敗は trap が戻す) → git checkout HEAD -- で base 化
if [ "${#TRACKED_IMPLS[@]}" -gt 0 ]; then
  for f in "${TRACKED_IMPLS[@]}"; do
    mkdir -p "$TMPDIR_IMPL/$(dirname "$f")"
    cp -p "$f" "$TMPDIR_IMPL/$f"
  done
  TRACKED_SAVED=true
  for f in "${TRACKED_IMPLS[@]}"; do
    if ! git checkout HEAD -- "$f" >/dev/null 2>&1; then
      echo "{\"red\":false,\"green\":false,\"reason\":\"base checkout failed: $f\"}"; exit 2
    fi
  done
fi

# red 判定(impl 退避中: test は落ちるべき)
if run_tests; then RED=false; else RED=true; fi

# 復元(本文側。trap は EXIT 時にも呼ばれるがフラグを落として二重復元を防ぐ)
restore_saved
UNTRACKED_SAVED=false
TRACKED_SAVED=false

# green 判定(復元後: test は通るべき)
if run_tests; then GREEN=true; else GREEN=false; fi

BASE_JSON="{\"red\":$RED,\"green\":$GREEN,\"reason\":\"ok\"}"

# post-green verdict フック(opt-in, fail-open): red/green 判定が確定した後にのみ走る。
# 非ゼロ exit・空出力・不正 JSON・jq 不在のいずれでも BASE_JSON をそのまま返す。
# 当該 invocation で test_cmd 経路が実行されていない場合(bats-only AC 等)は
# RunStore に run pair が存在しないため起動しない(VDELTA_TESTCMD_RAN guard)。
if [ -n "$RG_VERDICT_CMD" ] && [ "$VDELTA_TESTCMD_RAN" = true ] && command -v jq >/dev/null 2>&1; then
  VC=()
  read -r -a VC <<< "$RG_VERDICT_CMD"
  HOOK_JSON="$("${VC[@]}" 2>/dev/null)"
  HOOK_RC=$?
  if [ "$HOOK_RC" -eq 0 ] && [ -n "$HOOK_JSON" ] && jq -c . >/dev/null 2>&1 <<< "$HOOK_JSON"; then
    jq -c --argjson v "$HOOK_JSON" '. + {verdict: $v}' <<< "$BASE_JSON"
  else
    echo "$BASE_JSON"
  fi
else
  echo "$BASE_JSON"
fi
exit 0
