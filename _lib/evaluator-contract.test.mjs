import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { EVALUATOR_OPERATIONAL_CONTRACT } from './evaluator-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const devFlowSrc = readFileSync(join(repoRoot, '.claude/workflows/dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(repoRoot, '.claude/workflows/pr-iterate.js'), 'utf8');
const evaluatorMd = readFileSync(join(repoRoot, '.claude/agents/evaluator.md'), 'utf8');

const evaluatorContractBlock = [
  EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions,
  '',
  EVALUATOR_OPERATIONAL_CONTRACT.security_clearance,
].join('\n');

test('[evaluator-contract] evaluator.md contains the canonical _lib contract block verbatim', () => {
  assert.ok(
    evaluatorMd.includes(evaluatorContractBlock),
    'evaluator.md の critical_resolutions/security_clearance 契約が _lib/evaluator-contract.mjs と乖離しています',
  );
});

test('[evaluator-contract] evaluator.md contains the canonical concern_resolutions contract block verbatim', () => {
  assert.ok(
    evaluatorMd.includes(EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions),
    'evaluator.md の concern_resolutions 契約が _lib/evaluator-contract.mjs と乖離しています',
  );
});

// final_ac_reconcile 契約は evaluator.md へ mirror しない（issue #331 design decision）。
// .claude/agents/ は sandbox レベルの書き込み禁止領域であり、契約は dev-flow.js の
// final-ac-reconcile agent 呼び出し prompt への verbatim 注入のみで配送する（唯一の配送経路）。
// mirror 化する場合はこの pin ごと人間が明示的に変更すること。
test('[evaluator-contract] evaluator.md does NOT mirror the final_ac_reconcile contract (prompt-injection-only delivery, issue #331)', () => {
  assert.ok(
    !evaluatorMd.includes('final_ac_reconcile'),
    'final_ac_reconcile 契約は evaluator.md へ mirror せず、dev-flow.js の final-ac-reconcile prompt 注入のみで配送する設計。mirror 化する場合はこの pin ごと人間が変更すること',
  );
});

test('[evaluator-contract] dev-flow.js inlines and uses the canonical contract', () => {
  assert.ok(
    devFlowSrc.includes('BEGIN inline: _lib/evaluator-contract.mjs'),
    'dev-flow.js に evaluator contract の inline marker が必要です',
  );
  for (const line of EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions.split('\n')) {
    assert.ok(devFlowSrc.includes(line), `dev-flow.js に critical_resolutions 契約行が必要です: ${line}`);
  }
  for (const line of EVALUATOR_OPERATIONAL_CONTRACT.security_clearance.split('\n')) {
    assert.ok(devFlowSrc.includes(line), `dev-flow.js に security_clearance 契約行が必要です: ${line}`);
  }
  assert.ok(devFlowSrc.includes('EVALUATOR_OPERATIONAL_CONTRACT.critical_resolutions'));
  assert.ok(devFlowSrc.includes('EVALUATOR_OPERATIONAL_CONTRACT.security_clearance'));
  for (const line of EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions.split('\n')) {
    assert.ok(devFlowSrc.includes(line), `dev-flow.js に concern_resolutions 契約行が必要です: ${line}`);
  }
  assert.ok(devFlowSrc.includes('EVALUATOR_OPERATIONAL_CONTRACT.concern_resolutions'));
});

test('[evaluator-contract] dev-flow.js inlines and uses the canonical final_ac_reconcile contract', () => {
  for (const line of EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile.split('\n')) {
    assert.ok(devFlowSrc.includes(line), `dev-flow.js に final_ac_reconcile 契約行が必要です: ${line}`);
  }
  assert.ok(devFlowSrc.includes('EVALUATOR_OPERATIONAL_CONTRACT.final_ac_reconcile'));
});

test('[evaluator-contract] evaluator.md output example does not include schema-less score field', () => {
  assert.ok(!evaluatorMd.includes('"score"'), 'EVAL schema に無い score を evaluator.md の例に載せない');
});

test('[schema] dev-flow VERDICT.findings enforces stable stuck-detection fields', () => {
  assert.match(
    devFlowSrc,
    /findings:\s*\{\s*type:\s*'array',\s*items:\s*\{\s*type:\s*'object',\s*required:\s*\['severity', 'dimension', 'topic', 'description', 'suggestion'\]/s,
    'dev-flow VERDICT.findings は item schema と required fields を持つ必要があります',
  );
});

test('[schema] pr-iterate REVIEW.issues enforces stable stuck-detection fields', () => {
  assert.match(
    prIterateSrc,
    /issues:\s*\{\s*type:\s*'array',\s*items:\s*\{\s*type:\s*'object',\s*required:\s*\['severity', 'topic', 'file', 'description', 'suggestion'\]/s,
    'pr-iterate REVIEW.issues は item schema と topic/file/description を required にする必要があります',
  );
});
