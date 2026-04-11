#!/usr/bin/env bash
# Integration tests for integration-feedback event store (issue #52).
# Exercises:
#   - _shared/scripts/integration-event-append.sh
#   - _shared/scripts/integration-event-read.sh
#   - dev-decompose/scripts/analyze-past-conflicts.sh
#
# Run: bash tests/_shared/test-integration-feedback.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APPEND_SH="$REPO_ROOT/_shared/scripts/integration-event-append.sh"
READ_SH="$REPO_ROOT/_shared/scripts/integration-event-read.sh"
ANALYZE_SH="$REPO_ROOT/dev-decompose/scripts/analyze-past-conflicts.sh"

command -v jq >/dev/null || { echo "jq required"; exit 1; }

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; echo "  $2"; }

TMP_ROOT=$(mktemp -d)
cleanup() {
    # Use a for loop to avoid shell `rm -rf` aliasing (some setups map rm to rip)
    find "$TMP_ROOT" -type f -delete 2>/dev/null || true
    find "$TMP_ROOT" -type d -empty -delete 2>/dev/null || true
    find "$TMP_ROOT" -depth -type d -delete 2>/dev/null || true
}
trap cleanup EXIT

# ---------- Test 1: append-basic ----------
T=$TMP_ROOT/t1; mkdir -p "$T"; FB=$T/fb.json
OUT=$("$APPEND_SH" --feedback-file "$FB" --source-issue 42 \
    --event-type conflict --files "src/types/user.ts,src/api/auth.ts" \
    --subtask-pair "task1,task2" --resolution unresolved --lesson "types grouping")
ID=$(echo "$OUT" | jq -r '.event_id')
if [[ "$ID" == "ev_001" ]] && [[ "$(jq '.events | length' "$FB")" == "1" ]]; then
    pass "append-basic"
else
    fail "append-basic" "got id=$ID, len=$(jq '.events | length' "$FB")"
fi

# ---------- Test 2: append-increments-id ----------
"$APPEND_SH" --feedback-file "$FB" --source-issue 42 --event-type conflict --files "src/routes/auth.ts" >/dev/null
OUT2=$("$APPEND_SH" --feedback-file "$FB" --source-issue 43 --event-type conflict --files "src/routes/api.ts")
ID2=$(echo "$OUT2" | jq -r '.event_id')
if [[ "$ID2" == "ev_003" ]]; then
    pass "append-increments-id"
else
    fail "append-increments-id" "expected ev_003, got $ID2"
fi

# ---------- Test 3: initializes-missing-file ----------
T=$TMP_ROOT/t3; mkdir -p "$T"; FB=$T/fb.json  # does NOT exist
"$APPEND_SH" --feedback-file "$FB" --source-issue 1 --event-type conflict --files "a.ts" >/dev/null
if [[ -f "$FB" ]] && [[ "$(jq -r '.version' "$FB")" == "1.0.0" ]] && [[ "$(jq '.events | length' "$FB")" == "1" ]]; then
    pass "initializes-missing-file"
else
    fail "initializes-missing-file" "file=$FB version=$(jq -r '.version' "$FB" 2>/dev/null) len=$(jq '.events | length' "$FB" 2>/dev/null)"
fi

# ---------- Test 4: trim-max-events ----------
T=$TMP_ROOT/t4; mkdir -p "$T"; FB=$T/fb.json
for i in 1 2 3 4 5; do
    "$APPEND_SH" --feedback-file "$FB" --source-issue 99 --event-type conflict \
        --files "f${i}.ts" --max-events 3 >/dev/null
done
COUNT=$(jq '.events | length' "$FB")
FIRST_FILE=$(jq -r '.events[0].files[0]' "$FB")
LAST_FILE=$(jq -r '.events[-1].files[0]' "$FB")
# Oldest two should be trimmed; remaining should be f3,f4,f5
if [[ "$COUNT" == "3" ]] && [[ "$FIRST_FILE" == "f3.ts" ]] && [[ "$LAST_FILE" == "f5.ts" ]]; then
    pass "trim-max-events"
else
    fail "trim-max-events" "count=$COUNT first=$FIRST_FILE last=$LAST_FILE"
fi

# ---------- Test 5: read-limit ----------
T=$TMP_ROOT/t5; mkdir -p "$T"; FB=$T/fb.json
for i in 1 2 3; do
    "$APPEND_SH" --feedback-file "$FB" --source-issue $((40 + i)) --event-type conflict \
        --files "f${i}.ts" >/dev/null
done
LAST=$("$READ_SH" --feedback-file "$FB" --limit 1)
if [[ "$(echo "$LAST" | jq 'length')" == "1" ]] && [[ "$(echo "$LAST" | jq -r '.[0].files[0]')" == "f3.ts" ]]; then
    pass "read-limit"
else
    fail "read-limit" "got=$LAST"
fi

# ---------- Test 6: read-filters ----------
# event-type filter
TYPED=$("$READ_SH" --feedback-file "$FB" --event-type conflict)
if [[ "$(echo "$TYPED" | jq 'length')" == "3" ]]; then
    pass "read-filter-event-type"
else
    fail "read-filter-event-type" "expected 3, got $(echo "$TYPED" | jq 'length')"
fi

# source-issue filter
BYISSUE=$("$READ_SH" --feedback-file "$FB" --source-issue 42)
if [[ "$(echo "$BYISSUE" | jq 'length')" == "1" ]] && \
   [[ "$(echo "$BYISSUE" | jq -r '.[0].files[0]')" == "f2.ts" ]]; then
    pass "read-filter-source-issue"
else
    fail "read-filter-source-issue" "got=$BYISSUE"
fi

# file-prefix filter (add an event with a different prefix)
"$APPEND_SH" --feedback-file "$FB" --source-issue 50 --event-type conflict \
    --files "src/types/user.ts" >/dev/null
BYPREFIX=$("$READ_SH" --feedback-file "$FB" --file-prefix "src/types/")
if [[ "$(echo "$BYPREFIX" | jq 'length')" == "1" ]] && \
   [[ "$(echo "$BYPREFIX" | jq -r '.[0].files[0]')" == "src/types/user.ts" ]]; then
    pass "read-filter-file-prefix"
else
    fail "read-filter-file-prefix" "got=$BYPREFIX"
fi

# ---------- Test 7: read-missing-file-returns-empty ----------
MISSING_FB=$TMP_ROOT/never_exists.json
OUT_MISSING=$("$READ_SH" --feedback-file "$MISSING_FB")
if [[ "$OUT_MISSING" == "[]" ]]; then
    pass "read-missing-file-returns-empty"
else
    fail "read-missing-file-returns-empty" "got=$OUT_MISSING"
fi

# ---------- Test 8: analyze-past-conflicts ----------
T=$TMP_ROOT/t8; mkdir -p "$T"; FB=$T/fb.json
"$APPEND_SH" --feedback-file "$FB" --source-issue 42 --event-type conflict --files "src/types/user.ts,src/api/auth.ts" --lesson "a" >/dev/null
"$APPEND_SH" --feedback-file "$FB" --source-issue 43 --event-type conflict --files "src/types/user.ts" --lesson "b" >/dev/null
"$APPEND_SH" --feedback-file "$FB" --source-issue 44 --event-type conflict --files "src/types/order.ts" >/dev/null
"$APPEND_SH" --feedback-file "$FB" --source-issue 45 --event-type conflict --files "src/routes/auth.ts" >/dev/null

# Unfiltered: 'src/types/user.ts' appears 2x, prefix 'src/types' appears 3x
ANALYSIS=$("$ANALYZE_SH" --feedback-file "$FB" --min-occurrences 2)
HAS_HINTS=$(echo "$ANALYSIS" | jq -r '.has_hints')
FILES_COUNT=$(echo "$ANALYSIS" | jq '.recurring_files | length')
PREFIXES_COUNT=$(echo "$ANALYSIS" | jq '.recurring_prefixes | length')
TOP_PREFIX=$(echo "$ANALYSIS" | jq -r '.recurring_prefixes[0].prefix')
TOP_PREFIX_OCC=$(echo "$ANALYSIS" | jq -r '.recurring_prefixes[0].occurrences')
if [[ "$HAS_HINTS" == "true" ]] && \
   [[ "$FILES_COUNT" == "1" ]] && \
   [[ "$PREFIXES_COUNT" == "1" ]] && \
   [[ "$TOP_PREFIX" == "src/types" ]] && \
   [[ "$TOP_PREFIX_OCC" == "3" ]]; then
    pass "analyze-past-conflicts-basic"
else
    fail "analyze-past-conflicts-basic" "has_hints=$HAS_HINTS files=$FILES_COUNT prefixes=$PREFIXES_COUNT top=$TOP_PREFIX occ=$TOP_PREFIX_OCC"
fi

# ---------- Test 9: analyze-filter-affected-files ----------
FILTERED=$("$ANALYZE_SH" --feedback-file "$FB" --min-occurrences 2 \
    --affected-files "src/services/payment.ts,src/infra/db.ts")
if [[ "$(echo "$FILTERED" | jq -r '.has_hints')" == "false" ]] && \
   [[ "$(echo "$FILTERED" | jq '.recurring_files | length')" == "0" ]] && \
   [[ "$(echo "$FILTERED" | jq '.recurring_prefixes | length')" == "0" ]]; then
    pass "analyze-filter-affected-files-no-match"
else
    fail "analyze-filter-affected-files-no-match" "got=$FILTERED"
fi

FILTERED2=$("$ANALYZE_SH" --feedback-file "$FB" --min-occurrences 2 \
    --affected-files "src/types/user.ts,src/types/order.ts")
if [[ "$(echo "$FILTERED2" | jq -r '.has_hints')" == "true" ]] && \
   [[ "$(echo "$FILTERED2" | jq '.recurring_files | length')" == "1" ]]; then
    pass "analyze-filter-affected-files-match"
else
    fail "analyze-filter-affected-files-match" "got=$FILTERED2"
fi

# ---------- Test 10: analyze-missing-feedback-no-hints ----------
NONEXIST=$("$ANALYZE_SH" --feedback-file "$TMP_ROOT/absent.json")
if [[ "$(echo "$NONEXIST" | jq -r '.has_hints')" == "false" ]] && \
   [[ "$(echo "$NONEXIST" | jq -r '.scanned_events')" == "0" ]]; then
    pass "analyze-missing-feedback-no-hints"
else
    fail "analyze-missing-feedback-no-hints" "got=$NONEXIST"
fi

# ---------- Test 11: concurrent-append ----------
T=$TMP_ROOT/t11; mkdir -p "$T"; FB=$T/fb.json
for i in 1 2 3 4 5; do
    ("$APPEND_SH" --feedback-file "$FB" --source-issue "$i" \
        --event-type conflict --files "p${i}.ts" >/dev/null) &
done
wait
COUNT=$(jq '.events | length' "$FB")
UNIQUE=$(jq '[.events[].id] | unique | length' "$FB")
if [[ "$COUNT" == "5" ]] && [[ "$UNIQUE" == "5" ]]; then
    pass "concurrent-append"
else
    fail "concurrent-append" "count=$COUNT unique=$UNIQUE"
fi

# ---------- Test 12: invalid-event-type-rejected ----------
T=$TMP_ROOT/t12; mkdir -p "$T"; FB=$T/fb.json
if "$APPEND_SH" --feedback-file "$FB" --source-issue 1 \
       --event-type invalid_type --files "a.ts" >/dev/null 2>&1; then
    fail "invalid-event-type-rejected" "expected non-zero exit for invalid event-type"
else
    pass "invalid-event-type-rejected"
fi

# ---------- Test 13: schema-validates (optional) ----------
T=$TMP_ROOT/t13; mkdir -p "$T"; FB=$T/fb.json
"$APPEND_SH" --feedback-file "$FB" --source-issue 1 --event-type conflict --files "a.ts" --resolution manual_merge --lesson "test" >/dev/null
if command -v check-jsonschema >/dev/null 2>&1; then
    if check-jsonschema --schemafile "$REPO_ROOT/_lib/schemas/integration-feedback.schema.json" "$FB" >/dev/null 2>&1; then
        pass "schema-validates"
    else
        fail "schema-validates" "check-jsonschema rejected sample"
    fi
else
    echo "SKIP: schema-validates (check-jsonschema not installed)"
fi

echo "----"
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
