// issue #640 / #676 / #690: 実効 shape の判定根拠と analyze 経路が journal telemetry（journal-save prompt の handoff JSON）
// に載ることを VM sandbox で固定する。shape は realized diff の file 数から classifyShape が決めた実効値、
// shape_reason はその realized ベースの根拠（事前見積もり由来の estimated_file_count / shape_refloored は無い）。
// analyze 経路は args.setup.analyze（prerun の analyze 段）から決まり、Workflow 側（Setup 末尾の analyze ゲート）は spawn しない。
//
//   (a) contract 経路（既定）: analyze_path='contract'、analyze_ineligible_reason はキー欠落、
//       shape_reason が realized 閾値判定文、ac_count / realized_file_count / realized_file_count_raw が数値で載る、
//       prerun_durations.analyze が prerun の analyze.duration_seconds、phase_durations に analyze キーは無い（issue #695）
//   (b) jev 経路: analyze_path='jev'、analyze_ineligible_reason が prerun の jev_reasons を '; ' 結合した文字列
//   (c) prerun の analyze.duration_seconds 欠落: prerun_durations キーを出さない（fail-open）
//   (d) realized count 欠損（danger-grep の files が null）: shape=complex、shape_reason が safe floor 文、
//       realized_file_count=null
//   (e) 宣言外パスの除外: realized_file_count は classifyShape 入力（除外後）、realized_file_count_raw は
//       ephemeral 除外のみの総数で、両者が乖離する
//   (f) ゲート後の needs_clarification: failure telemetry の analyze_path='sonnet'
//   (g) telemetry キーは gate / merge tier の入力にならない（merge_tier が contract / jev で同一）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, analyzeArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');

function extractTelemetry(calls) {
  const journalSave = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalSave != null, `label === 'journal-save' の call が見つからない (全 labels: ${calls.map((c) => c.label).join(', ')})`);
  const begin = '<<<JOURNAL_HANDOFF_BODY_BEGIN>>>';
  const beginIdx = journalSave.prompt.indexOf(begin);
  const endIdx = journalSave.prompt.indexOf('<<<JOURNAL_HANDOFF_BODY_END>>>');
  assert.ok(beginIdx >= 0 && endIdx > beginIdx, 'journal-save prompt に JOURNAL_HANDOFF_BODY delimiter が見つからない');
  const payload = JSON.parse(journalSave.prompt.slice(beginIdx + begin.length, endIdx).trim());
  assert.ok(payload.telemetry && typeof payload.telemetry === 'object', 'payload.telemetry が無い');
  return payload.telemetry;
}

async function runScenario({ overrides = {}, extra = {} } = {}) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides, extra });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'shape-calibration-telemetry');
  assert.equal(error, null, `run が throw で終端した: ${error?.message}`);
  return { calls, result, telemetry: extractTelemetry(calls) };
}

test('[shape-calibration] (a) contract 経路（既定）: analyze_path=contract、analyze_ineligible_reason はキー欠落、shape / 数値キー / prerun_durations が型どおり載る', async () => {
  const { telemetry, calls } = await runScenario();
  assert.equal(calls.filter((c) => c.label.startsWith('analyze')).length, 0, '通常経路の analyze ゲートで agent が spawn されている');
  assert.equal(telemetry.analyze_path, 'contract');
  assert.equal(Object.prototype.hasOwnProperty.call(telemetry, 'analyze_ineligible_reason'), false, 'contract 経路では analyze_ineligible_reason キーを出さない');
  assert.equal(telemetry.shape_reason, 'realized 3 file(s), 2 AC, type=fix → shape=standard');
  assert.equal(telemetry.ac_count, 2);
  assert.equal(telemetry.realized_file_count, 3);
  assert.equal(telemetry.realized_file_count_raw, 3);
  assert.equal(telemetry.shape, 'standard');
  // prerun の analyze 段の所要は prerun_durations.analyze。Workflow 側の analyze ゲートは phase_durations に区間を持たない（issue #695）
  assert.deepEqual(telemetry.prerun_durations, { analyze: 5 });
  assert.ok(!telemetry.phase_durations || !('analyze' in telemetry.phase_durations), `phase_durations に analyze キーが残っている: ${JSON.stringify(telemetry.phase_durations)}`);
  // 事前見積もり由来のキーは載せない（issue #676）
  for (const k of ['estimated_file_count', 'shape_refloored', 'effective_shape', 'triviality', 'triviality_reason']) {
    assert.equal(Object.prototype.hasOwnProperty.call(telemetry, k), false, `${k} は telemetry に載せない`);
  }
});

test('[shape-calibration] (b) jev 経路: analyze_path=jev、analyze_ineligible_reason は prerun の jev_reasons を結合した文字列', async () => {
  const { telemetry, calls } = await runScenario({
    extra: { args: analyzeArgs(1, { analyze_path: 'jev', jev_reasons: ['breaking_keyword_scan true', 'comments present (2)'], comment_count: 2, comment_overrides: ['override: comment #1 by reporter（NONE, t）: 訂正'], duration_seconds: 42 }) },
  });
  assert.equal(calls.filter((c) => c.label.startsWith('analyze')).length, 0, 'jev 経路でも analyze ゲートの spawn は 0');
  assert.equal(telemetry.analyze_path, 'jev');
  assert.equal(telemetry.analyze_ineligible_reason, 'breaking_keyword_scan true; comments present (2)');
  assert.deepEqual(telemetry.prerun_durations, { analyze: 42 });
});

test('[shape-calibration] (c) prerun の analyze.duration_seconds 欠落: prerun_durations キーを出さない（fail-open）', async () => {
  const analyze = analyzeArgs(1);
  delete analyze.setup.analyze.duration_seconds;
  const { telemetry } = await runScenario({ extra: { args: analyze } });
  assert.equal(telemetry.analyze_path, 'contract');
  assert.equal(Object.prototype.hasOwnProperty.call(telemetry, 'prerun_durations'), false);
});

test('[shape-calibration] (d) realized count 欠損（files=null）: shape=complex、shape_reason は safe floor 文、realized_file_count=null', async () => {
  const { telemetry } = await runScenario({
    overrides: {
      'danger-grep': { risk: { ok: true, hits: [] }, files: null, struct: null, diffhash: { hash: 'AAA', empty: false } },
    },
  });
  assert.equal(telemetry.shape, 'complex');
  assert.match(telemetry.shape_reason, /safe floor=complex/);
  assert.equal(telemetry.realized_file_count, null);
  assert.equal(telemetry.realized_file_count_raw, null);
});

test('[shape-calibration] (e) 宣言外パス除外: realized_file_count は classifyShape 入力（除外後）、realized_file_count_raw は除外前の総数', async () => {
  const files = ['src/x.ts', 'src/y.ts', 'src/z.ts', 'src/u1.ts', 'src/u2.ts', 'src/u3.ts'];
  const { telemetry } = await runScenario({
    overrides: {
      'danger-grep': { risk: { ok: true, hits: [] }, files, struct: null, diffhash: { hash: 'AAA', empty: false } },
    },
  });
  // plan は STANDARD_FILES 3 件のみ宣言 → 3 件が宣言外で realized count から除外され、shape は standard（raw 6 なら complex）
  assert.equal(telemetry.realized_file_count, 3);
  assert.equal(telemetry.realized_file_count_raw, 6);
  assert.equal(telemetry.shape, 'standard');
  assert.equal(telemetry.shape_reason, 'realized 3 file(s), 2 AC, type=fix → shape=standard');
});

test('[shape-calibration] (f) ゲート後の needs_clarification: failure telemetry の analyze_path は sonnet、jev 理由は analyze_ineligible_reason に残る', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    extra: { args: analyzeArgs(1, { analyze_path: 'jev', jev_reasons: ['comments present (1)'], comment_count: 1, comment_conflicts: ['conflict: comment #1 by alice（OWNER, t）: hmm'] }) },
  });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'shape-calibration-telemetry-f');
  assert.equal(error, null, `run が throw で終端した: ${error?.message}`);
  assert.equal(result?.status, 'needs_clarification');
  const telemetry = extractTelemetry(calls);
  assert.equal(telemetry.analyze_path, 'sonnet');
  assert.equal(telemetry.analyze_ineligible_reason, 'comments present (1)');
  assert.equal(calls.filter((c) => c.label === 'analyze-clarify#1' && c.agentType === 'dev-flow:dev-runner').length, 1, 'ゲート後の sonnet spawn は 1 回');
});

test('[shape-calibration] (g) telemetry キーは merge tier の入力にならない（contract / jev で tier 同一）', async () => {
  const a = await runScenario();
  const b = await runScenario({ extra: { args: analyzeArgs(1, { analyze_path: 'jev', jev_reasons: ['breaking_keyword_scan true'] }) } });
  assert.equal(a.telemetry.merge_tier, b.telemetry.merge_tier);
  assert.deepEqual(a.telemetry.merge_tier_reasons, b.telemetry.merge_tier_reasons);
});
