// _lib/plan-parallel-removed-invariant.test.mjs
// issue #697: parallel fan-out 撤去後に残った「常に空の plan.parallel」と参照ゼロの schema を削除した後、
// それらが dev-flow.js / _lib canonical に再登場しないことを静的に pin する。
// plan は serial のみを持つ（synthesizeFablePlan の出力。値を積む経路は serial だけ）。
//
// Run: npx vitest run _lib/plan-parallel-removed-invariant.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');

// ---- (a) 参照ゼロの schema（旧 dev-kickoff state / iterate schema）が存在しない ----

test('[plan-parallel-removed] (a) _lib/schemas の kickoff / iterate schema が存在しない', () => {
  for (const name of ['kickoff.schema.json', 'iterate.schema.json']) {
    const p = join(here, 'schemas', name);
    assert.ok(!existsSync(p), `参照ゼロの schema が残っている: _lib/schemas/${name}`);
  }
});

// ---- (b) dev-flow.js と _lib/*.mjs（test 除く）に plan.parallel の参照が無い ----

const FORBIDDEN = ['plan.parallel', 'plan?.parallel', 'parallel: []', '.parallel ??'];

const targets = [
  '.claude/workflows/dev-flow.js',
  ...readdirSync(here)
    .filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))
    .map((n) => `_lib/${n}`),
];

test('[plan-parallel-removed] (b) スキャン対象に dev-flow.js と _lib canonical が含まれる', () => {
  assert.ok(targets.includes('.claude/workflows/dev-flow.js'));
  assert.ok(targets.includes('_lib/pr-artifacts.mjs'), '_lib の走査 root が違う');
  assert.ok(targets.length > 20, `スキャン対象が少なすぎる（${targets.length} 件）`);
});

for (const rel of targets) {
  test(`[plan-parallel-removed] (b) ${rel} に plan.parallel の参照が無い`, () => {
    const src = readFileSync(join(pluginRoot, rel), 'utf8');
    const hits = FORBIDDEN.filter((tok) => src.includes(tok));
    assert.deepEqual(hits, [], `${rel} に撤去済みの plan.parallel 参照が残っている: ${hits.join(', ')}`);
  });
}

// ---- (c) 合成 plan と plan を読む側は serial のみを扱う ----

test('[plan-parallel-removed] (c) synthesizeFablePlan は serial のみを返し、isFablePlan / adoptReportedFiles / planPaths は serial だけを読む', () => {
  const src = readFileSync(join(pluginRoot, '.claude/workflows/dev-flow.js'), 'utf8');
  const synthStart = src.indexOf('function synthesizeFablePlan(req, issue)');
  assert.ok(synthStart >= 0, 'synthesizeFablePlan が無い');
  const synthBody = src.slice(synthStart, src.indexOf('\n}\n', synthStart));
  assert.ok(synthBody.includes('serial: ['), synthBody);
  assert.ok(!synthBody.includes('parallel'), `synthesizeFablePlan に parallel が残っている:\n${synthBody}`);
  assert.ok(src.includes('function isFablePlan(p) { return (p?.serial ?? []).some(isFableTask) }'));
  assert.ok(src.includes('return { ...plan, serial: (plan.serial ?? []).map(adopt) }'));
  const prArtifacts = readFileSync(join(here, 'pr-artifacts.mjs'), 'utf8');
  assert.ok(prArtifacts.includes('for (const t of arr(plan?.serial)) {'), 'planPaths は plan.serial だけを走査する');
});
