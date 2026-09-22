// issue #640 / #676: 実効 shape の判定根拠と analyze 経路が journal telemetry（journal-save prompt の handoff JSON）
// に載ることを VM sandbox で固定する。shape は realized diff の file 数から classifyShape が決めた実効値、
// shape_reason はその realized ベースの根拠（事前見積もり由来の estimated_file_count / shape_refloored は無い）。
//
//   (a) sonnet 経路（contract-probe が null）: analyze_path='sonnet'、analyze_ineligible_reason が
//       workflow 側の理由（contract probe failed）、shape_reason が realized 閾値判定文、
//       ac_count / realized_file_count / realized_file_count_raw が数値で載る
//   (b) contract 経路採用: analyze_path='contract'、analyze_ineligible_reason はキー欠落
//   (c) contract 不採用（analyze-issue.sh の ineligible_reason あり）: その文字列が verbatim で載る
//   (d) realized count 欠損（danger-grep の files が null）: shape=complex、shape_reason が safe floor 文、
//       realized_file_count=null
//   (e) 宣言外パスの除外: realized_file_count は classifyShape 入力（除外後）、realized_file_count_raw は
//       ephemeral 除外のみの総数で、両者が乖離する
//   (f) DEPTH !== 'standard': contract 未試行の理由が載る
//   (g) telemetry キーは gate / merge tier の入力にならない（merge_tier が (a) と同一）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs } from './test-helpers/vm-sandbox.mjs';

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
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'shape-calibration-telemetry');
  assert.equal(error, null, `run が throw で終端した: ${error?.message}`);
  return { calls, telemetry: extractTelemetry(calls) };
}

const CONTRACT_OK = {
  ok: true,
  result: {
    eligible: true, contract: 't1', title: 'stub-issue-title', issue_type: 'fix',
    acceptance_criteria: ['a', 'b'], breaking_keyword_scan: false, comment_count: 0,
    scope: 'src', scope_truncated: false,
  },
};

test('[shape-calibration] (a) sonnet 経路: shape（実効）/ shape_reason（realized ベース）/ 数値キーが型どおり載る', async () => {
  const { telemetry } = await runScenario();
  assert.equal(telemetry.analyze_path, 'sonnet');
  assert.equal(telemetry.analyze_ineligible_reason, 'contract probe failed');
  assert.equal(telemetry.shape_reason, 'realized 3 file(s), 2 AC, type=fix → shape=standard');
  assert.equal(telemetry.ac_count, 2);
  assert.equal(telemetry.realized_file_count, 3);
  assert.equal(telemetry.realized_file_count_raw, 3);
  assert.equal(telemetry.shape, 'standard');
  // 事前見積もり由来のキーは載せない（issue #676）
  for (const k of ['estimated_file_count', 'shape_refloored', 'effective_shape', 'triviality', 'triviality_reason']) {
    assert.equal(Object.prototype.hasOwnProperty.call(telemetry, k), false, `${k} は telemetry に載せない`);
  }
});

test('[shape-calibration] (b) contract 経路採用: analyze_path=contract、analyze_ineligible_reason はキー欠落', async () => {
  const { telemetry, calls } = await runScenario({ overrides: { 'contract-probe#1': CONTRACT_OK } });
  assert.equal(calls.filter((c) => c.label === 'analyze#1').length, 0, 'contract 採用時に sonnet analyze が呼ばれている');
  assert.equal(telemetry.analyze_path, 'contract');
  assert.equal(Object.prototype.hasOwnProperty.call(telemetry, 'analyze_ineligible_reason'), false, '採用時は analyze_ineligible_reason キーを出さない');
  assert.equal(telemetry.ac_count, 2);
  assert.equal(telemetry.shape, 'standard');
  assert.equal(telemetry.shape_reason, 'realized 3 file(s), 2 AC, type=fix → shape=standard');
});

test('[shape-calibration] (c) contract 不採用: analyze-issue.sh の ineligible_reason が verbatim で載る', async () => {
  const { telemetry } = await runScenario({
    overrides: { 'contract-probe#1': { ok: true, result: { eligible: false, ineligible_reason: 'comments present (2) — body/comment reconciliation requires sonnet analyze' } } },
  });
  assert.equal(telemetry.analyze_path, 'sonnet');
  assert.equal(telemetry.analyze_ineligible_reason, 'comments present (2) — body/comment reconciliation requires sonnet analyze');
});

test('[shape-calibration] (c2) contract eligible だが whitelist 不合格（reason 無し）: whitelist rejected', async () => {
  const { telemetry } = await runScenario({
    overrides: { 'contract-probe#1': { ok: true, result: { ...CONTRACT_OK.result, comment_count: 1 } } },
  });
  assert.equal(telemetry.analyze_path, 'sonnet');
  assert.equal(telemetry.analyze_ineligible_reason, 'whitelist rejected');
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

test('[shape-calibration] (f) DEPTH !== standard: contract 未試行の理由が載る', async () => {
  const { telemetry, calls } = await runScenario({ extra: { args: { ...devFlowArgs('1'), depth: 'comprehensive' } } });
  assert.equal(calls.filter((c) => c.label.startsWith('contract-probe')).length, 0);
  assert.equal(telemetry.analyze_path, 'sonnet');
  assert.equal(telemetry.analyze_ineligible_reason, 'contract not attempted (depth=comprehensive)');
});

test('[shape-calibration] (g) telemetry キーは merge tier の入力にならない（contract / sonnet で tier 同一）', async () => {
  const a = await runScenario();
  const b = await runScenario({ overrides: { 'contract-probe#1': CONTRACT_OK } });
  assert.equal(a.telemetry.merge_tier, b.telemetry.merge_tier);
  assert.deepEqual(a.telemetry.merge_tier_reasons, b.telemetry.merge_tier_reasons);
});
