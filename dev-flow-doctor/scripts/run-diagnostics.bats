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
# setup_file: AC1 smoke テスト用 journal corpus（3,600 エントリ）を生成
# ---------------------------------------------------------------------------
setup_file() {
    CORPUS_DIR="$(mktemp -d)"
    export CORPUS_DIR
    # 3,600 件の journal corpus を生成（basename ~240文字 padding 付き）
    local pad
    pad=$(printf '%0.s-' {1..200})  # 200文字のパディング
    for i in $(seq 1 3600); do
        local ts
        ts=$(printf '%010d' "$i")
        # skill=dev-flow の JSON lines 形式
        printf '{"ts":"%s","skill":"dev-flow","status":"success","mode":"standard","padding":"%s"}\n' \
            "$ts" "$pad" >> "${CORPUS_DIR}/journal-${ts}.jsonl"
    done
    export CORPUS_DIR
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
# (4) AC1 smoke: 3,600 件 journal corpus で full 実行が status 0 かつ valid JSON
# ---------------------------------------------------------------------------
@test "(4) AC1 smoke: 3600件corpus で --scope full が status 0 かつ valid JSON（score/checks キー存在）" {
    # 空の config を用意（SKILL_CONFIG_PATH を環境変数で指定）
    local empty_config
    empty_config="$(mktemp)"
    printf '{}' > "$empty_config"

    run bash -c "cd '${REPO}' && CLAUDE_JOURNAL_DIR='${CORPUS_DIR}' SKILL_CONFIG_PATH='${empty_config}' '${SCRIPT}' --scope full --window 30d"
    rm -f "$empty_config"
    [ "$status" -eq 0 ]
    # valid JSON
    printf '%s\n' "$output" | jq empty
    # score キーが存在
    printf '%s\n' "$output" | jq -e 'has("score")'
    # checks キーが存在
    printf '%s\n' "$output" | jq -e 'has("checks")'
}
