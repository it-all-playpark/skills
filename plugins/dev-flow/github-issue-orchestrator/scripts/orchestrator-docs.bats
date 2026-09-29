#!/usr/bin/env bats
# Static pins for github-issue-orchestrator docs ↔ create_issue.py (issue #744)
#
# - human 判定基準と `executor: human` マーカーが SKILL.md と references/issue-template.md で一致する
# - devils-advocate-checklist.md の Blocking Categories に人手作業混入の 2 項目がある
# - SKILL.md Phase 6 が human issue（--kind human）→ 実装 issue（--blocked-by）の順で、Output Contract に
#   human issue と依存関係が含まれる
# - template の 2 つの本文雛形が create_issue.py の --kind agent / --kind human ゲートを通る

setup() {
    command -v python3 >/dev/null || skip "python3 not available"

    SKILL_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
    SKILL_MD="$SKILL_DIR/SKILL.md"
    TEMPLATE="$SKILL_DIR/references/issue-template.md"
    CHECKLIST="$SKILL_DIR/references/devils-advocate-checklist.md"
    SCRIPT="$SKILL_DIR/scripts/create_issue.py"
}

# human 判定基準の番号付きリスト（見出し行の直後のリスト）を抜き出す
extract_criteria() {
    awk '/human 判定基準/ { f = 1; next }
         f && /^[0-9]+\. / { print; seen = 1; next }
         f && seen { exit }' "$1"
}

# <start-regex> 以降で最初の ```markdown フェンスの中身を抜き出す
extract_fence() {
    awk -v start="$2" '$0 ~ start { f = 1 }
         f && !in_fence && /^```markdown$/ { in_fence = 1; next }
         in_fence && /^```$/ { exit }
         in_fence { print }' "$1"
}

# SKILL.md の `### <name>` / `## <name>` 節を次の `##` / `###` 見出しまで抜き出す（コードフェンス内の見出しは無視）
extract_section() {
    awk -v h="$2" 'index($0, h) == 1 { f = 1; print; next }
         f && /^```/ { in_fence = !in_fence }
         f && !in_fence && /^##+ / && !/^####/ { exit }
         f { print }' "$1"
}

@test "(1) human 判定基準が SKILL.md と issue-template.md で一致し、6 項目ある" {
    skill="$(extract_criteria "$SKILL_MD")"
    template="$(extract_criteria "$TEMPLATE")"
    [ -n "$skill" ]
    [ "$skill" = "$template" ]
    [ "$(printf '%s\n' "$skill" | wc -l | tr -d ' ')" -eq 6 ]
    for item in "外部サービスの管理画面操作・アカウント作成" "secret・API キーの発行と登録" "DNS・課金・契約" \
        "顧客への確認・承認" "本番データの手作業操作" "実機での手動確認"; do
        [[ "$skill" == *"$item"* ]]
    done
}

@test "(2) マーカー文字列 executor: human / executor: agent が SKILL.md と issue-template.md の両方にある" {
    for f in "$SKILL_MD" "$TEMPLATE"; do
        grep -q '`executor: human`' "$f"
        grep -q 'executor: agent' "$f"
    done
    # create_issue.py のゲートは同じ固定文字列を正規表現で判定する
    grep -q 'HUMAN_MARKER_RE = re.compile(r"executor:\[ \\t\]\*human\\b")' "$SCRIPT"
}

@test "(3) devils-advocate-checklist の Blocking Categories に人手作業混入の 2 項目がある" {
    section="$(awk '/^## Blocking Categories/ { f = 1; next } f && /^## / { exit } f { print }' "$CHECKLIST")"
    [[ "$section" == *'agent issue に `executor: human` タスクが残存'* ]]
    [[ "$section" == *"human タスクに完了確認方法が無い"* ]]
}

@test "(4) SKILL.md Phase 6 は human issue（--kind human）→ 実装 issue（--blocked-by）の順で起票する" {
    phase6="$(extract_section "$SKILL_MD" "### Phase 6")"
    human_line="$(printf '%s\n' "$phase6" | grep -n -- '--kind human' | head -1 | cut -d: -f1)"
    blocked_line="$(printf '%s\n' "$phase6" | grep -n -- '--blocked-by' | head -1 | cut -d: -f1)"
    [ -n "$human_line" ] && [ -n "$blocked_line" ]
    [ "$human_line" -lt "$blocked_line" ]
    [[ "$phase6" == *"human issue を先に起票する"* ]]
}

@test "(5) Output Contract に human issue と Blocked by 関係が含まれる" {
    contract="$(extract_section "$SKILL_MD" "## Output Contract")"
    [[ "$contract" == *"## Human Tasks"* ]]
    [[ "$contract" == *"human issue:"* ]]
    [[ "$contract" == *"Blocked by"* ]]
}

@test "(6) 実装 issue テンプレートは create_issue.py --kind agent を通る" {
    BODY="$BATS_TEST_TMPDIR/agent.md"
    extract_fence "$TEMPLATE" "^# GitHub Issue Template" >"$BODY"
    grep -q '^## 受け入れ基準' "$BODY"

    run python3 "$SCRIPT" --kind agent --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 0 ]
}

@test "(7) human issue テンプレートは create_issue.py --kind human を通る" {
    BODY="$BATS_TEST_TMPDIR/human.md"
    extract_fence "$TEMPLATE" "^## human issue テンプレート" >"$BODY"
    grep -q '^## 手順' "$BODY"

    run python3 "$SCRIPT" --kind human --title "Test" --body-file "$BODY" --dry-run

    [ "$status" -eq 0 ]
    [[ "$output" == *"--label human-task"* ]]
}
