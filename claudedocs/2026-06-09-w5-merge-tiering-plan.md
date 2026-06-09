# W5 Merge Tiering (AUTO/REVIEW/HOLD) + seeded SEC + danger-grep 配線 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dev-flow に「決定論 danger-grep floor → 2レーン Goal Ledger への security 反映 → merge tier(AUTO/REVIEW/HOLD)提示」を組み込み、軽い変更は AUTO 推奨・危険変更は HOLD として人間に提示する。

**Architecture:** W1 の `diff-risk-classify.sh`(7 danger クラス・realized diff)を Validate 後に dev-runner-haiku 経由で実行し、結果を Goal Ledger に反映する。7 danger クラスを常時 seed(`source:'seed'`→blocking)し、grep clean のクラスは自動 check、hit したクラスは synthetic critical を floor 据え置きして evaluator が evidence で解消するまで block。pr-iterate 後に純粋関数 `classifyMergeTier` が shape / ledger 収束 / 未解消 danger / breaking / docs-test-only / ESCALATE 件数から AUTO/REVIEW/HOLD を算出し return + log で提示する(merge は全 tier 人間。真 auto-merge は W6 へ委譲)。

**Tech Stack:** JS(dynamic workflow VM, ESM import 不可 → inline copy + byte-sync test), node:test, bash(diff-risk-classify.sh), Goal Ledger 純粋関数エンジン。

**確定済み設計判断(2026-06-09 ユーザー承認):**
- seeded SEC = **常時 seed + grep 自動解決**(§4.2 常時 seed と §4.1 micro 軽量化を両立)
- AUTO = **推奨ラベルのみ**(merge は全 tier 人間。真 auto-merge は W6 earned-autonomy へ)
- スコープ = danger-grep 配線 + seeded SEC + merge tier を **W5 に全束ね**

**INLINE COPY POLICY:** `.claude/workflows/dev-flow.js` は dynamic workflow ローダーが独自 VM で評価し ESM import 不可。新規純粋関数は canonical を `_lib/merge-tier.mjs` に置き、dev-flow.js へ inline コピーし `_lib/merge-tier.sync.test.mjs` が byte 一致を CI 保証する(classifyShape / goal-ledger と同方式)。

---

## File Structure

- **Create** `_lib/merge-tier.mjs` — canonical 純粋関数: `DANGER_CLASSES` / `seedSecurityLedger` / `reconcileDanger` / `isDocsOrTestOnly` / `classifyMergeTier`
- **Create** `_lib/merge-tier.test.mjs` — 上記の unit test
- **Create** `_lib/merge-tier.sync.test.mjs` — dev-flow.js inline コピーと canonical の byte 一致検証
- **Modify** `.claude/workflows/dev-flow.js`:
  - inline copy: `DANGER_CLASSES` / `seedSecurityLedger` / `reconcileDanger` / `isDocsOrTestOnly` / `classifyMergeTier`(Goal Ledger エンジンブロック直後)
  - `RISK` / `CHANGED` schema 追加
  - Validate 後に「Security floor」ブロック(ledger を常時 build + SEC seed + danger-grep 実行 + reconcile)、`runEval` 算出
  - Evaluate のループ gate を `!TRIVIAL` → `runEval` へ、ledger build を二重化しない(prebuilt を使う)
  - `EVAL` schema に `security_clearance` 追加、evaluate ループで hit SEC item を evidence 解消
  - pr-iterate 後に merge tier 算出ブロック + return フィールド追加
- **Modify** `_lib/workflow-load-smoke.test.mjs` — RISK schema / merge tier 配線の存在検証

---

## Task 1: `DANGER_CLASSES` + `seedSecurityLedger`(常時 seed)

**Files:**
- Create: `_lib/merge-tier.mjs`
- Test: `_lib/merge-tier.test.mjs`

7 danger クラスを常時 blocking seed する純粋関数。`source:'seed'` により `laneOf` で blocking 扱い。`check:{kind:'deterministic'}` は grep で解消される予定であることを示す。Goal Ledger エンジン(`makeLedger`/`appendItem`)は dev-flow.js / `_lib/goal-ledger.mjs` 側にあるため、本関数は ledger を受け取り `appendItem` 相当を呼ぶのではなく、**seed item の配列を返す純粋関数**にして呼び出し側で append する(エンジン依存を排し単体テスト容易化)。

- [ ] **Step 1: 失敗テストを書く**

```javascript
// _lib/merge-tier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DANGER_CLASSES, seedSecurityLedger } from './merge-tier.mjs';

test('DANGER_CLASSES は diff-risk-classify.sh の 7 クラスと一致', () => {
  assert.deepEqual(DANGER_CLASSES, [
    'auth', 'crypto', 'config', 'data-migration', 'public-api', 'exec-sink', 'dependency',
  ]);
});

test('seedSecurityLedger は 7 クラスを blocking seed item として返す', () => {
  const seeds = seedSecurityLedger();
  assert.equal(seeds.length, 7);
  for (const s of seeds) {
    assert.equal(s.source, 'seed');
    assert.equal(s.dimension, 'security');
    assert.equal(s.severity, 'major');           // source:'seed' で blocking。hit 時に critical へ raise
    assert.deepEqual(s.check, { kind: 'deterministic' });
    assert.ok(s.id.startsWith('SEC-'));
    assert.ok(s.text.length > 0);
  }
  assert.equal(seeds[0].id, 'SEC-AUTH');
  assert.equal(seeds[3].id, 'SEC-DATA-MIGRATION');
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test _lib/merge-tier.test.mjs`
Expected: FAIL（`Cannot find module './merge-tier.mjs'`）

- [ ] **Step 3: 最小実装**

```javascript
// _lib/merge-tier.mjs
// dev-flow W5: merge tiering + 決定論 danger floor の純粋関数群。
//
// INLINE COPY POLICY: .claude/workflows/dev-flow.js は dynamic workflow ローダーが
// 独自 VM で評価するため ESM import 不可。本ファイルの関数は dev-flow.js に inline
// コピーされ、_lib/merge-tier.sync.test.mjs が byte 一致を CI で保証する。
// 修正時は必ず dev-flow.js の inline コピーも同期すること。

// diff-risk-classify.sh が出力する 7 danger クラス（固定順）。
export const DANGER_CLASSES = [
  'auth', 'crypto', 'config', 'data-migration', 'public-api', 'exec-sink', 'dependency',
];

const SEC_TEXT = {
  'auth': '認証/認可ファイルの変更が安全か（権限昇格・認可バイパスなし）',
  'crypto': '暗号処理の変更が安全か（弱いアルゴリズム・鍵漏洩なし）',
  'config': 'config/secret の変更が安全か（秘密情報の平文混入なし）',
  'data-migration': 'data migration が安全か（不可逆・データ欠損なし）',
  'public-api': 'public API 変更が後方互換か（破壊的変更の明示）',
  'exec-sink': 'exec/deserialization sink が安全か（任意コード実行なし）',
  'dependency': '依存追加が安全か（既知脆弱性・supply chain リスクなし）',
};

// 7 danger クラスを常時 blocking seed する。danger-grep clean なら reconcileDanger が
// 自動 check し、hit したクラスは critical へ raise して block 据え置きにする。
export function seedSecurityLedger() {
  return DANGER_CLASSES.map((cls) => ({
    id: `SEC-${cls.toUpperCase()}`,
    text: SEC_TEXT[cls],
    dimension: 'security',
    severity: 'major',
    source: 'seed',
    check: { kind: 'deterministic' },
    danger_class: cls,
  }));
}
```

- [ ] **Step 4: テスト pass を確認**

Run: `node --test _lib/merge-tier.test.mjs`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add _lib/merge-tier.mjs _lib/merge-tier.test.mjs
git commit -m "feat(dev-flow): W5 DANGER_CLASSES + seedSecurityLedger 純粋関数 (7 クラス常時 seed)"
```

---

## Task 2: `reconcileDanger`(grep 結果で seed を自動解決 / hit を critical 据え置き)

**Files:**
- Modify: `_lib/merge-tier.mjs`
- Test: `_lib/merge-tier.test.mjs`

danger-grep の hit クラス集合を受け、SEC seed item を解決する純粋関数。clean クラス → `checked:true`（evidence='danger-grep clean'）。hit クラス → severity を critical へ raise（floor=true で LLM が下げられない）、`checked:false` 据え置き。Goal Ledger の `checkItem`/`applySeverityFloor` ロジックを ledger 全体に対して適用するが、エンジン依存を避けるため **ledger を受けて新 ledger を返す**形にし、内部で items を写像する（goal-ledger の不変性ルールに従う: items を slice して置換）。

- [ ] **Step 1: 失敗テストを書く**

```javascript
// _lib/merge-tier.test.mjs に追記
import { reconcileDanger } from './merge-tier.mjs';

function ledgerWithSeeds() {
  // seedSecurityLedger() の出力を items に入れた最小 ledger（round 0）
  return { items: seedSecurityLedger().map((it) => ({ checked: false, evidence: null, floor: false, ...it })), round: 0 };
}

test('reconcileDanger: clean クラスは checked=true(evidence=grep clean)', () => {
  const out = reconcileDanger(ledgerWithSeeds(), []);   // hit 無し
  for (const it of out.items) {
    assert.equal(it.checked, true);
    assert.match(it.evidence, /clean/);
    assert.equal(it.severity, 'major');                 // raise されない
  }
});

test('reconcileDanger: hit クラスは critical へ raise + checked=false 据え置き', () => {
  const out = reconcileDanger(ledgerWithSeeds(), ['auth', 'crypto']);
  const auth = out.items.find((it) => it.id === 'SEC-AUTH');
  assert.equal(auth.severity, 'critical');
  assert.equal(auth.floor, true);
  assert.equal(auth.checked, false);
  const cfg = out.items.find((it) => it.id === 'SEC-CONFIG');   // hit していない
  assert.equal(cfg.severity, 'major');
  assert.equal(cfg.checked, true);
});

test('reconcileDanger: 未知 hit クラス(diff-risk が出さない値)は無視', () => {
  const out = reconcileDanger(ledgerWithSeeds(), ['bogus']);
  // 7 SEC は全て clean 扱い（bogus に対応する seed が無い）
  assert.ok(out.items.every((it) => it.checked === true));
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test _lib/merge-tier.test.mjs`
Expected: FAIL（`reconcileDanger is not a function`）

- [ ] **Step 3: 最小実装**

```javascript
// _lib/merge-tier.mjs に追記
const SEC_SEVERITY_RANK = { minor: 0, major: 1, critical: 2 };

// danger-grep の hit クラス集合で SEC seed item を解決する。
// clean クラス → checked(evidence='danger-grep clean')。
// hit クラス → critical へ raise(floor=true) + checked=false 据え置き(evaluator が evidence で解消)。
// SEC 以外の item は touch しない。
export function reconcileDanger(ledger, hitClasses) {
  const hits = new Set(hitClasses);
  const items = ledger.items.map((it) => {
    if (it.source !== 'seed' || it.dimension !== 'security') return it;
    if (hits.has(it.danger_class)) {
      const severity = SEC_SEVERITY_RANK['critical'] > SEC_SEVERITY_RANK[it.severity] ? 'critical' : it.severity;
      return { ...it, severity, floor: true, checked: false };
    }
    return { ...it, checked: true, evidence: 'danger-grep clean' };
  });
  return { ...ledger, items };
}
```

- [ ] **Step 4: テスト pass を確認**

Run: `node --test _lib/merge-tier.test.mjs`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add _lib/merge-tier.mjs _lib/merge-tier.test.mjs
git commit -m "feat(dev-flow): W5 reconcileDanger (grep clean 自動解決 / hit を critical 据え置き)"
```

---

## Task 3: `isDocsOrTestOnly` + `classifyMergeTier`(AUTO/REVIEW/HOLD)

**Files:**
- Modify: `_lib/merge-tier.mjs`
- Test: `_lib/merge-tier.test.mjs`

- [ ] **Step 1: 失敗テストを書く**

```javascript
// _lib/merge-tier.test.mjs に追記
import { isDocsOrTestOnly, classifyMergeTier } from './merge-tier.mjs';

test('isDocsOrTestOnly: md/test/bats のみ → true', () => {
  assert.equal(isDocsOrTestOnly(['docs/a.md', 'README.md']), true);
  assert.equal(isDocsOrTestOnly(['_lib/foo.test.mjs', 'x/foo.bats']), true);
  assert.equal(isDocsOrTestOnly(['src/foo.ts']), false);
  assert.equal(isDocsOrTestOnly([]), false);   // 変更ゼロは AUTO 対象にしない
});

test('classifyMergeTier: 未収束 → HOLD', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: false, unresolvedDanger: false, breaking: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
  assert.ok(r.reasons.some((x) => /収束/.test(x)));
});

test('classifyMergeTier: 未解消 danger → HOLD', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: true, breaking: false, docsOrTestOnly: true, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
});

test('classifyMergeTier: breaking → HOLD', () => {
  const r = classifyMergeTier({ shape: 'complex', converged: true, unresolvedDanger: false, breaking: true, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'HOLD');
});

test('classifyMergeTier: ESCALATE 項目あり → HOLD', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: true, unresolvedDanger: false, breaking: false, docsOrTestOnly: false, escalateCount: 2 });
  assert.equal(r.tier, 'HOLD');
});

test('classifyMergeTier: micro + docs/test-only + clean + 収束 → AUTO', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: false, breaking: false, docsOrTestOnly: true, escalateCount: 0 });
  assert.equal(r.tier, 'AUTO');
});

test('classifyMergeTier: 収束済だが micro でない/コード変更 → REVIEW', () => {
  const r = classifyMergeTier({ shape: 'standard', converged: true, unresolvedDanger: false, breaking: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'REVIEW');
});

test('classifyMergeTier: micro だが docs/test-only でない → REVIEW', () => {
  const r = classifyMergeTier({ shape: 'micro', converged: true, unresolvedDanger: false, breaking: false, docsOrTestOnly: false, escalateCount: 0 });
  assert.equal(r.tier, 'REVIEW');
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test _lib/merge-tier.test.mjs`
Expected: FAIL

- [ ] **Step 3: 最小実装**

```javascript
// _lib/merge-tier.mjs に追記
// 変更ファイルが docs(.md/.mdx/.txt, docs/) か test(*test*, *spec*, .bats) のみか。
export function isDocsOrTestOnly(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every((f) =>
    /\.(md|mdx|txt)$/i.test(f) || /(^|\/)docs\//i.test(f)
    || /(^|\/|\.)(test|spec)([./]|$)/i.test(f) || /\.bats$/i.test(f));
}

// merge tier を算出する。merge は全 tier 人間(AUTO も推奨ラベルのみ。真 auto-merge は W6)。
// HOLD: 未収束 / 未解消 danger / breaking / ESCALATE 項目あり（人間 required-block）。
// AUTO: micro かつ docs/test-only かつ danger clean かつ収束（推奨ラベル）。
// REVIEW: それ以外（標準。人間が LGTM して merge）。
export function classifyMergeTier(s) {
  const reasons = [];
  if (!s.converged) reasons.push('ledger 未収束（未 checked blocking 残）');
  if (s.unresolvedDanger) reasons.push('danger-grep hit 未解消（security 要確認）');
  if (s.breaking) reasons.push('breaking/migration 検出');
  if (s.escalateCount > 0) reasons.push(`ESCALATE-TO-HUMAN 項目 ${s.escalateCount} 件`);
  if (reasons.length) return { tier: 'HOLD', reasons };
  if (s.shape === 'micro' && s.docsOrTestOnly) {
    return { tier: 'AUTO', reasons: ['micro + docs/test-only + danger clean + 収束済 — 推奨ラベル（merge は人間）'] };
  }
  return { tier: 'REVIEW', reasons: ['標準 — 人間が LGTM して merge'] };
}
```

- [ ] **Step 4: テスト pass を確認**

Run: `node --test _lib/merge-tier.test.mjs`
Expected: PASS（全 13+ ケース）

- [ ] **Step 5: commit**

```bash
git add _lib/merge-tier.mjs _lib/merge-tier.test.mjs
git commit -m "feat(dev-flow): W5 isDocsOrTestOnly + classifyMergeTier (AUTO/REVIEW/HOLD)"
```

---

## Task 4: dev-flow.js への inline copy + byte-sync test

**Files:**
- Modify: `.claude/workflows/dev-flow.js`(Goal Ledger エンジンブロック直後 = `// ---- /Goal Ledger エンジン ----` の後)
- Create: `_lib/merge-tier.sync.test.mjs`

`_lib/merge-tier.mjs` の `export` を外した関数本体を dev-flow.js に inline コピーし、byte 一致を検証する。`_lib/triviality.sync.test.mjs` を雛形にする。

- [ ] **Step 1: 失敗テストを書く（sync test）**

```javascript
// _lib/merge-tier.sync.test.mjs
// dev-flow.js の merge-tier inline コピーが _lib/merge-tier.mjs と byte 一致することを CI 検証。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// `export ` 接頭辞の有無を無視して named 宣言ブロックを抽出（関数/const）。
function extractBlock(src, decl) {
  // 例: decl='function classifyMergeTier' / 'const DANGER_CLASSES ='
  const re = new RegExp(`(?:export\\s+)?${decl}[\\s\\S]*?\\n}`);
  const m = src.match(re);
  if (!m) throw new Error(`${decl} が見つからない`);
  return m[0].replace(/^export\s+/, '').trim();
}
function extractConstArray(src, name) {
  const re = new RegExp(`(?:export\\s+)?const ${name} = \\[[\\s\\S]*?\\];`);
  const m = src.match(re);
  if (!m) throw new Error(`${name} が見つからない`);
  return m[0].replace(/^export\s+/, '').trim();
}

const canonical = readFileSync(join(repoRoot, '_lib/merge-tier.mjs'), 'utf8');
const inlined = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');

for (const decl of ['function seedSecurityLedger', 'function reconcileDanger', 'function isDocsOrTestOnly', 'function classifyMergeTier']) {
  test(`dev-flow.js inline コピー: ${decl} が canonical と byte 一致`, () => {
    assert.equal(extractBlock(inlined, decl), extractBlock(canonical, decl), `${decl} が乖離`);
  });
}
test('dev-flow.js inline コピー: DANGER_CLASSES が canonical と byte 一致', () => {
  assert.equal(extractConstArray(inlined, 'DANGER_CLASSES'), extractConstArray(canonical, 'DANGER_CLASSES'));
});
test('dev-flow.js inline コピー: SEC_TEXT / SEC_SEVERITY_RANK 定数が存在', () => {
  assert.ok(inlined.includes('const SEC_TEXT = {'));
  assert.ok(inlined.includes('const SEC_SEVERITY_RANK = {'));
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test _lib/merge-tier.sync.test.mjs`
Expected: FAIL（dev-flow.js にまだ inline コピーが無い → `function seedSecurityLedger が見つからない`）

- [ ] **Step 3: dev-flow.js に inline コピーを追加**

`.claude/workflows/dev-flow.js` の `// ---- /Goal Ledger エンジン ----`(115行付近)の直後に、`_lib/merge-tier.mjs` から `export ` を除去した本体（`DANGER_CLASSES` / `SEC_TEXT` / `seedSecurityLedger` / `SEC_SEVERITY_RANK` / `reconcileDanger` / `isDocsOrTestOnly` / `classifyMergeTier`）を貼り付ける。先頭にコメント:

```javascript
// ---- merge-tier エンジン (canonical: _lib/merge-tier.mjs。修正時は両者を同期。byte 一致は _lib/merge-tier.sync.test.mjs が保証) ----
const DANGER_CLASSES = [
  'auth', 'crypto', 'config', 'data-migration', 'public-api', 'exec-sink', 'dependency',
];
// …(SEC_TEXT, seedSecurityLedger, SEC_SEVERITY_RANK, reconcileDanger, isDocsOrTestOnly, classifyMergeTier を export 無しで貼付)…
// ---- /merge-tier エンジン ----
```

- [ ] **Step 4: byte-sync + 全 node test を確認**

Run: `node --test _lib/merge-tier.sync.test.mjs _lib/merge-tier.test.mjs`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add .claude/workflows/dev-flow.js _lib/merge-tier.sync.test.mjs
git commit -m "feat(dev-flow): W5 merge-tier エンジンを dev-flow.js に inline 複製 + byte-sync test"
```

---

## Task 5: Security floor ブロック(danger-grep 実行 + 常時 ledger seed + runEval 算出)

**Files:**
- Modify: `.claude/workflows/dev-flow.js`(schema 追加 + Validate 後ブロック + Evaluate gate 変更)

Validate(552行)後・Evaluate(562行〜)前に、ledger を常時 build + SEC seed + danger-grep 実行 + reconcile するブロックを挿入。Evaluate ループの gate を `!TRIVIAL` → `runEval` に変更し、ledger build を二重化しない。

- [ ] **Step 1: RISK / CHANGED schema を追加**

`// ---- schemas ----` 群(345行付近、PRURL の後)に追加:

```javascript
const RISK = {
  type: 'object', required: ['hits'],
  properties: {
    hits: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'class'],
        properties: {
          file: { type: 'string' },
          class: { type: 'string' },
          severity: { type: 'string' },
        },
      },
    },
  },
}
const CHANGED = {
  type: 'object', required: ['files'],
  properties: { files: { type: 'array', items: { type: 'string' } } },
}
```

- [ ] **Step 2: Validate 後に Security floor ブロックを挿入**

552行(Validate ループ閉じ `}`)の直後、554行コメントの前に挿入:

```javascript
// ============================================================
// Phase Security floor: realized diff に diff-risk-classify(W1)を当て、
// 7 danger クラスを常時 seed した Goal Ledger に反映する(W5)。
// clean クラスは自動 check、hit クラスは critical 据え置きで evaluator が evidence 解消する。
// danger hit があれば micro でも Evaluate を走らせる(tier 無視の security path 強制)。
// ============================================================
phase('Security floor')
let ledger = makeLedger()
for (const seed of seedSecurityLedger()) {
  ledger = appendItem(ledger, seed).ledger
}
const risk = need(await agent(
  `cd ${WT} で作業。次を実行し **stdout の JSON 配列をそのまま** \`{"hits": <配列>}\` に包んで返せ`
  + `（判定や脚色をしない。空配列なら hits:[]）:\n`
  + `bash ${WT}/_shared/scripts/diff-risk-classify.sh origin/${BASE}`,
  { agentType: 'dev-runner-haiku', schema: RISK, label: 'danger-grep', phase: 'Security floor' },
), 'Security floor(danger-grep)')
const dangerHits = [...new Set((risk.hits ?? []).map((h) => h.class))]
ledger = reconcileDanger(ledger, dangerHits)
log(`danger-grep: ${dangerHits.length ? 'HIT ' + dangerHits.join(',') : 'clean'} — `
  + `SEC blocking 未 checked ${blockingItems(ledger).filter((it) => !it.checked).length} 件`)
const runEval = !TRIVIAL || dangerHits.length > 0
if (TRIVIAL && dangerHits.length > 0) {
  log(`⚠️ micro だが danger hit(${dangerHits.join(',')}) → Evaluate を実行（security path 強制）`)
}
```

- [ ] **Step 3: Evaluate ブロックの gate と ledger build を修正**

562-568行を次のように変更（`let ledger = makeLedger()` の重複を削除し、prebuilt ledger を使う。gate を `runEval` に）:

```javascript
// 変更前:
//   let evalResult = null
//   let ledger = makeLedger()
//   if (!TRIVIAL) {
//   phase('Evaluate')
//   ledger = makeLedger()
//   for (const [i, crit] of (req.acceptance_criteria ?? []).entries()) { … }
//
// 変更後:
let evalResult = null
if (runEval) {
phase('Evaluate')
// Security floor で build 済みの ledger に AC + concerns を足す(makeLedger で作り直さない)。
for (const [i, crit] of (req.acceptance_criteria ?? []).entries()) {
  ledger = appendItem(ledger, {
    id: `AC-${i + 1}`, text: String(crit), dimension: 'ac',
    severity: 'major', source: 'ac', check: { kind: 'inspection' },
  }).ledger
}
```

695-696行の `else` ログも `runEval` に合わせて文言調整（`triviality gate` → `micro path: Evaluate skip`）。

- [ ] **Step 4: 既存 node test + smoke test が壊れていないこと**

Run: `node --test _lib/*.test.mjs`
Expected: PASS（vm-load smoke が dev-flow.js を禁止グローバル sandbox でロードできること含む）

- [ ] **Step 5: commit**

```bash
git add .claude/workflows/dev-flow.js
git commit -m "feat(dev-flow): W5 Security floor — 常時 SEC seed + danger-grep 反映 + runEval gate"
```

---

## Task 6: evaluator の security clearance(hit SEC item を evidence 解消)

**Files:**
- Modify: `.claude/workflows/dev-flow.js`(EVAL schema + Evaluate ループ内 + evaluator prompt)

hit した SEC item(critical 据え置き)を evaluator が「安全」と evidence 付きで判定したら checkItem する。AC の `ac_results` と同じパターン(634-656行)。

- [ ] **Step 1: EVAL schema に security_clearance を追加**

308-334行の EVAL `properties` に追加:

```javascript
    security_clearance: {
      type: 'array',
      items: {
        type: 'object',
        required: ['danger_class', 'cleared'],
        properties: {
          danger_class: { type: 'string' },
          cleared: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
```

- [ ] **Step 2: evaluator prompt に security focus を渡す**

Evaluate ループ内の evaluator agent prompt(586-597行)に、hit SEC クラスがある場合の追記を加える:

```javascript
    + (dangerHits.length
        ? `security_focus（danger-grep が realized diff で検出。各クラスの変更が安全かを判定し `
          + `security_clearance:[{danger_class, cleared, evidence}] で返せ。安全確認できないものは cleared:false）:\n`
          + `${JSON.stringify(dangerHits)}\n`
        : '')
```

- [ ] **Step 3: ループ内で security_clearance を ledger に反映**

`ac_results` 反映(634-656行)の直後に追加:

```javascript
  for (const sc of (ev.security_clearance ?? [])) {
    if (!sc || typeof sc.danger_class !== 'string') continue
    const secId = `SEC-${sc.danger_class.toUpperCase()}`
    if (!ledger.items.some((it) => it.id === secId)) continue
    if (sc.cleared === true && typeof sc.evidence === 'string' && sc.evidence.length > 0) {
      ledger = checkItem(ledger, secId, `security cleared: ${sc.evidence}`)
      log(`${secId}: evaluator が安全確認 → checked`)
    }
  }
```

- [ ] **Step 4: 全 node test を確認**

Run: `node --test _lib/*.test.mjs`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add .claude/workflows/dev-flow.js
git commit -m "feat(dev-flow): W5 evaluator security_clearance で hit SEC item を evidence 解消"
```

---

## Task 7: merge tier 算出(pr-iterate 後)+ return フィールド + log

**Files:**
- Modify: `.claude/workflows/dev-flow.js`(pr-iterate 後 716行〜 + return 718行〜)

pr-iterate 後、最終 diff に対し danger-grep を再実行し、merge tier を算出して return + log で提示する。

- [ ] **Step 1: pr-iterate 後に最終 danger-grep + 変更ファイル取得 + tier 算出**

716行(`const iterate = await workflow(...)`)の直後に挿入:

```javascript
// ============================================================
// Phase Merge tier: 最終 diff に danger-grep を再実行し、merge tier を算出して提示する(W5)。
// merge は全 tier 人間。AUTO は推奨ラベルのみ(真 auto-merge は W6 earned-autonomy)。
// ============================================================
phase('Merge tier')
const riskFinal = need(await agent(
  `cd ${WT} で作業。次を実行し **stdout の JSON 配列をそのまま** \`{"hits": <配列>}\` に包んで返せ:\n`
  + `bash ${WT}/_shared/scripts/diff-risk-classify.sh origin/${BASE}`,
  { agentType: 'dev-runner-haiku', schema: RISK, label: 'danger-grep-final', phase: 'Merge tier' },
), 'Merge tier(danger-grep-final)')
const dangerHitsFinal = [...new Set((riskFinal.hits ?? []).map((h) => h.class))]
const changed = need(await agent(
  `cd ${WT} で作業。次を実行し **stdout の各行(ファイルパス)を** \`{"files": [...]}\` に包んで返せ:\n`
  + `git -C ${WT} diff --name-only origin/${BASE}...HEAD`,
  { agentType: 'dev-runner-haiku', schema: CHANGED, label: 'changed-files', phase: 'Merge tier' },
), 'Merge tier(changed-files)')

// 最終 danger を ledger に再反映（PR 中の修正で hit が消えた/増えた場合に追従）
ledger = reconcileDanger(ledger, dangerHitsFinal)
const unresolvedDanger = ledger.items.some(
  (it) => it.dimension === 'security' && it.source === 'seed' && it.floor && !it.checked)
const breaking = /breaking|incompatible|migration|破壊的|非互換/i.test(`${req.scope ?? ''} ${req.summary ?? ''}`)
const escalateCount = advisoryItems(ledger).filter((it) => it.escalate === true).length
const mergeTier = classifyMergeTier({
  shape: SHAPE,
  converged: isConverged(ledger),
  unresolvedDanger,
  breaking,
  docsOrTestOnly: isDocsOrTestOnly(changed.files ?? []),
  escalateCount,
})
log(`merge tier: ${mergeTier.tier} — ${mergeTier.reasons.join(' / ')}`)
```

- [ ] **Step 2: return に merge tier フィールドを追加**

return オブジェクト(718-734行)の `note` の前に追加:

```javascript
  merge_tier: mergeTier.tier,
  merge_tier_reasons: mergeTier.reasons,
  danger_hits: dangerHitsFinal,
```

そして `note` を tier 連動に変更:

```javascript
  note: mergeTier.tier === 'HOLD'
    ? `HOLD: 人間 review 必須。merge 前に reasons を確認してください（${mergeTier.reasons.join(' / ')}）`
    : mergeTier.tier === 'AUTO'
    ? 'AUTO 推奨（低リスク）。最終判断と merge は人間が行ってください'
    : 'REVIEW: 人間が LGTM を確認して merge してください',
```

- [ ] **Step 3: dev-flow.js を sandbox ロードできることを確認(vm-load smoke)**

Run: `node --test _lib/workflow-load-smoke.test.mjs`
Expected: PASS（`[vm-load] dev-flow.js: 禁止グローバルなし sandbox でロードして ReferenceError が出ない`）

- [ ] **Step 4: commit**

```bash
git add .claude/workflows/dev-flow.js
git commit -m "feat(dev-flow): W5 merge tier 算出 + return/log 提示 (AUTO/REVIEW/HOLD)"
```

---

## Task 8: smoke test 拡充 + 全テスト green

**Files:**
- Modify: `_lib/workflow-load-smoke.test.mjs`

dev-flow.js に W5 配線が入ったことを文字列レベルで pin する(classifyShape の triage test と同方式)。

- [ ] **Step 1: 失敗テストを書く**

```javascript
// _lib/workflow-load-smoke.test.mjs に追記
test('[W5] dev-flow.js: RISK schema と diff-risk-classify 呼び出しが存在', () => {
  const src = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
  assert.ok(src.includes('const RISK ='), 'RISK schema があること');
  assert.ok(src.includes('diff-risk-classify.sh'), 'diff-risk-classify.sh を呼ぶこと');
});

test('[W5] dev-flow.js: merge tier 算出と return が存在', () => {
  const src = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
  assert.ok(src.includes('classifyMergeTier('), 'classifyMergeTier を呼ぶこと');
  assert.ok(src.includes('merge_tier:'), 'return に merge_tier があること');
  assert.ok(src.includes('seedSecurityLedger('), 'SEC seed を積むこと');
  assert.ok(src.includes('const runEval ='), 'runEval gate があること');
});
```

- [ ] **Step 2: テスト実行（失敗 → 実装済みなら pass）**

Run: `node --test _lib/workflow-load-smoke.test.mjs`
Expected: PASS（Task 5/7 で実装済みのため）。FAIL する場合は配線漏れ → 該当 Task に戻る。

- [ ] **Step 3: 全 node test + bats を実行**

Run:
```bash
node --test _lib/*.test.mjs
bash tests/run-all-bats.sh
```
Expected: 全 PASS（bats 未インストール環境は graceful skip。CI では `--strict` で bats も走る）

- [ ] **Step 4: commit**

```bash
git add _lib/workflow-load-smoke.test.mjs
git commit -m "test(dev-flow): W5 配線(RISK schema / merge tier / SEC seed)の smoke test"
```

---

## Self-Review

**1. Spec coverage(§4.2 / §4.3 / §4.4 / §8 W5):**
- §4.3 danger-grep on realized diff → Task 5(post-Implement)+ Task 7(pre-merge) ✓
- §4.3 severity floor(hit→critical, lower 不可)→ Task 2 reconcileDanger(floor:true)✓
- §4.2 seeded mandatory SEC → Task 1 seedSecurityLedger(常時 seed)✓
- §4.2 収束 = blocking 全 checked → 既存 isConverged + SEC seed が blocking に入る ✓
- §4.4 AUTO/REVIEW/HOLD → Task 3 classifyMergeTier ✓
- §4.4 人間 merge(AUTO も)→ Task 7 note/log で全 tier 人間明記 ✓
- §4.2 ESCALATE-TO-HUMAN → Task 7 escalateCount(advisory.escalate)で HOLD 寄与。**注**: evaluator が `escalate` を付ける配線は本 plan では最小（field 読むのみ。分類器強化は §9 Q2 として W6 以降へ繰り延べ）
- micro + danger → Task 5 runEval で Evaluate 強制 ✓

**2. Placeholder scan:** 各 Task に実コード/実コマンド/期待出力を記載。TBD/TODO なし ✓

**3. Type consistency:**
- seed item 形状(`id`/`text`/`dimension`/`severity`/`source`/`check`/`danger_class`)は Task 1 で定義、Task 2/6/7 で一貫使用 ✓
- `classifyMergeTier` 入力キー(`shape`/`converged`/`unresolvedDanger`/`breaking`/`docsOrTestOnly`/`escalateCount`)は Task 3 定義 = Task 7 呼び出し一致 ✓
- SEC item id 規約 `SEC-${class.toUpperCase()}`: Task 1 生成 = Task 6 解決(`SEC-${sc.danger_class.toUpperCase()}`)一致 ✓
- danger class enum は diff-risk-classify.sh の 7 クラスと Task 1 DANGER_CLASSES で一致(byte-sync は Task 4)✓

## 未解決 / 繰り延べ(W6 以降)
- ESCALATE-TO-HUMAN の分類器(advisory→escalate 判定)強化と rubber-stamp 防止 feedback loop(§9 Q2)
- AUTO の veto window → 真 auto-merge 昇格(§4.5 earned autonomy, §9 Q3)= W6
- gate_policy enum + calibration monitor = W6
