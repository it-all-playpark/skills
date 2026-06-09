# W3: Goal Ledger エンジン Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dev-flow の収束を「reviewer verdict」から「BLOCKING lane の全項目 checked」へ移すための、純粋関数 Goal Ledger エンジンを実装し、dev-flow.js に inline 複製して Evaluate phase で observe-only に稼働させる。

**Architecture:** `_lib/goal-ledger.mjs` を canonical な純粋関数モジュールとして作り `node:test` で網羅テスト。workflow ランタイムは ESM import 不可のため関数群を `dev-flow.js` に inline 複製し、`_lib/goal-ledger.sync.test.mjs` が byte 一致を CI で保証する(repo 既存パターン: `resolve-arg.mjs` / `triviality.mjs`)。W3 では Evaluate phase で ledger を構築し状態を log + return に出す observe-only に留め、収束 gate の差し替えは W4 に委ねる(既存の stuck/relax を backstop に残す = spec §3 原則 5)。

**Tech Stack:** Node 24 (`node:test`, `node:assert/strict`) / Claude Code dynamic workflow (`.claude/workflows/dev-flow.js`) / bats (既存) / CI: `.github/workflows/lint.yml` の `node-tests` job (`tests/run-node-tests.sh --strict`)。

**この plan の scope:** spec の W3 のみ。W4(red→green ゲート)/ W5(merge tiering + seeded SEC の gate 化)/ W6(gate_policy + gradient)は W3 着地後に個別 plan。W1(danger-grep)/ W2(shape フィールド)/ W7(AGENTS.md)は dev-flow dogfood issue として別建て。

---

## File Structure

| ファイル | 責務 | 新規/変更 |
|----------|------|-----------|
| `_lib/goal-ledger.mjs` | canonical な純粋関数エンジン(lane 分類 / 単調 append / check・reopen / severity floor / 収束判定) | 新規 |
| `_lib/goal-ledger.test.mjs` | エンジンの単体テスト(`node:test`) | 新規 |
| `_lib/goal-ledger.sync.test.mjs` | dev-flow.js の inline コピーが canonical と byte 一致することを保証 | 新規 |
| `.claude/workflows/dev-flow.js` | エンジン関数を inline 複製 + Evaluate phase で ledger を observe-only 構築 | 変更 |

---

## Task 1: Goal Ledger エンジン (canonical module)

**Files:**
- Create: `_lib/goal-ledger.mjs`
- Test: `_lib/goal-ledger.test.mjs`

- [ ] **Step 1: 失敗するテストを書く**

Create `_lib/goal-ledger.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeLedger, laneOf, topicKey, canAppend, appendItem,
  applySeverityFloor, mergeSeverity, checkItem, reopenItem,
  blockingItems, advisoryItems, isConverged, nextRound,
} from './goal-ledger.mjs';

const ac = (over = {}) => ({ id: 'AC-1', text: 'returns 200', dimension: 'ac', severity: 'major', source: 'ac', ...over });

test('laneOf: critical は blocking', () => {
  assert.equal(laneOf(ac({ severity: 'critical' })), 'blocking');
});
test('laneOf: deterministic check 付きは blocking', () => {
  assert.equal(laneOf(ac({ severity: 'minor', check: { kind: 'deterministic' } })), 'blocking');
});
test('laneOf: seed source は blocking', () => {
  assert.equal(laneOf(ac({ severity: 'minor', source: 'seed' })), 'blocking');
});
test('laneOf: それ以外(LLM major/minor, inspection)は advisory', () => {
  assert.equal(laneOf(ac({ severity: 'major', check: { kind: 'inspection' } })), 'advisory');
  assert.equal(laneOf(ac({ severity: 'minor' })), 'advisory');
});

test('topicKey: dimension + 正規化 text', () => {
  assert.equal(topicKey({ dimension: 'security', text: '  No  SQL Injection ' }), 'security::no sql injection');
});

test('canAppend: round 0 は何でも可', () => {
  const l = makeLedger();
  assert.equal(canAppend(l, ac({ severity: 'minor' })), true);
});
test('canAppend: round>=1 は既出 topic か critical のみ', () => {
  let { ledger } = appendItem(makeLedger(), ac({ id: 'A', text: 'foo', dimension: 'd', severity: 'major' }));
  ledger = nextRound(ledger);
  assert.equal(canAppend(ledger, ac({ id: 'B', text: 'foo', dimension: 'd', severity: 'minor' })), true); // 既出 topic
  assert.equal(canAppend(ledger, ac({ id: 'C', text: 'bar', dimension: 'd', severity: 'minor' })), false); // 新規 non-critical
  assert.equal(canAppend(ledger, ac({ id: 'D', text: 'baz', dimension: 'd', severity: 'critical' })), true); // 新規 critical
});

test('appendItem: 受理で accepted:true、新規は default 補完', () => {
  const { ledger, accepted } = appendItem(makeLedger(), ac({ id: 'A' }));
  assert.equal(accepted, true);
  assert.equal(ledger.items.length, 1);
  assert.equal(ledger.items[0].checked, false);
  assert.equal(ledger.items[0].floor, false);
});
test('appendItem: 単調性違反は accepted:false で ledger 不変', () => {
  let { ledger } = appendItem(makeLedger(), ac({ id: 'A', text: 'foo', dimension: 'd' }));
  ledger = nextRound(ledger);
  const res = appendItem(ledger, ac({ id: 'C', text: 'bar', dimension: 'd', severity: 'minor' }));
  assert.equal(res.accepted, false);
  assert.equal(res.ledger.items.length, 1);
});
test('appendItem: 既出 topic は id を保ったまま更新', () => {
  let { ledger } = appendItem(makeLedger(), ac({ id: 'A', text: 'foo', dimension: 'd', severity: 'minor' }));
  ledger = nextRound(ledger);
  const { ledger: l2 } = appendItem(ledger, ac({ id: 'IGNORED', text: 'foo', dimension: 'd', severity: 'critical' }));
  assert.equal(l2.items.length, 1);
  assert.equal(l2.items[0].id, 'A');           // 元の id を保持
  assert.equal(l2.items[0].severity, 'critical'); // 更新は反映
});

test('applySeverityFloor: severity を floor 以上へ引き上げ floor=true', () => {
  const r = applySeverityFloor(ac({ severity: 'minor' }), 'critical');
  assert.equal(r.severity, 'critical');
  assert.equal(r.floor, true);
});
test('mergeSeverity: LLM は raise 可', () => {
  assert.equal(mergeSeverity(ac({ severity: 'minor', floor: false }), 'critical').severity, 'critical');
});
test('mergeSeverity: floor 項目を LLM が lower できない', () => {
  const floored = applySeverityFloor(ac({ severity: 'critical' }), 'critical');
  assert.equal(mergeSeverity(floored, 'minor').severity, 'critical');
});

test('checkItem: id で checked + evidence', () => {
  const { ledger } = appendItem(makeLedger(), ac({ id: 'A' }));
  const l2 = checkItem(ledger, 'A', 'test passed');
  assert.equal(l2.items[0].checked, true);
  assert.equal(l2.items[0].evidence, 'test passed');
});
test('checkItem: 未知 id は throw', () => {
  assert.throws(() => checkItem(makeLedger(), 'X', 'e'), /未知の item id/);
});
test('reopenItem: id + reason 必須、未知 id / reason 無しは throw', () => {
  const { ledger } = appendItem(makeLedger(), ac({ id: 'A' }));
  const checked = checkItem(ledger, 'A', 'e');
  const reopened = reopenItem(checked, 'A', 'regression detected');
  assert.equal(reopened.items[0].checked, false);
  assert.equal(reopened.items[0].reopen_reason, 'regression detected');
  assert.throws(() => reopenItem(checked, 'X', 'r'), /未知の item id/);
  assert.throws(() => reopenItem(checked, 'A', ''), /reason が必要/);
});

test('isConverged: blocking 全 checked で true、advisory 未 checked は無関係', () => {
  let l = makeLedger();
  l = appendItem(l, ac({ id: 'B', severity: 'critical' })).ledger;       // blocking
  l = appendItem(l, ac({ id: 'A', severity: 'minor' })).ledger;          // advisory
  assert.equal(isConverged(l), false);
  l = checkItem(l, 'B', 'done');
  assert.equal(isConverged(l), true); // advisory A は未 checked でも収束
});
test('blockingItems / advisoryItems の分離', () => {
  let l = makeLedger();
  l = appendItem(l, ac({ id: 'B', severity: 'critical' })).ledger;
  l = appendItem(l, ac({ id: 'A', severity: 'minor' })).ledger;
  assert.equal(blockingItems(l).map((i) => i.id).join(','), 'B');
  assert.equal(advisoryItems(l).map((i) => i.id).join(','), 'A');
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test _lib/goal-ledger.test.mjs`
Expected: FAIL — `Cannot find module './goal-ledger.mjs'`

- [ ] **Step 3: エンジンを実装**

Create `_lib/goal-ledger.mjs`:

```javascript
// Goal Ledger: dev-flow の収束エンジン。収束 = BLOCKING lane の全項目 checked。
// item = { id, text, dimension, severity, source, checked, evidence, check, floor, reopen_reason }
//   severity: 'critical' | 'major' | 'minor'
//   source:   'ac' | 'seed' | 'reviewer' | 'evaluator' | 'danger-grep'
//   check:    { kind: 'deterministic' | 'inspection', ref?: string } | null
//   floor:    boolean  (true = 決定論 floor が注入。LLM は severity を lower できない)
//
// BLOCKING lane = 決定論 oracle 付き OR LLM critical OR seeded mandatory。それ以外は ADVISORY。
// 全関数は純粋(ledger を mutate せず新オブジェクトを返す)。state は呼び出し側の JS 変数に持つ。
//
// INLINE COPY POLICY: .claude/workflows/dev-flow.js は dynamic workflow ローダーが独自 VM で
// 評価し ESM import を使えないため、本モジュールの関数群を inline コピーしている。
// _lib/goal-ledger.sync.test.mjs がその byte 一致を CI で保証する。
// 本モジュールを修正する際は dev-flow.js の inline コピーも必ず同期すること。

const SEVERITY_RANK = { minor: 0, major: 1, critical: 2 };

export function makeLedger() {
  return { items: [], round: 0 };
}

export function laneOf(item) {
  if (item.severity === 'critical') return 'blocking';
  if (item.check && item.check.kind === 'deterministic') return 'blocking';
  if (item.source === 'seed') return 'blocking';
  return 'advisory';
}

export function topicKey(item) {
  const norm = String(item.text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${item.dimension ?? '?'}::${norm}`;
}

export function canAppend(ledger, item) {
  if (ledger.round === 0) return true;
  if (item.severity === 'critical') return true;
  const key = topicKey(item);
  return ledger.items.some((it) => topicKey(it) === key);
}

export function appendItem(ledger, item) {
  if (!canAppend(ledger, item)) return { ledger, accepted: false };
  const key = topicKey(item);
  const idx = ledger.round > 0 ? ledger.items.findIndex((it) => topicKey(it) === key) : -1;
  const items = ledger.items.slice();
  if (idx >= 0) items[idx] = { ...items[idx], ...item, id: items[idx].id };
  else items.push({ checked: false, evidence: null, floor: false, check: null, ...item });
  return { ledger: { ...ledger, items }, accepted: true };
}

export function applySeverityFloor(item, floorSeverity) {
  const raised = SEVERITY_RANK[floorSeverity] > SEVERITY_RANK[item.severity] ? floorSeverity : item.severity;
  return { ...item, severity: raised, floor: true };
}

export function mergeSeverity(item, llmSeverity) {
  if (item.floor && SEVERITY_RANK[llmSeverity] < SEVERITY_RANK[item.severity]) return item;
  const raised = SEVERITY_RANK[llmSeverity] > SEVERITY_RANK[item.severity] ? llmSeverity : item.severity;
  return { ...item, severity: raised };
}

export function checkItem(ledger, id, evidence) {
  const idx = ledger.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new Error(`goal-ledger: 未知の item id "${id}"`);
  const items = ledger.items.slice();
  items[idx] = { ...items[idx], checked: true, evidence: evidence ?? null };
  return { ...ledger, items };
}

export function reopenItem(ledger, id, reason) {
  const idx = ledger.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new Error(`goal-ledger: 未知の item id "${id}"`);
  if (!reason) throw new Error('goal-ledger: reopen には reason が必要');
  const items = ledger.items.slice();
  items[idx] = { ...items[idx], checked: false, reopen_reason: reason };
  return { ...ledger, items };
}

export function blockingItems(ledger) {
  return ledger.items.filter((it) => laneOf(it) === 'blocking');
}

export function advisoryItems(ledger) {
  return ledger.items.filter((it) => laneOf(it) === 'advisory');
}

export function isConverged(ledger) {
  return blockingItems(ledger).every((it) => it.checked);
}

export function nextRound(ledger) {
  return { ...ledger, round: ledger.round + 1 };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test _lib/goal-ledger.test.mjs`
Expected: PASS — 全 test ケース green (tests 約 20, fail 0)

- [ ] **Step 5: commit**

```bash
git add _lib/goal-ledger.mjs _lib/goal-ledger.test.mjs
git commit -m "feat(dev-flow): Goal Ledger 純粋関数エンジン (lane分類/単調append/収束判定)"
```

---

## Task 2: dev-flow.js への inline 複製 + byte-sync test

**Files:**
- Modify: `.claude/workflows/dev-flow.js`(`resolvePositiveIntArg` の inline コピー直後、L26 付近に挿入)
- Test: `_lib/goal-ledger.sync.test.mjs`

- [ ] **Step 1: 失敗する sync テストを書く**

Create `_lib/goal-ledger.sync.test.mjs`:

```javascript
// Sync test: dev-flow.js の inline コピーが canonical (_lib/goal-ledger.mjs) と byte 一致することを保証する。
// 背景は _lib/resolve-arg.sync.test.mjs と同じ(workflow ローダーは ESM import 不可 → 手動 inline コピー)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const FN_NAMES = [
  'makeLedger', 'laneOf', 'topicKey', 'canAppend', 'appendItem',
  'applySeverityFloor', 'mergeSeverity', 'checkItem', 'reopenItem',
  'blockingItems', 'advisoryItems', 'isConverged', 'nextRound',
];

function extractFn(src, name) {
  // `export function NAME(...) ... \n}` または inline の `function NAME(...) ... \n}` を抽出し、
  // 先頭の `export ` を剥がして関数本体だけを比較する。
  const re = new RegExp(`(?:export )?function ${name}\\([\\s\\S]*?\\n}`);
  const m = src.match(re);
  if (!m) throw new Error(`${name} が見つからない`);
  return m[0].replace(/^export /, '').trim();
}

const canonicalSrc = readFileSync(join(repoRoot, '_lib/goal-ledger.mjs'), 'utf8');
const wfSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');

for (const name of FN_NAMES) {
  test(`dev-flow.js の inline ${name} が canonical と byte 一致`, () => {
    const canonical = extractFn(canonicalSrc, name);
    const inlined = extractFn(wfSrc, name);
    assert.equal(inlined, canonical, `${name} の inline コピーが _lib/goal-ledger.mjs と乖離している`);
  });
}
```

- [ ] **Step 2: sync テストが失敗することを確認**

Run: `node --test _lib/goal-ledger.sync.test.mjs`
Expected: FAIL — `makeLedger が見つからない`(dev-flow.js にまだ inline コピーが無い)

- [ ] **Step 3: dev-flow.js に関数群を inline 複製**

`.claude/workflows/dev-flow.js` の `resolvePositiveIntArg` 関数定義(L17-26)の直後、`function classifyTriviality` の手前に、以下のブロックを挿入する。**各 `function ...` ブロックは `_lib/goal-ledger.mjs` から `export ` を除いて逐語コピーする**(sync test が関数本体の byte 一致を要求するため、空白・コメントも含めて一致させること)。定数は canonical と同名の `SEVERITY_RANK` を使う(`applySeverityFloor`/`mergeSeverity` の本体がこの名前を参照するため、名前を変えると byte 一致が崩れる。dev-flow.js に既存の `SEVERITY_RANK` は無いので衝突しない):

```javascript

// ---- Goal Ledger エンジン (canonical: _lib/goal-ledger.mjs。修正時は両者を同期。
//      byte 一致は _lib/goal-ledger.sync.test.mjs が保証) ----
const SEVERITY_RANK = { minor: 0, major: 1, critical: 2 };

function makeLedger() {
  return { items: [], round: 0 };
}

function laneOf(item) {
  if (item.severity === 'critical') return 'blocking';
  if (item.check && item.check.kind === 'deterministic') return 'blocking';
  if (item.source === 'seed') return 'blocking';
  return 'advisory';
}

function topicKey(item) {
  const norm = String(item.text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${item.dimension ?? '?'}::${norm}`;
}

function canAppend(ledger, item) {
  if (ledger.round === 0) return true;
  if (item.severity === 'critical') return true;
  const key = topicKey(item);
  return ledger.items.some((it) => topicKey(it) === key);
}

function appendItem(ledger, item) {
  if (!canAppend(ledger, item)) return { ledger, accepted: false };
  const key = topicKey(item);
  const idx = ledger.round > 0 ? ledger.items.findIndex((it) => topicKey(it) === key) : -1;
  const items = ledger.items.slice();
  if (idx >= 0) items[idx] = { ...items[idx], ...item, id: items[idx].id };
  else items.push({ checked: false, evidence: null, floor: false, check: null, ...item });
  return { ledger: { ...ledger, items }, accepted: true };
}

function applySeverityFloor(item, floorSeverity) {
  const raised = SEVERITY_RANK[floorSeverity] > SEVERITY_RANK[item.severity] ? floorSeverity : item.severity;
  return { ...item, severity: raised, floor: true };
}

function mergeSeverity(item, llmSeverity) {
  if (item.floor && SEVERITY_RANK[llmSeverity] < SEVERITY_RANK[item.severity]) return item;
  const raised = SEVERITY_RANK[llmSeverity] > SEVERITY_RANK[item.severity] ? llmSeverity : item.severity;
  return { ...item, severity: raised };
}

function checkItem(ledger, id, evidence) {
  const idx = ledger.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new Error(`goal-ledger: 未知の item id "${id}"`);
  const items = ledger.items.slice();
  items[idx] = { ...items[idx], checked: true, evidence: evidence ?? null };
  return { ...ledger, items };
}

function reopenItem(ledger, id, reason) {
  const idx = ledger.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new Error(`goal-ledger: 未知の item id "${id}"`);
  if (!reason) throw new Error('goal-ledger: reopen には reason が必要');
  const items = ledger.items.slice();
  items[idx] = { ...items[idx], checked: false, reopen_reason: reason };
  return { ...ledger, items };
}

function blockingItems(ledger) {
  return ledger.items.filter((it) => laneOf(it) === 'blocking');
}

function advisoryItems(ledger) {
  return ledger.items.filter((it) => laneOf(it) === 'advisory');
}

function isConverged(ledger) {
  return blockingItems(ledger).every((it) => it.checked);
}

function nextRound(ledger) {
  return { ...ledger, round: ledger.round + 1 };
}
```

> **sync test の仕組み**: テストは各 `function ...` ブロックの **本体のみ**を regex 抽出し、canonical から `export ` を剥がして inline と比較する。よって `SEVERITY_RANK` を参照する `applySeverityFloor`/`mergeSeverity` の本体は両者で逐語一致が必須。定数定義行(`const SEVERITY_RANK = ...`)自体は関数ブロック外なので比較対象外だが、参照名が食い違うと本体が不一致になる。canonical と inline で必ず同名 `SEVERITY_RANK` を使うこと。

- [ ] **Step 3b: 定数衝突が無いことを確認**

Run: `grep -n 'const SEVERITY_RANK' .claude/workflows/dev-flow.js`
Expected: 1 行のみ(今回挿入した定義)。既存の別定義がヒットしないこと。

- [ ] **Step 4: sync テストが通ることを確認**

Run: `node --test _lib/goal-ledger.sync.test.mjs`
Expected: PASS — 13 関数すべて byte 一致 (tests 13, fail 0)

- [ ] **Step 5: workflow ロード smoke test が壊れていないことを確認**

Run: `node --test _lib/workflow-load-smoke.test.mjs`
Expected: PASS(dev-flow.js が構文エラー無くロードできる)

- [ ] **Step 6: commit**

```bash
git add .claude/workflows/dev-flow.js _lib/goal-ledger.sync.test.mjs
git commit -m "feat(dev-flow): Goal Ledger を dev-flow.js に inline 複製 + byte-sync test"
```

---

## Task 3: Evaluate phase で ledger を observe-only 構築

**Files:**
- Modify: `.claude/workflows/dev-flow.js`(Evaluate phase 開始部 L419 付近、および return 文 L506-519)

W3 では収束 gate は差し替えず(spec §3 原則 5 = 既存 stuck/relax を backstop に残す)、ledger を AC + concerns から構築して各 iteration で状態を log し、workflow の return に含める observe-only に留める。これにより実 run で ledger の収束挙動を観測してから、W4 で gate を差し替える。

- [ ] **Step 1: Evaluate phase 入口で ledger を構築**

`.claude/workflows/dev-flow.js` の Evaluate phase、`phase('Evaluate')`(L419)の直後・`const evalSeen = {}`(L420)の手前に挿入:

```javascript
// Goal Ledger を AC + 既出 concerns から observe-only に構築する(W3)。
// W4 で収束 gate をこの ledger.isConverged() へ差し替える。現状は log + return のみ。
let ledger = makeLedger()
for (const [i, crit] of (req.acceptance_criteria ?? []).entries()) {
  // AC は現状 inspection-blocking(LLM 判定)。W4 で red→green 実証済みのものを deterministic 化する。
  ledger = appendItem(ledger, {
    id: `AC-${i + 1}`, text: String(crit), dimension: 'ac',
    severity: 'major', source: 'ac', check: { kind: 'inspection' },
  }).ledger
}
for (const [i, c] of concerns.entries()) {
  ledger = appendItem(ledger, {
    id: `CONCERN-${i + 1}`, text: String(c), dimension: 'concern',
    severity: 'major', source: 'evaluator', check: { kind: 'inspection' },
  }).ledger
}
log(`ledger 初期化: blocking ${blockingItems(ledger).length} / advisory ${advisoryItems(ledger).length} 件`)
```

> 注: `concerns` は L377-381 で既に定義済み(planConcerns + impl concerns + blockedConcerns)。AC は inspection check のため laneOf では advisory に落ちる(severity=major かつ deterministic でない)。critical な concern のみ blocking に乗る。これは意図通り — W3 は「何が blocking になるか」を観測する段階。

- [ ] **Step 2: 各 evaluate iteration の末尾で ledger を nextRound + 状態 log**

`.claude/workflows/dev-flow.js` の Evaluate ループ内、`log(\`evaluate iteration ${i}: ...\`)`(L447)の直後に挿入:

```javascript
  // evaluator の critical feedback を ledger に append(単調性は appendItem が強制)。
  for (const f of (ev.feedback ?? [])) {
    if (f && typeof f === 'object' && f.severity === 'critical') {
      const r = appendItem(ledger, {
        id: `EVAL-${i}-${feedbackTopic(f).slice(0, 24)}`, text: feedbackTopic(f),
        dimension: f.dimension ?? 'eval', severity: 'critical', source: 'evaluator',
        check: { kind: 'inspection' },
      })
      ledger = r.ledger
    }
  }
  ledger = nextRound(ledger)
  log(`ledger: blocking ${blockingItems(ledger).filter((it) => !it.checked).length} 件未 checked / `
    + `converged(observe)=${isConverged(ledger)}`)
```

- [ ] **Step 3: workflow の return に ledger サマリを含める**

`.claude/workflows/dev-flow.js` の `return { ... }`(L506-519)に、`triviality_reason` の次の行へ追加:

```javascript
  ledger_blocking: blockingItems(ledger).length,
  ledger_advisory: advisoryItems(ledger).length,
  ledger_converged_observe: isConverged(ledger),
```

> 注: `ledger` は `if (!TRIVIAL) { ... }` ブロック内で宣言されているため、TRIVIAL 経路では未定義。return が両経路から到達するので、`let ledger = makeLedger()` の宣言を Evaluate phase の `if (!TRIVIAL)` ブロックの **外**(L417 `let evalResult = null` の隣)へ引き上げる。Step 1 の `let ledger = makeLedger()` は `let ledger` 再宣言にならないよう、ブロック外で `let ledger = makeLedger()` 宣言・ブロック内では再代入(`ledger = ...`)にすること。

- [ ] **Step 4: 構文・ロードを確認**

Run: `node --test _lib/workflow-load-smoke.test.mjs`
Expected: PASS

Run: `node -e "import('./.claude/workflows/dev-flow.js').catch(e => { if (String(e).includes('args')) { console.log('OK: loads, fails only on missing args'); process.exit(0) } else { console.error(e); process.exit(1) } })"`
Expected: ロード自体は成功(args 未指定の throw のみ)。`OK: loads...` 相当 or args エラー。構文エラーが出ないこと。

- [ ] **Step 5: 全 node テストと bats が green であることを確認**

Run: `./tests/run-node-tests.sh`
Expected: PASS(goal-ledger / sync / smoke 含む全 mjs テスト green)

Run: `bash tests/run-all-bats.sh`
Expected: PASS(bats 未インストール環境では graceful skip)

- [ ] **Step 6: commit**

```bash
git add .claude/workflows/dev-flow.js
git commit -m "feat(dev-flow): Evaluate phase で Goal Ledger を observe-only 構築 (W4 で gate 差し替え)"
```

---

## Self-Review (この plan を書いた後の確認結果)

- **Spec coverage**: W3 = 「2レーン Goal Ledger エンジン (JS) + 収束 re-cut」。Task 1 = エンジン(lane 分類・単調 append・check/reopen・severity floor・isConverged)。Task 2 = inline 複製 + byte-sync(repo 制約 §7)。Task 3 = Evaluate での observe-only 構築(gate 差し替えは W4、spec §3 原則 5 の「backstop を残す」に整合)。収束の gate 差し替え本体は W4 へ明示的に委譲。
- **Placeholder scan**: TBD/TODO 無し。全 code step に完全コード。全 run step に実コマンドと期待出力。
- **Type consistency**: item フィールド(`id/text/dimension/severity/source/checked/evidence/check/floor/reopen_reason`)は Task 1 定義と Task 3 利用で一致。関数名(`makeLedger/laneOf/topicKey/canAppend/appendItem/applySeverityFloor/mergeSeverity/checkItem/reopenItem/blockingItems/advisoryItems/isConverged/nextRound`)は Task 1・2・3 全体で一致。
- **既知の注意点**: Task 2 の `SEVERITY_RANK` 定数名は canonical/inline で一致させること(sync test は関数本体のみ比較だが `applySeverityFloor`/`mergeSeverity` 本体が定数名を参照するため)。Task 3 の `let ledger` は TRIVIAL/非 TRIVIAL 両経路から return が到達するためブロック外宣言にすること。
