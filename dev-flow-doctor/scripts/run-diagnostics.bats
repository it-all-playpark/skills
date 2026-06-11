#!/usr/bin/env bats
# Tests for dev-flow-doctor/scripts/run-diagnostics.sh
#
# Focus: run_worktree_checks の age_days 算出部分における
#        unset / 空 / 非数値セーフ対策の regression テスト。
#
# Setup: mktemp -d に隔離 git repo（git init + user config + empty commit）を作り、
#        その親に `<repo名>-worktrees/` ディレクトリを用意。
#        スクリプトは `cd <repo> && run-diagnostics.sh --scope worktrees` で実行。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/run-diagnostics.sh"

# ---------------------------------------------------------------------------
# setup_file: smoke テスト用 journal corpus（3,600 エントリ）を生成
#
# ファイル形式: *.json（analyze-dev-flow-family.sh / journal.sh が glob する拡張子）
# JSON schema: 実 schema に準拠（timestamp / skill / outcome / source / duration_turns）
# skill: "pr-fix"（DEFAULT_FAMILY_SKILLS に含まれる family skill）
# timestamp: 今日の UTC 日付（--window 30d フィルタを通過させるため）
# ---------------------------------------------------------------------------
setup_file() {
    CORPUS_DIR="$(mktemp -d)"
    export CORPUS_DIR

    # 今日の UTC 日付（--window 30d のフィルタを通過するタイムスタンプ）
    TODAY_ISO="$(date -u +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u --iso-8601=seconds | sed 's/+.*/Z/')"
    export TODAY_ISO

    # 3,600 件のエントリを個別の *.json ファイルとして生成
    local i
    for i in $(seq 1 3600); do
        printf '{"id":"c-%d","timestamp":"%s","skill":"pr-fix","outcome":"success","source":"skill","duration_turns":3}\n' \
            "$i" "$TODAY_ISO" > "${CORPUS_DIR}/corpus-$(printf '%04d' "$i")-pr-fix.json"
    done
}

teardown_file() {
    rm -rf "${CORPUS_DIR:-}"
}

# ---------------------------------------------------------------------------
# 各テストで使う隔離 git repo セットアップ
# ---------------------------------------------------------------------------
setup() {
    REPO="$(mktemp -d)"
    export REPO
    git -C "$REPO" init -q
    git -C "$REPO" config user.email t@t
    git -C "$REPO" config user.name t
    git -C "$REPO" commit -q --allow-empty -m base

    REPO_NAME="$(basename "$REPO")"
    WORKTREE_BASE="${REPO}/../${REPO_NAME}-worktrees"
    mkdir -p "$WORKTREE_BASE"
    export WORKTREE_BASE

    # 各テストで fake stat を置く用の bin dir
    FAKE_BIN="$(mktemp -d)"
    export FAKE_BIN
}

teardown() {
    rm -rf "${REPO:-}" "${FAKE_BIN:-}"
    # WORKTREE_BASE は REPO の兄弟ディレクトリなので個別に削除
    rm -rf "${WORKTREE_BASE:-}"
}

# ---------------------------------------------------------------------------
# (1) stat 非数値出力 regression
#     fake stat が "ERR" という文字列を出力するケースで死なないこと
# ---------------------------------------------------------------------------
@test "(1) stat 非数値出力: status 0 かつ valid JSON を返す（旧実装は算術展開で死ぬ）" {
    # fake stat shim: 非数値 "ERR" を stdout に出力して exit 0
    printf '#!/bin/sh\nprintf "ERR"\nexit 0\n' > "${FAKE_BIN}/stat"
    chmod +x "${FAKE_BIN}/stat"

    # ダミー worktree dir
    mkdir -p "${WORKTREE_BASE}/dummy-wt"

    run bash -c "cd '${REPO}' && PATH='${FAKE_BIN}:${PATH}' '${SCRIPT}' --scope worktrees"
    [ "$status" -eq 0 ]
    # valid JSON であること（jq がパースできること）
    printf '%s\n' "$output" | jq empty
}

# ---------------------------------------------------------------------------
# (2) stat 空出力 regression
#     fake stat が空文字を出力するケースで stale_worktrees が 0 になること
#     （旧実装: 空 → mod_time=0 → age_days≈20000日 → false-positive stale）
# ---------------------------------------------------------------------------
@test "(2) stat 空出力: stale_worktrees == 0 で false-positive stale を出さない" {
    # fake stat shim: 空文字を出力して exit 0
    printf '#!/bin/sh\nprintf ""\nexit 0\n' > "${FAKE_BIN}/stat"
    chmod +x "${FAKE_BIN}/stat"

    # ダミー worktree dir
    mkdir -p "${WORKTREE_BASE}/dummy-wt"

    run bash -c "cd '${REPO}' && PATH='${FAKE_BIN}:${PATH}' '${SCRIPT}' --scope worktrees"
    [ "$status" -eq 0 ]
    # valid JSON であること
    printf '%s\n' "$output" | jq empty
    # stale_worktrees == 0 であること（timestamp 取得不能 → stale 扱いしない）
    local stale
    stale=$(printf '%s\n' "$output" | jq '.checks.worktree_health.stale_worktrees')
    [ "$stale" -eq 0 ]
}

# ---------------------------------------------------------------------------
# (3) 正常系
#     fake stat なし・新しい worktree dir で stale_worktrees 0、
#     registered_worktrees >= 1 を確認
# ---------------------------------------------------------------------------
@test "(3) 正常系: status 0、stale_worktrees 0、registered_worktrees >= 1" {
    # ダミー worktree dir（最近作成されたのでstaleでない）
    mkdir -p "${WORKTREE_BASE}/recent-wt"

    run bash -c "cd '${REPO}' && '${SCRIPT}' --scope worktrees"
    [ "$status" -eq 0 ]
    # valid JSON であること
    printf '%s\n' "$output" | jq empty
    # stale_worktrees == 0 であること
    local stale
    stale=$(printf '%s\n' "$output" | jq '.checks.worktree_health.stale_worktrees')
    [ "$stale" -eq 0 ]
    # registered_worktrees >= 1 であること（git worktree list は少なくとも main を返す）
    local reg
    reg=$(printf '%s\n' "$output" | jq '.checks.worktree_health.registered_worktrees')
    [ "$reg" -ge 1 ]
}

# ---------------------------------------------------------------------------
# (4) 3,600 件 journal corpus で --scope full が corpus を実際に読み込むこと
#
# 単なる exit 0 ではなく、corpus が analyze-dev-flow-family.sh を通じて
# 実際に集計されたことを non-vacuous に検証する:
#   - .checks.dev_flow_family.status が "error"/"skipped" でないこと
#   - .checks.dev_flow_family.per_skill 内の pr-fix エントリの total が 3600 であること
# ---------------------------------------------------------------------------
@test "(4) 3600件corpus: --scope full で pr-fix total==3600 が集計されること（corpus が実際に流れる）" {
    local empty_config
    empty_config="$(mktemp)"
    printf '{}' > "$empty_config"

    run bash -c "cd '${REPO}' && CLAUDE_JOURNAL_DIR='${CORPUS_DIR}' SKILL_CONFIG_PATH='${empty_config}' '${SCRIPT}' --scope full --window 30d"
    rm -f "$empty_config"
    [ "$status" -eq 0 ]

    # valid JSON であること
    printf '%s\n' "$output" | jq empty

    # score / checks キーが存在すること
    printf '%s\n' "$output" | jq -e 'has("score")'
    printf '%s\n' "$output" | jq -e 'has("checks")'

    # dev_flow_family が error / skipped でないこと（corpus が実際に読まれたこと）
    local dff_status
    dff_status=$(printf '%s\n' "$output" | jq -r '.checks.dev_flow_family.status // "missing"')
    [ "$dff_status" != "error" ]
    [ "$dff_status" != "skipped" ]

    # pr-fix の total が 3600 であること（corpus が集計されたことの非自明な確認）
    local pr_fix_total
    pr_fix_total=$(printf '%s\n' "$output" | jq '[.checks.dev_flow_family.per_skill[] | select(.skill=="pr-fix")][0].total // 0')
    [ "$pr_fix_total" -eq 3600 ]
}
