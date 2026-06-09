// dev-flow.js の gate-policy inline コピーが _lib/gate-policy.mjs と byte 一致することを CI 検証。
//
// 背景: .claude/workflows/dev-flow.js は dynamic workflow ローダーが独自 VM で評価する。
// ESM import 不可のため gate-policy 関数群を inline コピーしており、本テストが手動同期漏れを検出する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// `export ` 接頭辞の有無を無視して named function 宣言ブロックを抽出。
function extractBlock(src, decl) {
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

const canonical = readFileSync(join(repoRoot, '_lib/gate-policy.mjs'), 'utf8');
const inlined = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');

for (const decl of [
  'function resolveGatePolicy',
  'function gateLane',
  'function policyBlockingItems',
  'function policyAdvisoryItems',
  'function isConvergedUnderPolicy',
]) {
  test(`dev-flow.js inline コピー: ${decl} が canonical と byte 一致`, () => {
    assert.equal(extractBlock(inlined, decl), extractBlock(canonical, decl), `${decl} が乖離`);
  });
}

test('dev-flow.js inline コピー: GATE_POLICIES が canonical と byte 一致', () => {
  assert.equal(extractConstArray(inlined, 'GATE_POLICIES'), extractConstArray(canonical, 'GATE_POLICIES'));
});

test('dev-flow.js inline コピー: DEFAULT_GATE_POLICY / 補助定数が存在', () => {
  assert.ok(inlined.includes('const DEFAULT_GATE_POLICY ='));
});
