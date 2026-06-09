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

# impl ファイルを untracked(新規) と tracked-modified に分類して退避する。
# untracked はコピーして削除、tracked-modified は git stash で退避する。
TMPDIR_IMPL="$(mktemp -d)"
UNTRACKED_IMPLS=()
TRACKED_IMPLS=()

for f in "${IMPLS[@]}"; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    TRACKED_IMPLS+=("$f")
  else
    UNTRACKED_IMPLS+=("$f")
  fi
done

STASH_CREATED=false
UNTRACKED_SAVED=false

# --- cleanup / restore trap ---
restore_impl() {
  local exit_code=$?
  # untracked impl を復元(相対パスを保持して退避したパスから戻す)
  if [ "$UNTRACKED_SAVED" = true ]; then
    for f in "${UNTRACKED_IMPLS[@]}"; do
      local dest_dir
      dest_dir="$(dirname "$f")"
      if [ -f "$TMPDIR_IMPL/$f" ]; then
        mkdir -p "$dest_dir"
        cp "$TMPDIR_IMPL/$f" "$f"
      fi
    done
  fi
  # stash を復元
  if [ "$STASH_CREATED" = true ]; then
    if ! git stash pop -q 2>/dev/null; then
      # pop 失敗 = conflict 等。stash が残存し worktree 不整合の恐れあり。
      echo "REDGREEN_FATAL: git stash pop failed; worktree may be inconsistent. Run 'git stash list' and recover manually." >&2
      # stash drop して続行不可の旨を知らせる
      git stash drop -q 2>/dev/null || true
    fi
  fi
  rm -rf "$TMPDIR_IMPL"
  # exit_code が 0 でない場合はそのまま伝播させる
  # (trap 内での return は元の exit を引き継ぐ)
}
trap restore_impl EXIT

# 1. untracked impl をコピーして削除
if [ "${#UNTRACKED_IMPLS[@]}" -gt 0 ]; then
  # 削除を開始する前に全 untracked impl の存在を検証する(部分削除による消失を防ぐ)
  for f in "${UNTRACKED_IMPLS[@]}"; do
    if [ ! -f "$f" ]; then
      echo "{\"red\":false,\"green\":false,\"reason\":\"impl file not found: $f\"}"; exit 2
    fi
  done
  # 全件存在を確認してから退避(相対パスを保持してコピー)
  for f in "${UNTRACKED_IMPLS[@]}"; do
    mkdir -p "$TMPDIR_IMPL/$(dirname "$f")"
    cp "$f" "$TMPDIR_IMPL/$f"
    rm -f "$f"
  done
  UNTRACKED_SAVED=true
fi

# 2. tracked-modified impl を stash で退避
if [ "${#TRACKED_IMPLS[@]}" -gt 0 ]; then
  if ! git stash push -q -- "${TRACKED_IMPLS[@]}" 2>/dev/null; then
    echo '{"red":false,"green":false,"reason":"stash push failed"}'; exit 2
  fi
  STASH_CREATED=true
fi

# red 判定(impl 退避中: test は落ちるべき)
if run_tests; then RED=false; else RED=true; fi

# --- restore は trap(EXIT) が担う ---
# ここで明示的に復元して green 判定のために残り処理を続ける。
# trap は EXIT 時に再び呼ばれるが、フラグをリセットして二重復元を防ぐ。

# tracked-modified を先に pop
if [ "$STASH_CREATED" = true ]; then
  if ! git stash pop -q 2>/dev/null; then
    # pop 失敗: stash drop + 強いエラーシグナルで abort
    echo "REDGREEN_FATAL: git stash pop failed after red phase; worktree may be inconsistent. Run 'git stash list'." >&2
    git stash drop -q 2>/dev/null || true
    STASH_CREATED=false  # trap での再試行を防ぐ
    echo "{\"red\":$RED,\"green\":false,\"reason\":\"stash pop failed: worktree inconsistent, impl may be lost\"}"; exit 2
  fi
  STASH_CREATED=false  # trap での二重 pop を防ぐ
fi

# untracked を復元(相対パスを保持して退避したパスから戻す)
if [ "$UNTRACKED_SAVED" = true ]; then
  for f in "${UNTRACKED_IMPLS[@]}"; do
    local_dest_dir="$(dirname "$f")"
    if [ -f "$TMPDIR_IMPL/$f" ]; then
      mkdir -p "$local_dest_dir"
      cp "$TMPDIR_IMPL/$f" "$f"
    fi
  done
  UNTRACKED_SAVED=false  # trap での二重復元を防ぐ
fi

# green 判定(復元後: test は通るべき)
if run_tests; then GREEN=true; else GREEN=false; fi

echo "{\"red\":$RED,\"green\":$GREEN,\"reason\":\"ok\"}"
exit 0
