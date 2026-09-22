// _lib/review-model-frontmatter.test.mjs
// dev-flow / pr-iterate の品質ゲート agent（pr-reviewer / evaluator）は model override を渡さず
// agents/*.md の frontmatter 既定（opus / high）で spawn する — これを VM 挙動と静的検査で pin する。
// model を変える正規経路は frontmatter であり、workflow 側に定数・fallback 機構を持たない。
// 例外は dev-implement-fable（Implement）だけ: fable の usage 上限で null が返ったとき opus へ落とす
// `fallbackModel` opt-in と、green-fix の `model: 'sonnet'` 明示 override を持つ（挙動は
// impl-model-fallback.test.mjs が pin）。本ファイルの静的検査は品質ゲート agent の call 行に限定する。
//
//   (a) DEV_FLOW_SCENARIOS 全 scenario + baseline で観測される pr-reviewer call は opts に `model` キーを持たない
//   (b) 同じ観測範囲で evaluator call（eval#i / final-ac-reconcile / security-clearance-final）も `model` キーを持たない
//   (c) pr-iterate.js の pr-reviewer call（review#i / schema-retry）も `model` キーを持たない
//   (d) telemetry の review_model_config / eval_model_config / impl_model_config リテラルは各 agent の frontmatter の
//       model と一致し、journal 経路（dev-flow: 失敗 / 成功 / abort、pr-iterate: 終端 / abort）全てに載る
//   (e) 両 workflow の evaluator / pr-reviewer の call site に `model:` / `fallbackModel:` が無い（静的）
//   (f) 両 workflow に quality model 定数 / fallback 機構の残骸（QUALITY_MODEL / QUALITY_FALLBACK /
//       nested.quality_fallback / quality_model_config / quality_model_fallback_label）が無い（静的）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, mergeTierFacts } from './test-helpers/vm-sandbox.mjs';
import { DEV_FLOW_SCENARIOS } from './test-helpers/dev-flow-scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowSrc = readFileSync(join(repoRoot, '.claude', 'workflows', 'dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude', 'workflows', 'pr-iterate.js'), 'utf8');
const prReviewerMd = readFileSync(join(repoRoot, 'agents', 'pr-reviewer.md'), 'utf8');
const evaluatorMd = readFileSync(join(repoRoot, 'agents', 'evaluator.md'), 'utf8');
const implementFableMd = readFileSync(join(repoRoot, 'agents', 'dev-implement-fable.md'), 'utf8');

const REVIEWER = 'dev-flow:pr-reviewer';
const EVALUATOR = 'dev-flow:evaluator';

function frontmatterModel(md, name) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, `${name} に frontmatter が無い`);
  const line = m[1].split('\n').find((l) => /^model:\s*/.test(l));
  assert.ok(line, `${name} frontmatter に model が無い`);
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

test('[review-model] (b) dev-flow.js: 全 scenario の evaluator call は opts に model キーを持たない', async () => {
  const calls = await collectDevFlowCalls();
  const evaluator = calls.filter((c) => c.agentType === EVALUATOR);
  assert.ok(evaluator.length > 0, 'evaluator call が 1 件も観測されない');
  const withModel = evaluator.filter((c) => c.opts && 'model' in c.opts);
  assert.deepEqual(withModel.map((c) => `${c.scenario}:${c.label}=${c.model}`), [], 'evaluator call に model キーが残っている');
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

test('[review-model] (d) review_model_config / eval_model_config / impl_model_config は frontmatter の model と一致し、journal 経路全てに載る', () => {
  const reviewerFm = frontmatterModel(prReviewerMd, 'pr-reviewer.md');
  const evaluatorFm = frontmatterModel(evaluatorMd, 'evaluator.md');
  const implFm = frontmatterModel(implementFableMd, 'dev-implement-fable.md');
  assert.equal(reviewerFm, 'opus', 'pr-reviewer.md frontmatter の model は opus のはず');
  assert.equal(evaluatorFm, 'opus', 'evaluator.md frontmatter の model は opus のはず');
  assert.equal(implFm, 'fable', 'dev-implement-fable.md frontmatter の model は fable のはず（opus は fallback 先であって既定ではない）');
  const lines = (src, key) => src.split('\n').filter((l) => l.includes(`${key}:`));
  // dev-flow.js: 失敗 handoff（journalLogFailure）/ 成功 payload / abort handoff の 3 経路
  for (const [key, fm] of [['review_model_config', reviewerFm], ['eval_model_config', evaluatorFm], ['impl_model_config', implFm]]) {
    const hits = lines(devFlowSrc, key);
    assert.equal(hits.length, 3, `dev-flow.js の ${key} は 3 経路（失敗 / 成功 / abort）に載るはず: ${JSON.stringify(hits)}`);
    for (const l of hits) assert.ok(l.includes(`${key}: '${fm}'`), `${key} の値が frontmatter(${fm}) と一致しない: ${l.trim()}`);
  }
  // pr-iterate.js: 終端 payload / abort handoff の 2 経路。evaluator は dev-flow 側の agent なので eval_model_config は載せない
  const prHits = lines(prIterateSrc, 'review_model_config');
  assert.equal(prHits.length, 2, `pr-iterate.js の review_model_config は 2 経路（終端 / abort）に載るはず: ${JSON.stringify(prHits)}`);
  for (const l of prHits) assert.ok(l.includes(`review_model_config: '${reviewerFm}'`), `review_model_config の値が frontmatter(${reviewerFm}) と一致しない: ${l.trim()}`);
  assert.deepEqual(lines(prIterateSrc, 'eval_model_config'), [], 'pr-iterate.js に eval_model_config は載せない');
  assert.deepEqual(lines(prIterateSrc, 'impl_model_config'), [], 'pr-iterate.js に impl_model_config は載せない（implementer は dev-flow 側の agent）');
});

test('[review-model] (e) 両 workflow の evaluator / pr-reviewer の call site に model / fallbackModel を渡す行が無い（静的）', () => {
  const gate = /\bagentType:\s*'(evaluator|pr-reviewer)'/;
  for (const [name, src] of [['dev-flow.js', devFlowSrc], ['pr-iterate.js', prIterateSrc]]) {
    const hits = src.split('\n').filter((l) => gate.test(l) && (/\bmodel:/.test(l) || /\bfallbackModel:/.test(l)));
    assert.deepEqual(hits, [], `${name}: 品質ゲート agent の call に model / fallbackModel が残っている`);
  }
  const evaluatorHits = devFlowSrc.split('\n').filter((l) => l.includes("agentType: 'evaluator'"));
  assert.equal(evaluatorHits.length, 3, 'evaluator call site は 3 箇所のはず');
  // model override を持つ call は dev-implement-fable（FABLE_IMPL_AGENT）の call 行だけ
  const modelHits = devFlowSrc.split('\n').filter((l) => /\bagentType:\s*'/.test(l) && /\bmodel:/.test(l));
  assert.deepEqual(modelHits, [], 'dev-flow.js: 文字列 agentType の call 行に model が残っている（model override は FABLE_IMPL_AGENT の call 行に限る）');
});

test('[review-model] (f) 両 workflow に quality model 定数 / fallback 機構の残骸が無い（静的）', () => {
  const forbidden = ['QUALITY_MODEL', 'QUALITY_FALLBACK', 'quality_fallback', 'quality_model_config', 'quality_model_fallback_label', 'omitModel', '_lib/quality-model.mjs'];
  for (const [name, src] of [['dev-flow.js', devFlowSrc], ['pr-iterate.js', prIterateSrc]]) {
    for (const tok of forbidden) {
      assert.ok(!src.includes(tok), `${name}: '${tok}' が残っている（quality model fallback は dev-flow / pr-iterate から撤去済み。rank-judge 専用の _lib/quality-model.mjs は dev-improve.js にのみ inline する）`);
    }
  }
});
