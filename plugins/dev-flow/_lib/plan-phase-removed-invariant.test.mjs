// _lib/plan-phase-removed-invariant.test.mjs
// issue #678: 空殻化した Plan phase（phase マーカー・常時 0/null の plan iteration / plan verdict telemetry・
// plan 終端の clock mark・summary の plan concerns 配線）を撤去した後、旧シンボルが dev-flow.js と
// _lib/devflow-durations.mjs に再登場しないことを静的に pin する。
//
// `plan` オブジェクト（synthesizeFablePlan の出力）は Implement の spawn 単位・報告キャリア
// （adoptReportedFiles / diffDeclaredPaths / buildCommitMessage / buildPrBody）として生きているため対象外。
//
// 禁止トークンは join で組み立てる — 本ファイル自身が plugins/dev-flow 配下の *.mjs であり、
// (c) の grep 相当スキャンの対象に入るため、literal を書くと自分で invariant を破る。
//
// Run: npx vitest run _lib/plan-phase-removed-invariant.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, extname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');
const pluginsRoot = join(pluginRoot, '..');

const PLAN_ITER = ['plan', 'iter'].join('_');
const PLAN_VERDICT = ['plan', 'verdict'].join('_');

// AC-1 の 7 文字列
const FORBIDDEN = [
  "phase('Plan')",
  ['plan', 'Verdict'].join(''),
  ['plan', 'Concerns'].join(''),
  ['plan', 'Iters'].join(''),
  ['plan', 'end'].join('_'),
  PLAN_ITER,
  PLAN_VERDICT,
];

const TARGETS = [
  '.claude/workflows/dev-flow.js',
  '_lib/devflow-durations.mjs',
];

// ---- (a) 静的 pin: dev-flow.js / devflow-durations.mjs ----

for (const rel of TARGETS) {
  test(`[plan-phase-removed] (a) ${rel} に Plan phase 由来の 7 トークンが出現しない`, () => {
    const src = readFileSync(join(pluginRoot, rel), 'utf8');
    const hits = FORBIDDEN.filter((tok) => src.includes(tok));
    assert.deepEqual(hits, [], `${rel} に撤去済みトークンが残っている: ${hits.join(', ')}`);
  });
}

// ---- (b) 構造 pin: meta.phases に Plan が無く、合成 plan は Analyze 直後（Implement phase より前）に作られる ----

test('[plan-phase-removed] (b) dev-flow.js の meta.phases に Plan が無く、synthesizeFablePlan は phase(\'Implement\') より前で呼ばれる', () => {
  const src = readFileSync(join(pluginRoot, '.claude/workflows/dev-flow.js'), 'utf8');
  assert.ok(!src.includes("{ title: 'Plan' }"), 'meta.phases に Plan が残っている');
  const synth = src.indexOf('let plan = synthesizeFablePlan(req, ISSUE)');
  const impl = src.indexOf("phase('Implement')");
  assert.ok(synth >= 0, 'synthesizeFablePlan(req, ISSUE) の呼び出しが無い（plan オブジェクトは削除対象外）');
  assert.ok(impl >= 0, "phase('Implement') が無い");
  assert.ok(synth < impl, '合成 plan は Implement phase より前に作られるべき');
  for (const fn of [
    'function synthesizeFablePlan(req, issue)',
    'function isFablePlan(p)',
    'function adoptReportedFiles(plan, results)',
    'function diffDeclaredPaths(planTasks, changedFiles)',
    'function buildCommitMessage({ issue, req, plan })',
    'function buildPrBody({ issue, req, plan,',
  ]) {
    assert.ok(src.includes(fn), `plan オブジェクトの consumer が変わっている: ${fn}`);
  }
});

// ---- (c) telemetry 経路: plugins/dev-flow / plugins/playpark-core 配下の *.sh / *.mjs / *.bats ----

const SCAN_EXT = new Set(['.sh', '.mjs', '.bats']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.agents', '.serena', '.system']);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SCAN_EXT.has(extname(name))) out.push(p);
  }
  return out;
}

test(`[plan-phase-removed] (c) plugins/dev-flow / plugins/playpark-core 配下の *.sh / *.mjs / *.bats に ${PLAN_ITER} / ${PLAN_VERDICT} の参照が無い`, () => {
  const files = [
    ...walk(join(pluginsRoot, 'dev-flow'), []),
    ...walk(join(pluginsRoot, 'playpark-core'), []),
  ];
  assert.ok(files.length > 50, `スキャン対象が少なすぎる（${files.length} 件）— walk の root が違う`);
  const hits = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const tok of [PLAN_ITER, PLAN_VERDICT]) {
      if (src.includes(tok)) hits.push(`${relative(pluginsRoot, f)}: ${tok}`);
    }
  }
  assert.deepEqual(hits, [], `telemetry 経路に撤去済みキーの参照が残っている:\n${hits.join('\n')}`);
});
