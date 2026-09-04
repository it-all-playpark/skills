#!/usr/bin/env bash
# PreToolUse(Bash) hook: git commit 前に inline 同期(sync-inlines --check)を強制する
#
# 目的:
#   .claude/workflows/*.js 等の生成物(_lib/ canonical から node tools/sync-inlines.mjs
#   --write で再生成される inline ブロック)が、canonical 側の変更に追随しないまま
#   commit されることを fail-closed に防ぐ。commit 対象リポジトリに
#   tools/sync-inlines.mjs が存在する場合のみ --check を強制する。
#
# 判定フロー:
#   1. tool_name が Bash 以外、または tool_input.command が空なら無出力 exit 0
#      （非対象は必ず何も出力せず通常の permission flow に委ねる）
#   2. command 文字列を &&, ||, ;, |, 改行 で segment 分割し、各 segment を
#      read -ra でトークン化する
#   3. 先頭トークンが "git" の segment について、allow-feature-push.sh の
#      グローバルオプション token-walk と同じロジック(-C/--git-dir/--work-tree
#      は値ごと GLOBAL_LOCATION_ARGS に収集、-c 等の値取りグローバルオプション
#      はスキップ、最初の非オプショントークンをサブコマンドとして確定)で
#      サブコマンドが commit かどうかを判定する
#   4. commit segment より前に単純形 `cd <単一トークン>` の segment があれば、
#      その dir(引用符は外す)を root 解決の基準 cwd として追跡する
#      (subshell / pushd 等の複雑な cwd 変更には追随しない)
#   5. commit 検出時、基準 cwd を解決する: cd 追跡値(CD_DIR)があれば、それを
#      hook 起動時の cwd(HOOK_CWD, = tool_input の `.cwd`)基準で解決した絶対
#      パスを使う(`cd "$HOOK_CWD" && cd "$CD_DIR"`)。CD_DIR が無ければ
#      HOOK_CWD をそのまま使う。hook プロセス自身の `$PWD` はセッションの
#      cwd と乖離しうるため基準にしない。解決した基準 cwd から
#      `git [GLOBAL_LOCATION_ARGS] rev-parse --show-toplevel` で repo root
#      を解決する。解決できなければ(git repo 外 / cd 先が存在しない)対象外
#      として次の segment へ進む
#   6. repo root に tools/sync-inlines.mjs が存在しなければ他 repo とみなし
#      対象外(次の segment へ)
#   7. 存在すれば (cd root && node tools/sync-inlines.mjs --check) を実行する。
#      exit 0 なら pass-through(次の segment へ)。非 0 なら即座に deny を出力
#      して exit 0(hook 自体は正常終了させ、permissionDecision=deny で
#      Claude Code 側に commit を止めさせる)
#
# fail-closed 方針:
#   --check が失敗する理由(未同期 diff がある / node が PATH に無い / スクリプト
#   自体がクラッシュする、等)を問わず deny する。原因を安全側に倒して切り分けず、
#   常に「再生成してから commit し直す」ことを促す。
#
# 既知の限界:
#   - segment 分割は naive な文字列分割であり、シェルの引用符/ヒアドキュメントを
#     厳密には解釈しない。例えば `echo "foo; git commit"` は文字列リテラル内の
#     `git commit` を誤って commit segment として抽出しうる(偽陽性)。ただし
#     この場合も判定結果は「対象 repo の inline が同期済みかどうか」でしかなく、
#     同期済みなら pass-through、未同期なら安全側に deny されるだけで実害はない。
#   - cd 追跡は `cd <単一トークン>` の単純形のみ対象。`(cd x && ...)` の
#     subshell や pushd/popd/ディレクトリスタック操作には対応しない。

set -euo pipefail

INPUT=$(cat)

TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
if [[ $TOOL != "Bash" ]]; then
  exit 0
fi

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if [[ -z $CMD ]]; then
  exit 0
fi

HOOK_CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
if [[ -z $HOOK_CWD ]]; then
  HOOK_CWD="$PWD"
fi

deny() {
  local reason="$1"
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# 前後の空白を除去する(外部コマンドを使わない純 bash trim)
trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# 単純な "dir" / 'dir' 囲みの引用符を1組だけ除去する
strip_quotes() {
  local s="$1"
  if [[ ${s:0:1} == '"' && ${s: -1} == '"' && ${#s} -ge 2 ]]; then
    s="${s:1:-1}"
  elif [[ ${s:0:1} == "'" && ${s: -1} == "'" && ${#s} -ge 2 ]]; then
    s="${s:1:-1}"
  fi
  printf '%s' "$s"
}

# detect_git_subcommand <token...>
# allow-feature-push.sh のグローバルオプション token-walk と同じロジックで
# git サブコマンドを確定する。結果は以下のグローバル変数に格納する:
#   SUBCOMMAND             確定したサブコマンド(git 以外の segment なら空文字)
#   SEG_GLOBAL_LOCATION_ARGS  -C / --git-dir / --work-tree の値付きトークン列
detect_git_subcommand() {
  SUBCOMMAND=""
  SEG_GLOBAL_LOCATION_ARGS=()
  local tokens=("$@")
  if [[ ${tokens[0]:-} != "git" ]]; then
    return
  fi

  local skip_global_next=0 skip_location_next=0
  local i tok
  for ((i = 1; i < ${#tokens[@]}; i++)); do
    tok="${tokens[$i]}"
    if [[ $skip_location_next == 1 ]]; then
      skip_location_next=0
      SEG_GLOBAL_LOCATION_ARGS+=("$tok")
      continue
    fi
    if [[ $skip_global_next == 1 ]]; then
      skip_global_next=0
      continue
    fi
    case "$tok" in
    -C | --git-dir | --work-tree)
      SEG_GLOBAL_LOCATION_ARGS+=("$tok")
      skip_location_next=1
      continue
      ;;
    --git-dir=* | --work-tree=*)
      SEG_GLOBAL_LOCATION_ARGS+=("$tok")
      continue
      ;;
    -c | --namespace | --exec-path | --config-env | --super-prefix | --attr-source)
      skip_global_next=1
      continue
      ;;
    --namespace=* | --exec-path=* | --config-env=* | --attr-source=*)
      continue
      ;;
    -*)
      continue
      ;;
    *)
      SUBCOMMAND="$tok"
      return
      ;;
    esac
  done
}

# --- command 文字列を &&, ||, ;, |, 改行 で segment 分割する ---
SPLIT=$(printf '%s' "$CMD" | sed -E 's/(&&|\|\||;|\|)/\n/g')
mapfile -t SEGMENTS <<<"$SPLIT"

CD_DIR=""

for raw_seg in "${SEGMENTS[@]}"; do
  seg="$(trim "$raw_seg")"
  [[ -z $seg ]] && continue

  read -ra TOKENS <<<"$seg"
  [[ ${#TOKENS[@]} -eq 0 ]] && continue

  # 単純形 `cd <単一トークン>` の追跡(commit segment より前のものだけが意味を持つ)
  if [[ ${TOKENS[0]} == "cd" && ${#TOKENS[@]} -eq 2 ]]; then
    CD_DIR="$(strip_quotes "${TOKENS[1]}")"
    continue
  fi

  detect_git_subcommand "${TOKENS[@]}"
  if [[ $SUBCOMMAND != "commit" ]]; then
    continue
  fi

  # --- commit 検出: repo root を解決する ---
  # CD_DIR(cd 追跡値)は絶対パスとは限らない。hook プロセス自身の $PWD ではなく
  # 常に HOOK_CWD(tool_input の `.cwd`)基準で解決する。CD_DIR が絶対パスの
  # 場合も `cd "$HOOK_CWD" && cd "$CD_DIR"` は最終的に CD_DIR そのものへ
  # 移動するだけなので挙動は変わらない。
  if [[ -n $CD_DIR ]]; then
    BASE_CWD=$(cd "$HOOK_CWD" 2>/dev/null && cd "$CD_DIR" 2>/dev/null && pwd) || true
  else
    BASE_CWD="$HOOK_CWD"
  fi

  if [[ -z $BASE_CWD ]]; then
    # HOOK_CWD 基準でも cd 先が解決できない(存在しない dir 等) — commit
    # 自体が失敗するため、このガードで塞ぐ必要はない
    continue
  fi

  if [[ ${#SEG_GLOBAL_LOCATION_ARGS[@]} -gt 0 ]]; then
    ROOT=$(cd "$BASE_CWD" 2>/dev/null && git "${SEG_GLOBAL_LOCATION_ARGS[@]}" rev-parse --show-toplevel 2>/dev/null) || true
  else
    ROOT=$(cd "$BASE_CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || true
  fi

  if [[ -z $ROOT ]]; then
    # git repo 外(または cd 追跡先が存在しない) — commit 自体が git 側で
    # 失敗するため、このガードで塞ぐ必要はない
    continue
  fi

  SYNC_SCRIPT="$ROOT/tools/sync-inlines.mjs"
  if [[ ! -f $SYNC_SCRIPT ]]; then
    # sync-inlines.mjs を持たない repo は無関係(dotfiles 自身を含む大半の repo)
    continue
  fi

  if ! OUT=$(cd "$ROOT" && node tools/sync-inlines.mjs --check 2>&1); then
    TAIL=$(printf '%s\n' "$OUT" | tail -n 5)
    deny "inline 同期が未達（sync-inlines --check 非0）。_lib/ canonical を編集した場合は node tools/sync-inlines.mjs --write で再生成してから commit せよ。
${TAIL}"
  fi
done

exit 0
