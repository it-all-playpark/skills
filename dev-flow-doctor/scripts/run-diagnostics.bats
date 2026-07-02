#!/usr/bin/env bats
# Tests for dev-flow-doctor/scripts/run-diagnostics.sh
#
# Focus 1: run_worktree_checks の age_days 算出部分における
#          unset / 空 / 非数値セーフ対策の regression テスト。
# Focus 2: --scope の新語彙 (full|journal|worktrees|config|telemetry|feedback) と
#          checks.dev_flow_telemetry への配線（run_telemetry_checks）。
#          全 telemetry fixture は相対日付生成 (setup() 内)。

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/run-diagnostics.sh"

# ---------------------------------------------------------------------------
# 各テストで使う隔離 git repo + journal/config セットアップ
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

    # telemetry corpus 用の隔離 journal dir + 空 config（config leak 防止）
    CLAUDE_JOURNAL_DIR="$BATS_TMPDIR/journal-$$-${BATS_TEST_NUMBER:-0}-$RANDOM"
    mkdir -p "$CLAUDE_JOURNAL_DIR"
    export CLAUDE_JOURNAL_DIR

    SKILL_CONFIG_PATH="$BATS_TMPDIR/cfg-$$-${BATS_TEST_NUMBER:-0}-$RANDOM.json"
    echo '{}' > "$SKILL_CONFIG_PATH"
    export SKILL_CONFIG_PATH

    # 1 日前の相対タイムスタンプ (macOS -v / GNU -d 両対応)
    TS="$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)"
}

teardown() {
    rm -rf "${REPO:-}" "${FAKE_BIN:-}"
    # WORKTREE_BASE は REPO の兄弟ディレクトリなので個別に削除
    rm -rf "${WORKTREE_BASE:-}"
    rm -rf "${CLAUDE_JOURNAL_DIR:-}"
    rm -f "${SKILL_CONFIG_PATH:-}"
}

# Write one dev-flow journal entry with the given telemetry JSON object.
# $1 = filename, $2 = telemetry JSON (compact), $3 = optional id override
write_devflow_entry() {
    local fname="$1" telemetry="$2" id="${3:-$RANDOM}"
    cat > "${CLAUDE_JOURNAL_DIR}/${fname}" <<EOF
{
  "version": "1.0.0",
  "id": "devflow-${id}",
  "timestamp": "${TS}",
  "skill": "dev-flow",
  "outcome": "success",
  "source": "skill",
  "telemetry": ${telemetry}
}
EOF
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
# (4) --scope full が telemetry corpus を実際に読み込むこと
#
# 単なる exit 0 ではなく、corpus が analyze-dev-flow-telemetry.sh を通じて
# 実際に集計されたことを non-vacuous に検証する:
#   - .checks.dev_flow_telemetry.status が "error"/"skipped" でないこと
#   - .checks.dev_flow_telemetry.total_dev_flow_runs が corpus 件数と一致すること
#   - distributions が集計されていること
# ---------------------------------------------------------------------------
@test "(4) telemetry corpus: --scope full で dev_flow_telemetry が実集計されること" {
    local i
    for i in $(seq 1 4); do
        write_devflow_entry "e${i}.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1}' "$i"
    done

    run bash -c "cd '${REPO}' && CLAUDE_JOURNAL_DIR='${CLAUDE_JOURNAL_DIR}' SKILL_CONFIG_PATH='${SKILL_CONFIG_PATH}' '${SCRIPT}' --scope full --window 30d"
    [ "$status" -eq 0 ]

    # valid JSON であること
    printf '%s\n' "$output" | jq empty

    # score / checks キーが存在すること
    printf '%s\n' "$output" | jq -e 'has("score")'
    printf '%s\n' "$output" | jq -e 'has("checks")'

    # dev_flow_telemetry が error / skipped でないこと（corpus が実際に読まれたこと）
    local dft_status
    dft_status=$(printf '%s\n' "$output" | jq -r '.checks.dev_flow_telemetry.status // "missing"')
    [ "$dft_status" != "error" ]
    [ "$dft_status" != "skipped" ]

    # corpus の件数が集計されたこと
    local total
    total=$(printf '%s\n' "$output" | jq '.checks.dev_flow_telemetry.total_dev_flow_runs // 0')
    [ "$total" -eq 4 ]

    # distributions が実際に集計されていること（standard 4 件）
    local standard
    standard=$(printf '%s\n' "$output" | jq '.checks.dev_flow_telemetry.distributions.shape.standard // 0')
    [ "$standard" -eq 4 ]
}

# ---------------------------------------------------------------------------
# (5) --scope telemetry が受理され、旧 --scope family は die すること
# ---------------------------------------------------------------------------
@test "(5) --scope telemetry accepted / --scope family rejected" {
    run bash -c "cd '${REPO}' && CLAUDE_JOURNAL_DIR='${CLAUDE_JOURNAL_DIR}' SKILL_CONFIG_PATH='${SKILL_CONFIG_PATH}' '${SCRIPT}' --scope telemetry --window 30d"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty
    scope=$(printf '%s\n' "$output" | jq -r '.scope')
    [ "$scope" = "telemetry" ]

    run bash -c "cd '${REPO}' && '${SCRIPT}' --scope family"
    [ "$status" -ne 0 ]
    printf '%s\n' "$output" | grep -qi "Invalid scope"
}

# ---------------------------------------------------------------------------
# (6) AC2: eval_iter=10 (cap) corpus -> issues[] に cap張り付き warn が出る
# ---------------------------------------------------------------------------
@test "(6) AC2: eval_iter=10 corpus -> issues に cap張り付き warn" {
    write_devflow_entry "e1.json" '{"shape":"complex","merge_tier":"REVIEW","plan_iter":2,"eval_iter":10}' 1

    run bash -c "cd '${REPO}' && CLAUDE_JOURNAL_DIR='${CLAUDE_JOURNAL_DIR}' SKILL_CONFIG_PATH='${SKILL_CONFIG_PATH}' '${SCRIPT}' --scope telemetry --window 30d"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    local found
    found=$(printf '%s\n' "$output" | jq '[.issues[] | select(.severity=="warn" and (.message | test("Cap")))] | length')
    [ "$found" -ge 1 ]

    # checks 側にも anomaly が反映されていること
    local anomaly_found
    anomaly_found=$(printf '%s\n' "$output" | jq '[.checks.dev_flow_telemetry.anomalies[] | select(.type=="cap_pinned" and .severity=="warn")] | length')
    [ "$anomaly_found" -ge 1 ]
}

# ---------------------------------------------------------------------------
# (7) AC3: micro 0件・run>=10 corpus -> issues[] に micro不発火 warn
# ---------------------------------------------------------------------------
@test "(7) AC3: micro 0件・run>=10 corpus -> issues に micro不発火 warn" {
    local i
    for i in $(seq 1 6); do
        write_devflow_entry "standard-${i}.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1}' "s${i}"
    done
    for i in $(seq 1 5); do
        write_devflow_entry "complex-${i}.json" '{"shape":"complex","merge_tier":"HOLD","plan_iter":2,"eval_iter":2}' "c${i}"
    done

    run bash -c "cd '${REPO}' && CLAUDE_JOURNAL_DIR='${CLAUDE_JOURNAL_DIR}' SKILL_CONFIG_PATH='${SKILL_CONFIG_PATH}' '${SCRIPT}' --scope telemetry --window 30d"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    local found
    found=$(printf '%s\n' "$output" | jq '[.issues[] | select(.severity=="warn" and (.message | test("micro")))] | length')
    [ "$found" -ge 1 ]
}

# ---------------------------------------------------------------------------
# (8) AC3: run<10 corpus -> micro不発火は severity=skipped で明示され、warn は出ない
# ---------------------------------------------------------------------------
@test "(8) AC3: run<10 corpus -> micro不発火 skipped（判定skipが明示される）" {
    local i
    for i in $(seq 1 5); do
        write_devflow_entry "standard-${i}.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1}' "s${i}"
    done

    run bash -c "cd '${REPO}' && CLAUDE_JOURNAL_DIR='${CLAUDE_JOURNAL_DIR}' SKILL_CONFIG_PATH='${SKILL_CONFIG_PATH}' '${SCRIPT}' --scope telemetry --window 30d"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    local severity
    severity=$(printf '%s\n' "$output" | jq -r '[.checks.dev_flow_telemetry.anomalies[] | select(.type=="micro_nonfiring")][0].severity')
    [ "$severity" = "skipped" ]

    local warn_found
    warn_found=$(printf '%s\n' "$output" | jq '[.issues[] | select(.severity=="warn" and (.message | test("micro")))] | length')
    [ "$warn_found" -eq 0 ]
}

# ---------------------------------------------------------------------------
# (9) 旧 Check 9 (termination_loops) / Check 1 (mode_distribution) が
#     checks から消えていること
# ---------------------------------------------------------------------------
@test "(9) checks から termination_loops / mode_distribution キーが消えている" {
    write_devflow_entry "e1.json" '{"shape":"standard","merge_tier":"REVIEW","plan_iter":1,"eval_iter":1}' 1

    run bash -c "cd '${REPO}' && CLAUDE_JOURNAL_DIR='${CLAUDE_JOURNAL_DIR}' SKILL_CONFIG_PATH='${SKILL_CONFIG_PATH}' '${SCRIPT}' --scope full --window 30d"
    [ "$status" -eq 0 ]
    printf '%s\n' "$output" | jq empty

    local has_term has_mode_dist has_family
    has_term=$(printf '%s\n' "$output" | jq '.checks | has("termination_loops")')
    [ "$has_term" = "false" ]

    has_mode_dist=$(printf '%s\n' "$output" | jq '.checks.journal | has("mode_distribution")')
    [ "$has_mode_dist" = "false" ]

    has_family=$(printf '%s\n' "$output" | jq '.checks | has("dev_flow_family")')
    [ "$has_family" = "false" ]
}

# ---------------------------------------------------------------------------
# (10) AC6: run-diagnostics.sh 単体に旧語彙 (family_skills/旧skill名/
#      context.mode/termination) が残っていないこと
# ---------------------------------------------------------------------------
@test "(10) AC6: run-diagnostics.sh に旧語彙が grep 0 件であること" {
    run bash -c "grep -Ei 'family_skills|dev-kickoff|dev-implement|dev-validate|dev-integrate|dev-evaluate|night-patrol|context\\.mode|termination' '${SCRIPT}'"
    [ "$status" -ne 0 ]
}
