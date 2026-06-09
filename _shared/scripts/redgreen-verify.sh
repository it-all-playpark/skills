#!/usr/bin/env bash
# red→green 実証: 実装だけ stash で base に戻し、test が red→green に転じるか決定論判定する。
# 使い方: redgreen-verify.sh <worktree> <test_files_csv> <impl_files_csv>
# 出力(stdout, JSON 1行): {"red":bool,"green":bool,"reason":"..."}
# exit 0 = 判定完了(red/green は JSON 参照) / exit 2 = 入力・分離エラー(= deterministic 昇格しないこと)
set -uo pipefail

WT="${1:?worktree required}"
TEST_CSV="${2:?test_files required}"
IMPL_CSV="${3:?impl_files required}"

cd "$WT" 2>/dev/null || { echo '{"red":false,"green":false,"reason":"cd failed"}'; exit 2; }

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
  if [ "${#node_tests[@]}" -gt 0 ]; then node --test "${node_tests[@]}" >/dev/null 2>&1 || rc=1; fi
  if [ "${#bats_tests[@]}" -gt 0 ]; then bats "${bats_tests[@]}" >/dev/null 2>&1 || rc=1; fi
  return $rc
}

# impl だけ stash(test は worktree に残す)
if ! git stash push -q -- "${IMPLS[@]}" 2>/dev/null; then
  echo '{"red":false,"green":false,"reason":"stash push failed"}'; exit 2
fi
# red 判定(impl 退避中: test は落ちるべき)
if run_tests; then RED=false; else RED=true; fi
# 復元
if ! git stash pop -q 2>/dev/null; then
  echo "{\"red\":$RED,\"green\":false,\"reason\":\"stash pop failed\"}"; exit 2
fi
# green 判定(復元後: test は通るべき)
if run_tests; then GREEN=true; else GREEN=false; fi

echo "{\"red\":$RED,\"green\":$GREEN,\"reason\":\"ok\"}"
exit 0
