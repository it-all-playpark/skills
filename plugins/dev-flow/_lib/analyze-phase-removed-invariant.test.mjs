// _lib/analyze-phase-removed-invariant.test.mjs
// issue #695: 空殻化した Analyze phase（phase マーカー・analyze の開始/終了 clock mark・常に 0 だった
// phase_durations の analyze 列・doctor の analyze/plan 列）を撤去し、決定論ゲートを Setup 末尾に吸収した後、
// 旧シンボルが dev-flow.js と _lib/devflow-durations.mjs に再登場しないことを静的に pin する
// （issue #678 の plan-phase-removed-invariant と同型）。
//
// ゲート本体（buildReqFromContract / analyzeGateReasons / clarifyPrompt / analyze-clarify spawn /
// needs_clarification の source: 'analyze' | 'analyze_prerun'）と telemetry の analyze_path /
// analyze_ineligible_reason / prerun_durations.analyze は生きているため対象外。
//
// 禁止トークンは join で組み立てる — 本ファイル自身が plugins/dev-flow 配下の *.mjs であり、
// (c) の grep 相当スキャンの対象に入るため、literal を書くと自分で invariant を破る。
//
// Run: npx vitest run _lib/analyze-phase-removed-invariant.test.mjs
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, extname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');

const ANALYZE_START = ['analyze', 'start'].join('_');
const ANALYZE_END = ['analyze', 'end'].join('_');

// AC-1 の 6 文字列
const FORBIDDEN = [
  ['phase(', "'Analyze')"].join(''),
  ['title: ', "'Analyze'"].join(''),
  ANALYZE_START,
  ANALYZE_END,
  ['phase: ', "'Analyze'"].join(''),
  ['ABORT_CTX.phase = ', "'Analyze'"].join(''),
];

const TARGETS = [
  '.claude/workflows/dev-flow.js',
  '_lib/devflow-durations.mjs',
];

// ---- (a) 静的 pin: dev-flow.js / devflow-durations.mjs ----

for (const rel of TARGETS) {
  test(`[analyze-phase-removed] (a) ${rel} に Analyze phase 由来の 6 トークンが出現しない`, () => {
    const src = readFileSync(join(pluginRoot, rel), 'utf8');
    const hits = FORBIDDEN.filter((tok) => src.includes(tok));
    assert.deepEqual(hits, [], `${rel} に撤去済みトークンが残っている: ${hits.join(', ')}`);
  });
}

// ---- (b) 構造 pin: ゲート本体は Setup 末尾（phase('Setup') の後・phase('Implement') の前）に残り、2 経路の source は不変 ----

test("[analyze-phase-removed] (b) dev-flow.js のゲート本体（buildReqFromContract / analyzeGateReasons / analyze-clarify / needs_clarification 2 経路）は phase('Setup') と phase('Implement') の間に残る", () => {
  const src = readFileSync(join(pluginRoot, '.claude/workflows/dev-flow.js'), 'utf8');
  const setup = src.indexOf("phase('Setup')");
  const impl = src.indexOf("phase('Implement')");
  assert.ok(setup >= 0, "phase('Setup') が無い");
  assert.ok(impl > setup, "phase('Implement') が phase('Setup') の後に無い");
  for (const marker of [
    'const req = buildReqFromContract(ANALYZE, ISSUE)',
    'const gateReasons = analyzeGateReasons(req)',
    'label: `analyze-clarify#${ISSUE}`',
    "source: 'analyze_prerun'",
    "source: 'analyze'",
    "feedClockMark('setup_end', { ok: true, epoch: PRERUN.epoch_end })",
  ]) {
    const idx = src.indexOf(marker);
    assert.ok(idx >= 0, `ゲート本体が変わっている: ${marker}`);
    assert.ok(idx > setup && idx < impl, `${marker} が Setup 末尾（phase('Setup')〜phase('Implement')）の外にある`);
  }
  // ゲート経路の失敗 telemetry / clarify spawn の phase 帰属は 'Setup'
  const gateSlice = src.slice(setup, impl);
  assert.ok(gateSlice.includes("label: `analyze-clarify#${ISSUE}`, phase: 'Setup'"), 'analyze-clarify spawn の phase 帰属が Setup になっていない');
  assert.equal((gateSlice.match(/error_category: 'needs_clarification'[^\n]*phase: 'Setup'/g) || []).length, 2, 'needs_clarification の writeFailureTelemetry 2 経路の phase 帰属が Setup になっていない');
});

// ---- (c) telemetry 経路: plugins/dev-flow 配下の *.sh / *.mjs / *.json / *.bats に phase_durations の analyze / plan 列と doctor の analyze/plan 列が無い ----

const SCAN_EXT = new Set(['.sh', '.mjs', '.json', '.bats']);
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

const PD_ANALYZE = ['phase_durations', 'analyze'].join('.');
const PD_PLAN = ['phase_durations', 'plan'].join('.');
const PL_ANALYZE = ['phase_latency', 'analyze'].join('.');
const PL_PLAN = ['phase_latency', 'plan'].join('.');
const PHASE_NAMES_HEAD = ['PHASE_NAMES=\'["', 'analyze"'].join('');

test(`[analyze-phase-removed] (c) plugins/dev-flow 配下の *.sh / *.mjs / *.json / *.bats に ${PD_ANALYZE} / ${PD_PLAN} / phase_latency の analyze・plan 列 / PHASE_NAMES の analyze の参照が無い`, () => {
  const files = walk(pluginRoot, []);
  assert.ok(files.length > 50, `スキャン対象が少なすぎる（${files.length} 件）— walk の root が違う`);
  const hits = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const tok of [PD_ANALYZE, PD_PLAN, PL_ANALYZE, PL_PLAN, PHASE_NAMES_HEAD]) {
      if (src.includes(tok)) hits.push(`${relative(pluginRoot, f)}: ${tok}`);
    }
    // doctor の phase_latency 出力 / fixture / template に analyze・plan の phase キーが残っていないか
    // （JSON 形: 親キー phase_latency / phase_durations の object 直下に analyze / plan キー）
    for (const parent of ['phase_latency', 'phase_durations']) {
      const re = new RegExp(`"${parent}":\\s*\\{[^}]*"(analyze|plan)"\\s*:`);
      if (re.test(src)) hits.push(`${relative(pluginRoot, f)}: "${parent}" object に analyze/plan キー`);
    }
  }
  assert.deepEqual(hits, [], `telemetry 経路に撤去済みキーの参照が残っている:\n${hits.join('\n')}`);
});
