// ci-truth-routing.test.mjs — CI の真偽を proxy の転記 1 か所に預けないことを workflow を VM 実行して観測する（issue #834）。
//
// 守っている不変条件:
//   - pr-iterate / dev-flow lite route は ci-check / ci-wait-check の status を、check-ci の件数から導き直した値と
//     一致するときだけ採る。件数 pending:2 なのに status:"passed" と返った応答（PR #831 の実例）で lgtm に進まない
//   - Merge tier は merge-tier-facts の checks に fail / cancel / 未知 bucket があれば HOLD（ci_checks_failed）にする。
//     pending / 取得失敗は HOLD にせず、終端サマリに「CI 未完了」を出す（fail-open）。mergeStateStatus=UNSTABLE は見ない

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, assertNoCrash, mergeTierFacts, shapeOverrides,
} from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const prIterateSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'pr-iterate.js'), 'utf8');
const devFlowSrc = readFileSync(join(here, '..', '.claude', 'workflows', 'dev-flow.js'), 'utf8');

// PR #831 で haiku が返した形: check-ci の件数は pending:2 なのに status は passed
const PASSED_BUT_PENDING = { status: 'passed', passed: 5, failed: 0, pending: 2, skipped: 0, failed_checks: [] };

async function runPrIterate(overrides) {
  const { ctx, calls } = makePrIterateSandbox({ overrides });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'ci-truth-routing pr-iterate');
  assert.equal(error, null, `pr-iterate run が throw した: ${error?.message}`);
  return { result, calls };
}

async function runDevFlow(overrides, workflow) {
  const { ctx, calls } = makeDevFlowSandbox({ overrides, workflow });
  const { result, error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'ci-truth-routing dev-flow');
  assert.equal(error, null, `dev-flow run が throw した: ${error?.message}`);
  return { result, calls };
}

// ---- (a) proxy の status と件数の食い違い → passed を採らない ----

test('[ci-truth] CI gate: ci-check が件数 pending:2 と status:"passed" を返したら lgtm に進まず ci_error で終端する', async () => {
  const { result, calls } = await runPrIterate({ 'ci-check#1': PASSED_BUT_PENDING });

  assert.notEqual(result?.status, 'lgtm', 'proxy の passed を採って lgtm に進んではならない');
  assert.equal(result?.status, 'ci_error');
  assert.equal(result?.ci_last_status, 'error');
  assert.equal(calls.filter((c) => c.label.startsWith('ci-wait-check#')).length, 0, 'error は待機ループへ進まない');
});

test('[ci-truth] CI gate: ci-wait-check（slept:true）が件数 pending:2 と status:"passed" を返しても lgtm に進まない', async () => {
  const { result } = await runPrIterate({
    'ci-check#1': { status: 'pending', passed: 5, failed: 0, pending: 2, skipped: 0, failed_checks: [] },
    'ci-wait-check#1.2': { slept: true, ...PASSED_BUT_PENDING },
  });

  assert.notEqual(result?.status, 'lgtm');
  assert.equal(result?.status, 'ci_error');
  assert.equal(result?.ci_last_status, 'error');
});

test('[ci-truth] CI gate: 件数の無い応答（転記欠落）も passed を採らず ci_error', async () => {
  const { result } = await runPrIterate({ 'ci-check#1': { status: 'passed', failed_checks: [] } });
  assert.equal(result?.status, 'ci_error');
});

test('[ci-truth] CI gate: 件数と一致する passed は従来どおり lgtm', async () => {
  const { result } = await runPrIterate({ 'ci-check#1': { status: 'passed', passed: 5, failed: 0, pending: 0, skipped: 1, failed_checks: [] } });
  assert.equal(result?.status, 'lgtm');
  assert.equal(result?.ci_last_status, 'passed');
});

test('[ci-truth] dev-flow lite route: ci-check-lite の status と件数が食い違えば lgtm 終端せず full pr-iterate へ委譲する', async () => {
  const launches = [];
  const workflow = async (name, args) => { launches.push({ name, args }); return { status: 'lgtm', iterations: 1, fixes_applied: 0 }; };
  const overrides = { ...shapeOverrides('micro'), 'ci-check-lite': { ...PASSED_BUT_PENDING, waited_seconds: 0, poll_attempts: 1 } };
  const { calls } = await runDevFlow(overrides, workflow);

  assert.ok(calls.some((c) => c.label === 'pr-review-lite'), `lite route を通っていない: ${calls.map((c) => c.label).join(', ')}`);
  assert.equal(launches.filter((l) => l.name === 'dev-flow:pr-iterate-run').length, 1, 'proxy の passed を採らず full pr-iterate へ委譲するべき');
});

// ---- (b)(c) Merge tier: checks の bucket で HOLD を決める ----

test('[ci-truth] Merge tier: checks に fail を含む facts で merge_tier=HOLD（ci_checks_failed）', async () => {
  const facts = mergeTierFacts({
    checks: [{ name: 'Bats Tests', bucket: 'fail' }, { name: 'Vitest', bucket: 'pass' }],
    pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', headRefOid: 'a'.repeat(40) },
  });
  const { result, calls } = await runDevFlow({ 'merge-tier-facts': facts });

  assert.equal(result?.merge_tier, 'HOLD');
  const hold = (result?.merge_tier_hold_reasons ?? []).find((r) => r.code === 'ci_checks_failed');
  assert.ok(hold, `merge_tier_hold_reasons に ci_checks_failed が無い: ${JSON.stringify(result?.merge_tier_hold_reasons)}`);
  assert.equal(hold.kind, 'human_judgment');
  const summary = calls.find((c) => c.label === 'post-summary');
  assert.ok(summary?.prompt.includes('Bats Tests'), '終端サマリの HOLD 理由に失敗した check 名が載るべき');
});

for (const [name, checks, pr] of [
  ['全 pass', [{ name: 'Bats Tests', bucket: 'pass' }, { name: 'docs', bucket: 'skipping' }], undefined],
  ['pending（mergeStateStatus=UNSTABLE）', [{ name: 'Bats Tests', bucket: 'pending' }, { name: 'Vitest', bucket: 'pass' }], { mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', headRefOid: 'a'.repeat(40) }],
  ['取得失敗', null, undefined],
]) {
  test(`[ci-truth] Merge tier: checks が${name}なら HOLD にならない`, async () => {
    const facts = mergeTierFacts({ checks, ...(pr ? { pr } : {}) });
    const { result, calls } = await runDevFlow({ 'merge-tier-facts': facts });

    assert.notEqual(result?.merge_tier, 'HOLD', `HOLD reasons: ${JSON.stringify(result?.merge_tier_hold_reasons)}`);
    const summary = calls.find((c) => c.label === 'post-summary');
    assert.ok(summary, 'post-summary が dispatch されていない');
    assert.equal(summary.prompt.includes('CI 未完了'), checks === null || name.startsWith('pending'), `終端サマリの「CI 未完了」表示が想定と異なる（${name}）`);
  });
}
