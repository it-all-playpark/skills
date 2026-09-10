// Issue #617: Security floor 統合 exec-proxy 呼び出しの schema 契約強化。
//
// (1) SECFLOOR schema を required:['risk']（risk は ok:boolean / hits:array 必須）に締める
//     — 部分応答ネスト等の契約外形状を StructuredOutput の schema 契約違反として検知できるように
//     する（struct / files / diffhash は引き続き required に含めず fail-open / fail-safe を維持）。
// (2) execSecurityFloorPhase の統合呼び出しに retryOnContractViolation:true を付け、契約違反時に
//     trackedAgent の 1 回リトライ機会を与える。
// (3) retry 後も不正形（もしくは throw）なら risk fail-closed に維持され、fail-closed 時は
//     proxy 応答の top-level キー一覧を含む診断 log が出ることを pin する。
//
// Run: npx vitest run _lib/secfloor-schema-contract-routing.test.mjs
// Full CI: bash tests/run-node-tests.sh --strict

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseSecfloorFields } from './secfloor-unified.mjs';
import { reconcileDanger, seedSecurityLedger, classifyMergeTier } from './merge-tier.mjs';
import { policyBlockingItems, DEFAULT_GATE_POLICY } from './gate-policy.mjs';
import { makeLedger, appendItem } from './goal-ledger.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowPath = join(repoRoot, '.claude', 'workflows', 'dev-flow.js');
const devFlowSrc = readFileSync(devFlowPath, 'utf8');

// ---- helpers ----

function extractSecfloorSchema() {
  const idx = devFlowSrc.indexOf('const SECFLOOR = {');
  assert.ok(idx !== -1, 'const SECFLOOR = { が見つからない');
  const bodyStart = idx + 'const SECFLOOR = '.length;
  const closeIdx = devFlowSrc.indexOf('\n}', bodyStart);
  assert.ok(closeIdx !== -1, 'SECFLOOR schema の終端 (行頭 }) が見つからない');
  const literal = devFlowSrc.slice(bodyStart, closeIdx + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${literal}`)();
}

// 最小 JSON-schema チェッカ: type / required / properties(再帰) のみサポート。
function checkSchema(schema, value, path = '$') {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((t) => {
      if (t === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
      if (t === 'array') return Array.isArray(value);
      if (t === 'null') return value === null;
      return typeof value === t;
    });
    if (!matches) return { ok: false, error: `${path}: type` };
  }
  if (schema.required) {
    for (const key of schema.required) {
      if (value == null || typeof value !== 'object' || !(key in value)) {
        return { ok: false, error: `${path}: missing ${key}` };
      }
    }
  }
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      if (value != null && typeof value === 'object' && key in value) {
        const res = checkSchema(schema.properties[key], value[key], `${path}.${key}`);
        if (!res.ok) return res;
      }
    }
  }
  return { ok: true };
}

// secfloor-unified-routing.test.mjs の reconcileAndClassify と同じ実装
function reconcileAndClassify(risk) {
  let ledger = makeLedger();
  for (const seed of seedSecurityLedger()) ledger = appendItem(ledger, seed).ledger;
  ledger = reconcileDanger(ledger, risk);
  const secItems = ledger.items.filter((it) => it.source === 'seed' && it.dimension === 'security');
  const blocking = policyBlockingItems(ledger, DEFAULT_GATE_POLICY);
  const converged = blocking.every((it) => it.checked);
  const { tier } = classifyMergeTier({ converged, shape: 'micro', docsOrTestOnly: false });
  return { secItems, converged, tier };
}

// ============================================================
// AC1: SECFLOOR schema shape
// ============================================================

test('[secfloor-schema-contract][AC1] SECFLOOR requires risk (ok:boolean, hits:array); struct/files/diffhash stay optional', () => {
  const schema = extractSecfloorSchema();
  assert.deepEqual(schema.required, ['risk']);
  assert.equal(schema.properties.risk.type, 'object');
  assert.deepEqual(schema.properties.risk.required, ['ok', 'hits']);
  assert.equal(schema.properties.risk.properties.ok.type, 'boolean');
  assert.equal(schema.properties.risk.properties.hits.type, 'array');

  assert.ok(!schema.required.includes('files'), 'files が required に含まれてはならない');
  assert.ok(!schema.required.includes('struct'), 'struct が required に含まれてはならない');
  assert.ok(!schema.required.includes('diffhash'), 'diffhash が required に含まれてはならない');
  assert.deepEqual(schema.properties.files.type, ['array', 'null']);
  assert.deepEqual(schema.properties.struct.type, ['object', 'null']);
  assert.deepEqual(schema.properties.diffhash.type, ['object', 'null']);
});

// ============================================================
// AC2: retryOnContractViolation:true on the danger-grep call site
// ============================================================

test("[secfloor-schema-contract][AC2] label 'danger-grep' call site has retryOnContractViolation:true and schema:SECFLOOR", () => {
  const lines = devFlowSrc.split('\n');
  const line = lines.find((l) => /label:\s*'danger-grep'/.test(l) && !/label:\s*'danger-grep-final'/.test(l));
  assert.ok(line, "label 'danger-grep' の行が見つからない");
  assert.match(line, /retryOnContractViolation:\s*true/, `danger-grep 行に retryOnContractViolation:true が無い: ${line}`);
  assert.match(line, /schema:\s*SECFLOOR/, `danger-grep 行に schema:SECFLOOR が無い: ${line}`);
});

// ============================================================
// AC3: nested payload rejected by schema contract
// ============================================================

test('[secfloor-schema-contract][AC3] nested {struct:{risk:...}} response fails schema (missing top-level risk)', () => {
  const schema = extractSecfloorSchema();

  const nested = checkSchema(schema, { struct: { risk: { ok: true, hits: [] } } });
  assert.equal(nested.ok, false);
  assert.match(nested.error, /missing risk/);

  const flat = checkSchema(schema, { risk: { ok: true, hits: [] } });
  assert.equal(flat.ok, true);

  const flatWithNulls = checkSchema(schema, {
    risk: { ok: true, hits: [] }, files: null, struct: null, diffhash: null,
  });
  assert.equal(flatWithNulls.ok, true);

  const missingHits = checkSchema(schema, { risk: { ok: true } });
  assert.equal(missingHits.ok, false);

  const badOkType = checkSchema(schema, { risk: { ok: 'yes', hits: [] } });
  assert.equal(badOkType.ok, false);
});

// ============================================================
// AC4: retry-then-still-invalid keeps risk fail-closed / all SEC seeds unchecked / HOLD
// ============================================================

async function callWithOneRetry(agentCall) {
  let unified;
  let callCount = 0;
  const invoke = async () => {
    callCount += 1;
    return agentCall(callCount);
  };
  try {
    unified = await invoke();
  } catch (e) {
    if (!String(e?.message ?? e).includes('without calling StructuredOutput')) throw e;
    try {
      unified = await invoke();
    } catch (_e2) {
      unified = null;
    }
  }
  return { risk: parseSecfloorFields(unified).risk, callCount };
}

test('[secfloor-schema-contract][AC4] retry after two StructuredOutput throws keeps risk fail-closed and all SEC seeds unchecked / HOLD', async () => {
  const agentCall = async () => { throw new Error('Agent completed without calling StructuredOutput'); };
  const { risk, callCount } = await callWithOneRetry(agentCall);

  assert.equal(risk.ok, false);
  assert.equal(risk.error, 'secfloor unified proxy unavailable (fail-closed)');
  assert.deepEqual(risk.hits, []);
  assert.equal(callCount, 2, 'retry 機会があるので 2 回呼ばれるはず');

  const { secItems, converged, tier } = reconcileAndClassify(risk);
  assert.ok(secItems.length > 0);
  for (const it of secItems) {
    assert.notEqual(it.checked, true);
    assert.equal(it.fail_closed, true);
  }
  assert.equal(converged, false);
  assert.equal(tier, 'HOLD');
});

test('[secfloor-schema-contract][AC4] retry after throw then a nested (schema-invalid-shaped) response also keeps risk fail-closed / HOLD', async () => {
  let callCount = 0;
  const agentCall = async () => {
    callCount += 1;
    if (callCount === 1) throw new Error('Agent completed without calling StructuredOutput');
    return { struct: { risk: { ok: true, hits: [{ file: 'a', class: 'exec-sink', severity: 'critical' }] } } };
  };
  const { risk, callCount: finalCount } = await callWithOneRetry(agentCall);

  assert.equal(risk.ok, false);
  assert.equal(risk.error, 'secfloor unified proxy unavailable (fail-closed)');
  assert.deepEqual(risk.hits, []);
  assert.equal(finalCount, 2);

  const { secItems, converged, tier } = reconcileAndClassify(risk);
  for (const it of secItems) {
    assert.notEqual(it.checked, true);
    assert.equal(it.fail_closed, true);
  }
  assert.equal(converged, false);
  assert.equal(tier, 'HOLD');
});

// ============================================================
// AC5: fail-closed diagnostic log with top-level keys
// ============================================================

test('[secfloor-schema-contract][AC5-source] execSecurityFloorPhase logs top-level keys when risk.ok !== true', () => {
  const fnStart = devFlowSrc.indexOf('async function execSecurityFloorPhase(state)');
  assert.ok(fnStart !== -1);
  const nextFnIdx = devFlowSrc.indexOf('\nasync function ', fnStart + 1);
  const fnBody = devFlowSrc.slice(fnStart, nextFnIdx === -1 ? devFlowSrc.length : nextFnIdx);

  assert.match(fnBody, /if\s*\(\s*risk\.ok\s*!==\s*true\s*\)\s*log\(/, 'risk.ok!==true 条件の log( 呼び出しが見つからない');
  assert.match(fnBody, /契約外形状/, 'log 文字列に「契約外形状」が含まれない');
  assert.match(fnBody, /top-level keys:/, 'log 文字列に "top-level keys:" が含まれない');
  assert.match(fnBody, /secfloorTopLevelKeys\(unified\)/, 'log 呼び出しが secfloorTopLevelKeys(unified) を使っていない');
});

test('[secfloor-schema-contract][AC5-behavior] secfloorTopLevelKeys extracted from dev-flow.js behaves for null/undefined/object/empty/primitive/array', () => {
  const idx = devFlowSrc.indexOf('function secfloorTopLevelKeys(unified) {');
  assert.ok(idx !== -1, 'secfloorTopLevelKeys(unified) 関数定義が見つからない');
  const endIdx = devFlowSrc.indexOf('\n}', idx);
  assert.ok(endIdx !== -1, 'secfloorTopLevelKeys 関数本体の終端が見つからない');
  const fnSrc = devFlowSrc.slice(idx, endIdx + 2);
  // eslint-disable-next-line no-new-func
  const secfloorTopLevelKeys = new Function(`return ${fnSrc}`)();

  assert.equal(secfloorTopLevelKeys(null), 'null');
  assert.equal(secfloorTopLevelKeys(undefined), 'null');
  assert.equal(secfloorTopLevelKeys({ struct: { risk: {} }, files: [] }), 'struct,files');
  assert.equal(secfloorTopLevelKeys({}), '(none)');
  assert.equal(secfloorTopLevelKeys('str'), 'string');
  assert.equal(secfloorTopLevelKeys([1]), 'array');
});
