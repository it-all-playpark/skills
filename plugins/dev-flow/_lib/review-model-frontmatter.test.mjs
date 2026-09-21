// _lib/review-model-frontmatter.test.mjs
// pr-reviewer は model override を渡さず agents/pr-reviewer.md の frontmatter 既定（opus / high）で
// spawn し、evaluator 系 3 call site だけが QUALITY_MODEL を渡す — この分離を VM 挙動と静的検査で pin する。
//
//   (a) DEV_FLOW_SCENARIOS 全 scenario + baseline で観測される pr-reviewer call は opts に `model` キーを持たない
//   (b) 同じ観測範囲で evaluator call は全件 `model === QUALITY_MODEL`（fallback 未発火の scenario）
//   (c) pr-iterate.js の pr-reviewer call（review#i / schema-retry）も `model` キーを持たない
//   (d) telemetry の review_model_config リテラルは agents/pr-reviewer.md frontmatter の model と一致し、
//       dev-flow.js / pr-iterate.js の journal 経路（成功 / 失敗 / abort）全てに載る
//   (e) 両 workflow に pr-reviewer へ `model:` を渡す call site が残っていない（静的）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';
import { QUALITY_MODEL } from './quality-model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowSrc = readFileSync(join(repoRoot, '.claude', 'workflows', 'dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude', 'workflows', 'pr-iterate.js'), 'utf8');
const prReviewerMd = readFileSync(join(repoRoot, 'agents', 'pr-reviewer.md'), 'utf8');

const REVIEWER = 'dev-flow:pr-reviewer';
const EVALUATOR = 'dev-flow:evaluator';

function frontmatterModel(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, 'pr-reviewer.md に frontmatter が無い');
  const line = m[1].split('\n').find((l) => /^model:\s*/.test(l));
  assert.ok(line, 'pr-reviewer.md frontmatter に model が無い');
  return line.replace(/^model:\s*/, '').trim();
}

// security-clearance-final は Merge tier で merge-tier-facts が Security floor と異なる hash + risk に新規 hit を
// 返したときだけ到達する（tracked-agent-failure-policy.test.mjs の DF_B5 と同じ構成）。
const SEC_CLEARANCE_FINAL = {
  name: 'security-clearance-final',
  workflow: async () => ({ status: 'lgtm', iterations: 2, fixes_applied: 1 }),
  overrides: {
    'reconcile-sync': { ok: true, head: 'a'.repeat(40) },
    'test#final': { tests: 'passed', green: true, summary: '' },
    'merge-tier-facts': mergeTierFacts({ hash: 'BBB', risk: { ok: true, hits: [{ class: 'auth', file: 'src/x.ts' }] } }),
  },
};

async function collectDevFlowCalls() {
  const all = [];
  const configs = [{ name: 'baseline', overrides: {} }, SEC_CLEARANCE_FINAL, ...Object.entries(DEV_FLOW_SCENARIOS).map(([name, sc]) => ({ name, ...sc }))];
  for (const cfg of configs) {
    const { ctx, calls } = makeDevFlowSandbox({ issue: 1, overrides: cfg.overrides ?? {}, workflow: cfg.workflow });
    await runWorkflowCapture(devFlowSrc, ctx);
    for (const c of calls) all.push({ scenario: cfg.name, ...c });
  }
  return all;
}

test('[review-model] (a) dev-flow.js: 全 scenario の pr-reviewer call は opts に model キーを持たない', async () => {
  const calls = await collectDevFlowCalls();
  const reviewer = calls.filter((c) => c.agentType === REVIEWER);
  assert.ok(reviewer.length > 0, 'pr-reviewer call が 1 件も観測されない（lite scenario の到達条件を見直す）');
  const withModel = reviewer.filter((c) => c.opts && 'model' in c.opts);
  assert.deepEqual(withModel.map((c) => `${c.scenario}:${c.label}`), [], 'pr-reviewer call に model キーが残っている');
});

test('[review-model] (b) dev-flow.js: 全 scenario の evaluator call は model === QUALITY_MODEL', async () => {
  const calls = await collectDevFlowCalls();
  const evaluator = calls.filter((c) => c.agentType === EVALUATOR);
  assert.ok(evaluator.length > 0, 'evaluator call が 1 件も観測されない');
  const wrong = evaluator.filter((c) => c.model !== QUALITY_MODEL);
  assert.deepEqual(wrong.map((c) => `${c.scenario}:${c.label}=${c.model}`), [], `evaluator call の model が QUALITY_MODEL(${QUALITY_MODEL}) でない`);
  // 3 call site（eval#i / final-ac-reconcile / security-clearance-final）が観測範囲に含まれること
  const labels = new Set(evaluator.map((c) => c.label.replace(/#\d+$/, '#i')));
  for (const l of ['eval#i', 'final-ac-reconcile', 'security-clearance-final']) {
    assert.ok(labels.has(l), `evaluator call site '${l}' が scenario 集合で観測されない（到達 scenario を追加する）`);
  }
});

test('[review-model] (c) pr-iterate.js: review#i / schema-retry の pr-reviewer call は model キーを持たない', async () => {
  const { ctx, calls } = makePrIterateSandbox({ overrides: { 'review#1': null, 'review#1-schema-retry': { decision: 'approve', issues: [], summary: 'ok' } } });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assert.equal(error, null, `run は完走するはずだが throw した: ${error?.message}`);
  const reviewer = calls.filter((c) => c.agentType === REVIEWER);
  assert.deepEqual(reviewer.map((c) => c.label), ['review#1', 'review#1-schema-retry']);
  assert.ok(reviewer.every((c) => !('model' in (c.opts ?? {}))), 'pr-iterate の pr-reviewer call に model キーが残っている');
});

test('[review-model] (d) review_model_config は frontmatter の model と一致し、両 workflow の journal 経路全てに載る', () => {
  const fm = frontmatterModel(prReviewerMd);
  assert.equal(fm, 'opus', 'pr-reviewer.md frontmatter の model は opus のはず');
  const needle = `review_model_config: '${fm}'`;
  const devFlowHits = devFlowSrc.split('\n').filter((l) => l.includes('review_model_config:'));
  const prIterateHits = prIterateSrc.split('\n').filter((l) => l.includes('review_model_config:'));
  // dev-flow.js: 失敗 handoff（journalLogFailure）/ 成功 payload / abort handoff の 3 経路
  assert.equal(devFlowHits.length, 3, `dev-flow.js の review_model_config は 3 経路（失敗 / 成功 / abort）に載るはず: ${JSON.stringify(devFlowHits)}`);
  // pr-iterate.js: 終端 payload / abort handoff の 2 経路
  assert.equal(prIterateHits.length, 2, `pr-iterate.js の review_model_config は 2 経路（終端 / abort）に載るはず: ${JSON.stringify(prIterateHits)}`);
  for (const l of [...devFlowHits, ...prIterateHits]) {
    assert.ok(l.includes(needle), `review_model_config の値が frontmatter(${fm}) と一致しない: ${l.trim()}`);
  }
});

test('[review-model] (e) 両 workflow に pr-reviewer へ model を渡す call site が残っていない（静的）', () => {
  for (const [name, src] of [['dev-flow.js', devFlowSrc], ['pr-iterate.js', prIterateSrc]]) {
    const hits = src.split('\n').filter((l) => l.includes("agentType: 'pr-reviewer'") && /\bmodel:/.test(l));
    assert.deepEqual(hits, [], `${name}: pr-reviewer call に model が残っている`);
  }
  const evaluatorHits = devFlowSrc.split('\n').filter((l) => l.includes("agentType: 'evaluator'"));
  assert.equal(evaluatorHits.length, 3, 'evaluator call site は 3 箇所のはず');
  assert.ok(evaluatorHits.every((l) => l.includes('model: QUALITY_MODEL')), 'evaluator call site は全て model: QUALITY_MODEL を渡すはず');
});
