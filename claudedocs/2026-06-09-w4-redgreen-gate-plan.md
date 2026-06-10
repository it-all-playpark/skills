# W4: red→green ゲート Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** dev-flow の Evaluate 収束を「reviewer verdict のみ」から「`isConverged(ledger) AND verdict==pass`」へ差し替え、red→green 実証(R1+)で test 化できた AC を deterministic-blocking に昇格させる。

**Architecture:** evaluator が per-AC の `ac_results`(satisfied + test_files/impl_files 申告)を返す item-validator になる。orchestrator は申告を runner glob で検証し、dev-runner-haiku が `_shared/scripts/redgreen-verify.sh` を走らせて red→green を決定論判定、取れた AC を `setCheck(deterministic)` で blocking 昇格 + `checkItem`。取れない AC は inspection(advisory)に留め `verdict==pass` 側でカバー。既存 stuck/relax は backstop 維持。

**Tech Stack:** Node 24(`node:test`)/ bash + bats / Claude Code workflow(`dev-flow.js`)/ subagent `evaluator.md`・`dev-runner-haiku`。

**前提:** W3(`feature/dev-flow-w4-redgreen-gate` は W3 tip から stack)。**実装は PR #144 が dev に merge され、本ブランチを dev へ rebase した後**に着手する。**行番号は W3 から変動するため必ずコード内容(anchor)で位置特定**すること。

**Scope:** W4 のみ。merge tiering(W5)/ gate_policy(W6)は対象外。

---

## File Structure

| ファイル | 責務 | 新規/変更 |
|----------|------|-----------|
| `_lib/goal-ledger.mjs` | `setCheck(ledger,id,check)` を追加(item の check 種別を更新=昇格用) | 変更 |
| `_lib/goal-ledger.test.mjs` | setCheck の単体テスト | 変更 |
| `_lib/goal-ledger.sync.test.mjs` | FN_NAMES に setCheck 追加 | 変更 |
| `.claude/workflows/dev-flow.js` | setCheck inline 複製 / EVAL schema 拡張 / Evaluate 配線 + 収束 flip | 変更 |
| `.claude/agents/evaluator.md` | ac_results(per-item validator)契約追加 | 変更 |
| `_shared/scripts/redgreen-verify.sh` | red→green 決定論判定スクリプト | 新規 |
| `_shared/scripts/redgreen-verify.bats` | 上記の bats テスト | 新規 |

---

## Task W4-0: エンジンに setCheck を追加

**Files:** Modify `_lib/goal-ledger.mjs`, `_lib/goal-ledger.test.mjs`; (inline)`.claude/workflows/dev-flow.js`, `_lib/goal-ledger.sync.test.mjs`

- [ ] **Step 1: 失敗テストを追加** — `_lib/goal-ledger.test.mjs` 末尾に:

```javascript
test('setCheck: 既存 item の check 種別を更新（inspection→deterministic で blocking 昇格）', () => {
  let { ledger } = appendItem(makeLedger(), { id: 'AC-1', text: 'x', dimension: 'ac', severity: 'major', source: 'ac', check: { kind: 'inspection' } });
  assert.equal(laneOf(ledger.items[0]), 'advisory');           // 昇格前は advisory
  ledger = setCheck(ledger, 'AC-1', { kind: 'deterministic' });
  assert.equal(ledger.items[0].check.kind, 'deterministic');
  assert.equal(laneOf(ledger.items[0]), 'blocking');           // 昇格後は blocking
});
test('setCheck: 未知 id は throw', () => {
  assert.throws(() => setCheck(makeLedger(), 'X', { kind: 'deterministic' }), /未知の item id/);
});
```

`import` 行に `setCheck` を追加する。

- [ ] **Step 2: fail 確認** — Run: `node --test _lib/goal-ledger.test.mjs` — Expected: FAIL(`setCheck is not a function`)

- [ ] **Step 3: 実装** — `_lib/goal-ledger.mjs` の `reopenItem` の直後に追加:

```javascript
export function setCheck(ledger, id, check) {
  const idx = ledger.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new Error(`goal-ledger: 未知の item id "${id}"`);
  const items = ledger.items.slice();
  items[idx] = { ...items[idx], check };
  return { ...ledger, items };
}
```

- [ ] **Step 4: pass 確認** — Run: `node --test _lib/goal-ledger.test.mjs` — Expected: PASS(23 tests)

- [ ] **Step 5: inline 複製 + sync** — `_lib/goal-ledger.mjs` の `setCheck` を `export ` 除去して `.claude/workflows/dev-flow.js` の inline ledger ブロック(`reopenItem` の直後)へ逐語コピー。`_lib/goal-ledger.sync.test.mjs` の `FN_NAMES` 配列に `'setCheck'` を追加。

- [ ] **Step 6: 検証** — Run: `node --test _lib/goal-ledger.sync.test.mjs`(14 関数 byte 一致)/ `node --test _lib/workflow-load-smoke.test.mjs` — Expected: 両 PASS

- [ ] **Step 7: commit**

```bash
git add _lib/goal-ledger.mjs _lib/goal-ledger.test.mjs _lib/goal-ledger.sync.test.mjs .claude/workflows/dev-flow.js
git commit -m "feat(dev-flow): Goal Ledger に setCheck 追加 (item の check 種別更新=blocking 昇格)"
```

---

## Task W4-1: EVAL schema + evaluator.md に ac_results

**Files:** Modify `.claude/workflows/dev-flow.js`(EVAL schema), `.claude/agents/evaluator.md`

- [ ] **Step 1: EVAL schema 拡張** — `.claude/workflows/dev-flow.js` の `const EVAL = {` を anchor に、`properties` へ `ac_results` を追加(既存フィールドは保持):

```javascript
    ac_results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ac_index', 'satisfied'],
        properties: {
          ac_index: { type: 'number' },
          satisfied: { type: 'boolean' },
          evidence: { type: 'string' },
          verified_by: { type: 'string', enum: ['test', 'inspection'] },
          test_files: { type: 'array', items: { type: 'string' } },
          impl_files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
```

- [ ] **Step 2: evaluator.md に契約追加** — `evaluator.md` の「## Step 5: 出力 JSON」直前に新セクションを挿入:

```markdown
## per-AC 判定（ac_results。W4 item-validator 契約）

`requirements.acceptance_criteria` の各項目について、満たされているかを個別に判定し `ac_results[]` に返す:

- `ac_index`: acceptance_criteria の 0 始まり index。
- `satisfied`: 実 diff / テスト出力に照らして満たされているか（自己申告でなく検証）。
- `evidence`: 根拠（file:line / テスト名）。
- `verified_by`: その AC を **テストで実証できる**なら `"test"`、コード精査でしか判断できないなら `"inspection"`。
- `test_files` / `impl_files`（`verified_by==="test"` のときのみ）: その AC を実証する**テストファイル**と、
  それが検証する**実装ファイル**を worktree 相対パスで列挙する。**自分で red→green 判定を主張しないこと** —
  orchestrator が dev-runner-haiku 経由で `redgreen-verify.sh` を走らせ決定論判定する。あなたは申告のみ。
- test_files は repo の test discovery（`*.test.mjs` / `*.bats`）に一致するものだけ挙げる。混在ファイルは挙げない。
```

`ac_results` を Step 5 の出力 JSON 例にも 1 エントリ追加する。

- [ ] **Step 3: 検証** — Run: `node --test _lib/workflow-load-smoke.test.mjs` — Expected: PASS(schema 構文 OK)

- [ ] **Step 4: commit**

```bash
git add .claude/workflows/dev-flow.js .claude/agents/evaluator.md
git commit -m "feat(dev-flow): evaluator を per-AC item-validator 化 (ac_results 契約)"
```

---

## Task W4-2: redgreen-verify.sh + bats

**Files:** Create `_shared/scripts/redgreen-verify.sh`, `_shared/scripts/redgreen-verify.bats`

- [ ] **Step 1: bats テストを書く** — Create `_shared/scripts/redgreen-verify.bats`:

```bash
#!/usr/bin/env bats
# redgreen-verify.sh: impl を stash して test が red→green に転じるか判定する。

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/redgreen-verify.sh"
  REPO="$(mktemp -d)"
  cd "$REPO"
  git init -q && git config user.email t@t && git config user.name t
  echo "export const ok = false;" > impl.mjs
  git add impl.mjs && git commit -q -m base
  # impl を true にし、それを検証する test を worktree に置く(未 commit = implementer の変更相当)
  echo "export const ok = true;" > impl.mjs
  cat > feature.test.mjs <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from './impl.mjs';
test('ok is true', () => { assert.equal(ok, true); });
EOF
}
teardown() { rm -rf "$REPO"; }

@test "red→green: impl 退避で red、復元で green" {
  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "impl.mjs"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"red":true'* ]]
  [[ "$output" == *'"green":true'* ]]
}

@test "非 test ファイル申告は exit 2(昇格拒否)" {
  run bash "$SCRIPT" "$REPO" "impl.mjs" "impl.mjs"
  [ "$status" -eq 2 ]
  [[ "$output" == *'non-test file'* ]]
}

@test "test と impl が同一ファイル(混在)は exit 2" {
  run bash "$SCRIPT" "$REPO" "feature.test.mjs" "feature.test.mjs"
  [ "$status" -eq 2 ]
}
```

- [ ] **Step 2: fail 確認** — Run: `bats _shared/scripts/redgreen-verify.bats` — Expected: FAIL(script 不在)

- [ ] **Step 3: 実装** — Create `_shared/scripts/redgreen-verify.sh`:

```bash
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
```

`chmod +x _shared/scripts/redgreen-verify.sh`。

- [ ] **Step 4: pass 確認** — Run: `bats _shared/scripts/redgreen-verify.bats` — Expected: PASS(3 tests)

- [ ] **Step 5: commit**

```bash
git add _shared/scripts/redgreen-verify.sh _shared/scripts/redgreen-verify.bats
git commit -m "feat(dev-flow): red→green 決定論判定スクリプト + bats (R1+ stash 方式)"
```

---

## Task W4-3: orchestrator 配線 + 収束 flip

**Files:** Modify `.claude/workflows/dev-flow.js`(Evaluate loop)

anchor で位置特定(W3 当時 L546-565 付近、merge 後は変動)。`log(\`evaluate iteration ${i}: ...\`)` の直後・
既存の「critical feedback を ledger に append」ブロックの**直後**に、ac_results 処理を追加する。

- [ ] **Step 1: ac_results を ledger に反映** — 上記 anchor の後に挿入:

```javascript
  // W4: evaluator の per-AC 判定を ledger に反映。test 実証できる AC は red→green を
  // dev-runner-haiku で決定論検証し、取れたら deterministic 昇格(blocking)。
  for (const r of (ev.ac_results ?? [])) {
    if (!r || typeof r.ac_index !== 'number') continue
    const acId = `AC-${r.ac_index + 1}`
    if (!ledger.items.some((it) => it.id === acId)) continue   // 知らない AC は無視
    if (r.satisfied && r.verified_by === 'test' && Array.isArray(r.test_files) && r.test_files.length
        && Array.isArray(r.impl_files) && r.impl_files.length) {
      const rg = await agent(
        `cd ${WT} で作業。次を実行して **stdout の JSON 1 行だけ** を verbatim で返せ(判定や脚色をしない):\n`
        + `bash ${WT}/_shared/scripts/redgreen-verify.sh ${WT} `
        + `'${r.test_files.join(',')}' '${r.impl_files.join(',')}'`,
        { agentType: 'dev-runner-haiku', schema: RG, label: `redgreen:AC-${r.ac_index + 1}`, phase: 'Evaluate' })
      if (rg && rg.red === true && rg.green === true) {
        ledger = setCheck(ledger, acId, { kind: 'deterministic' })
        ledger = checkItem(ledger, acId, `red→green 実証: ${(r.test_files || []).join(',')}`)
        log(`AC-${r.ac_index + 1}: red→green 実証 → deterministic 昇格 + checked`)
      } else {
        if (r.satisfied) ledger = checkItem(ledger, acId, r.evidence ?? 'inspection(red→green 未成立)')
        log(`AC-${r.ac_index + 1}: red→green 未成立(${rg ? rg.reason : 'null'})→ inspection 据え置き`)
      }
    } else if (r.satisfied) {
      ledger = checkItem(ledger, acId, r.evidence ?? 'inspection')
    }
  }
```

- [ ] **Step 2: RG schema を追加** — `.claude/workflows/dev-flow.js` の schema 群(`const EVAL = {...}` 付近)に:

```javascript
const RG = {
  type: 'object', required: ['red', 'green'],
  properties: { red: { type: 'boolean' }, green: { type: 'boolean' }, reason: { type: 'string' } },
}
```

- [ ] **Step 3: 収束を flip** — Evaluate ループの `if (ev.verdict === 'pass') {` を anchor に、収束条件を差し替え:

```javascript
  if (isConverged(ledger) && ev.verdict === 'pass') {
    log(`evaluate 収束（ledger 全 blocking checked + verdict pass, iter ${i}）— PR へ進む`)
    break
  }
```

既存の stuck 早期打ち切り / `i === EVAL_MAX` / replan・fix 分岐は**そのまま残す**(backstop)。

- [ ] **Step 4: return の observe フィールドを実値に** — `ledger_converged_observe` の key 名を `ledger_converged` に変更(observe ではなく実ゲートになったため)。

- [ ] **Step 5: 検証**

Run: `node --test _lib/workflow-load-smoke.test.mjs` — Expected: PASS
Run: `node --test _lib/goal-ledger.sync.test.mjs` — Expected: PASS(14/14)
Run: `./tests/run-node-tests.sh` — Expected: 全 green
Run: `bash tests/run-all-bats.sh` — Expected: redgreen-verify.bats 含め green(bats 無し環境は skip)

目視: 既存の stuck/relax/`EVAL_MAX`/replan 分岐が無変更であること(`git diff` で追加と収束1行差し替えのみ)。

- [ ] **Step 6: commit**

```bash
git add .claude/workflows/dev-flow.js
git commit -m "feat(dev-flow): 収束を isConverged(ledger) && verdict==pass へ flip + red→green 昇格配線"
```

---

## Task W4-4: W3 follow-up nit(shallow-clone check / 未定義 severity guard)

**Files:** Modify `_lib/goal-ledger.mjs`, `_lib/goal-ledger.test.mjs`, (inline)`.claude/workflows/dev-flow.js`

- [ ] **Step 1: テスト追加** — `_lib/goal-ledger.test.mjs` 末尾:

```javascript
test('appendItem: check は shallow-clone され caller mutation の影響を受けない', () => {
  const check = { kind: 'inspection' };
  const { ledger } = appendItem(makeLedger(), { id: 'A', text: 'x', dimension: 'd', severity: 'major', source: 'ac', check });
  check.kind = 'deterministic';                       // caller が後から変更
  assert.equal(ledger.items[0].check.kind, 'inspection'); // ledger 側は不変
});
```

- [ ] **Step 2: fail 確認** — Run: `node --test _lib/goal-ledger.test.mjs` — Expected: FAIL(shared ref で deterministic になる)

- [ ] **Step 3: 実装** — `_lib/goal-ledger.mjs` の `appendItem` の push 行で `check` を shallow-clone:

```javascript
  else items.push({ checked: false, evidence: null, floor: false, check: null, ...item, check: item.check ? { ...item.check } : null });
```

(末尾の `check:` が前方の `...item` の check を上書きし clone する)

- [ ] **Step 4: pass 確認** — Run: `node --test _lib/goal-ledger.test.mjs` — Expected: PASS

- [ ] **Step 5: inline 同期 + sync 検証** — dev-flow.js の inline `appendItem` を同じく更新し、Run: `node --test _lib/goal-ledger.sync.test.mjs` — Expected: PASS

- [ ] **Step 6: commit**

```bash
git add _lib/goal-ledger.mjs _lib/goal-ledger.test.mjs .claude/workflows/dev-flow.js
git commit -m "fix(dev-flow): Goal Ledger appendItem の check を shallow-clone (W3 nit)"
```

---

## Self-Review

- **Spec coverage**: W4-0 setCheck(昇格手段)/ W4-1 evaluator item-validator(ac_results)/ W4-2 red→green 決定論スクリプト(R1+)/ W4-3 収束 flip(`isConverged && verdict==pass`)+ 昇格配線 / W4-4 W3 nit。design doc §2-5 を被覆。
- **Placeholder scan**: TBD なし。全 code step に完全コード、全 run step に実コマンド+期待。
- **Type consistency**: `setCheck` は W4-0 定義 → W4-3 使用で一致。`ac_results` フィールド(`ac_index/satisfied/evidence/verified_by/test_files/impl_files`)は EVAL schema(W4-1)/ evaluator.md(W4-1)/ orchestrator(W4-3)で一致。`RG` schema(`red/green/reason`)は redgreen-verify.sh 出力 / orchestrator で一致。AC id 規約 `AC-${index+1}` は W3 構築と W4-3 参照で一致。
- **依存順序**: W4-0 → (W4-1, W4-2 並行可) → W4-3 → W4-4。W4-3 は W4-0/1/2 全てに依存。
- **未解決(design doc §6 に残す)**: red→green をループ毎回走らせるコスト(OQ4)/ ac_index ずれ(OQ3)は実装時に観測して調整。スクリプト path は `${WT}/_shared/scripts/redgreen-verify.sh`(worktree に `_shared/` が含まれるため絶対パスで解決)。
