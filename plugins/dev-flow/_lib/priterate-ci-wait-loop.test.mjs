// pr-iterate.js の CI gate が script 側 poll ループで、2 回目以降の poll を待機 + 判定の 1 spawn
// （ci-wait-check）で行うことの検証（issue #663 / #805）。
//
// - CI 待ちが script 側ループで、総待機の上限が定数 CI_WAIT_CEILING_SECONDS（既定 300）で決まる。
// - ci_wait_seconds / ci_poll_attempts が script 側積算で現行と同じキー・意味（(N-1)×M / N）で return 値に載る。
// - ceiling 到達時は ci_pending 終端（ci_error にならない）。CI failed は現行どおり fix loop へ。
// - 1 回目の poll は ci-check 単体（待機なし）、2 回目以降は `ci-wait <秒>` → gh pr checks → check-ci を
//   1 spawn（dev-runner-haiku-ro）で行い、独立した ci-wait spawn は無い。
// - ci-wait-check の slept !== true（slept:false / null / throw）は積算せず、同じ応答の status も採らずに
//   ci_pending で終端する。
// - ci-check exec-proxy の prompt に attempt ループ・sleep 指示が無く、1 spawn で 1 回の判定だけを返す。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';
import { CI_WAIT_CHECK, ciWaitCheckPrompt } from './ci-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const prIteratePath = join(here, '..', '.claude', 'workflows', 'pr-iterate.js');
const src = readFileSync(prIteratePath, 'utf8');

async function run(overrides) {
  const { ctx, calls } = makePrIterateSandbox({ overrides });
  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'priterate-ci-wait-loop');
  return { result, error, calls };
}

const waitedPending = { slept: true, status: 'pending', passed: 0, failed: 0, pending: 1, skipped: 0, failed_checks: [] };

test('[ci-wait-loop] pending → passed: ci-check#1 が pending、ci-wait-check#1.2（待機 + 判定の 1 spawn）が passed → lgtm、ci_wait_seconds=45 / ci_poll_attempts=2', async () => {
  const { result, error, calls } = await run({
    'ci-check#1': { status: 'pending', passed: 0, failed: 0, pending: 1, skipped: 0, failed_checks: [] },
    'ci-wait-check#1.2': { slept: true, status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] },
  });

  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result?.status, 'lgtm', `pending→passed で lgtm へ進むべきだが '${result?.status}' だった`);
  assert.equal(result?.ci_wait_seconds, 45, `ci_wait_seconds は 45 であるべきだが ${result?.ci_wait_seconds} だった`);
  assert.equal(result?.ci_poll_attempts, 2, `ci_poll_attempts は 2 であるべきだが ${result?.ci_poll_attempts} だった`);

  const ciCheck1 = calls.find((c) => c.label === 'ci-check#1');
  assert.ok(ciCheck1 != null, "1 回目の poll は label==='ci-check#1' の ci-check 単体であるべき");
  assert.ok(!ciCheck1.prompt.includes('ci-wait'), `1 回目の poll（ci-check#1）は待機しないべき。prompt: ${ciCheck1.prompt.slice(0, 500)}`);

  const wc = calls.find((c) => c.label === 'ci-wait-check#1.2');
  assert.ok(wc != null, "label==='ci-wait-check#1.2' の呼び出しが存在するべき");
  assert.equal(wc.agentType, 'dev-flow:dev-runner-haiku-ro', `ci-wait-check#1.2 の agentType が想定と異なる: ${wc.agentType}`);
  assert.equal(wc.prompt, ciWaitCheckPrompt({ pr: 5, repo: 'acme/skills', seconds: 45 }), 'ci-wait-check の呼び出し側は canonical の ciWaitCheckPrompt() をそのまま使うべき');
  assert.equal(JSON.stringify(wc.schema), JSON.stringify(CI_WAIT_CHECK), 'ci-wait-check の schema は canonical の CI_WAIT_CHECK であるべき');
  const iWait = wc.prompt.indexOf('`ci-wait 45`');
  const iGh = wc.prompt.indexOf('`gh pr checks 5 --repo acme/skills --json name,state,bucket`');
  const iCheck = wc.prompt.indexOf('`check-ci --checks-data');
  assert.ok(iWait >= 0 && iGh > iWait && iCheck > iGh, `1 spawn 内で ci-wait → gh pr checks → check-ci の順に実行させるべき。prompt: ${wc.prompt.slice(0, 900)}`);

  assert.equal(calls.filter((c) => c.label.startsWith('ci-wait#')).length, 0, '独立した ci-wait spawn を出さないべき');
});

test('[ci-wait-loop] ceiling: 常に pending なら ci-check 1 回 + ci-wait-check 6 回で ci_pending 終端（ci_error にならない）、ci_wait_seconds=270 / ci_poll_attempts=7', async () => {
  const overrides = { 'ci-check#1': { status: 'pending', passed: 0, failed: 0, pending: 1, skipped: 0, failed_checks: [] } };
  for (let k = 2; k <= 7; k++) overrides[`ci-wait-check#1.${k}`] = waitedPending;

  const { result, error, calls } = await run(overrides);

  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result?.status, 'ci_pending', `ceiling 到達で ci_pending 終端すべきだが '${result?.status}' だった`);
  assert.notEqual(result?.status, 'ci_error', 'ceiling 到達は ci_error であってはならない');
  assert.equal(result?.ci_wait_seconds, 270, `ci_wait_seconds は 270 であるべきだが ${result?.ci_wait_seconds} だった`);
  assert.equal(result?.ci_poll_attempts, 7, `ci_poll_attempts は 7 であるべきだが ${result?.ci_poll_attempts} だった`);

  const ciCheckCalls = calls.filter((c) => c.label.startsWith('ci-check#'));
  const waitCheckCalls = calls.filter((c) => c.label.startsWith('ci-wait-check#'));
  assert.equal(ciCheckCalls.length, 1, `ci-check# 呼び出しは 1 回目の poll だけであるべきだが ${ciCheckCalls.length} 回だった`);
  assert.equal(waitCheckCalls.length, 6, `ci-wait-check# 呼び出しは 6 回であるべきだが ${waitCheckCalls.length} 回だった`);
  assert.equal(ciCheckCalls.length + waitCheckCalls.length, 7, 'poll 1 回 = spawn 1 本（判定 spawn 合計は CI_MAX_POLLS=7）');
});

for (const [name, response] of [
  ['throw', () => { throw new Error('injected'); }],
  ['null', null],
  ['slept:false', { slept: false, status: 'pending' }],
  ['slept:false なのに status=passed', { slept: false, status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] }],
]) {
  test(`[ci-wait-loop] ci-wait-check が ${name} なら nominal 加算せず、その判定も採らずに即 ci_pending 終端する`, async () => {
    const { result, error, calls } = await run({
      'ci-check#1': { status: 'pending', passed: 0, failed: 0, pending: 1, skipped: 0, failed_checks: [] },
      'ci-wait-check#1.2': response,
    });

    assert.equal(error, null, `run が throw した: ${error?.message}`);
    assert.equal(result?.status, 'ci_pending', `実待機不成立で ci_pending 終端すべきだが '${result?.status}' だった`);
    assert.equal(result?.ci_wait_seconds, 0, `ci_wait_seconds は 0（実待機不成立を nominal 加算で隠さない）であるべきだが ${result?.ci_wait_seconds} だった`);
    assert.equal(result?.ci_poll_attempts, 1, `ci_poll_attempts は 1（ci-check#1 のみで打ち切り）であるべきだが ${result?.ci_poll_attempts} だった`);

    const waitCheckCalls = calls.filter((c) => c.label.startsWith('ci-wait-check#'));
    assert.equal(waitCheckCalls.length, 1, `実待機不成立の直後に打ち切り ci-wait-check は 1 回であるべきだが ${waitCheckCalls.length} 回だった`);
  });
}

test('[ci-wait-loop] ci-wait-check が slept:true かつ error なら従来どおり ci_error で終端し、待機は積算する', async () => {
  const { result, error } = await run({
    'ci-check#1': { status: 'pending', passed: 0, failed: 0, pending: 1, skipped: 0, failed_checks: [] },
    'ci-wait-check#1.2': { slept: true, status: 'error', failed_checks: [] },
  });

  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result?.status, 'ci_error', `slept:true の error 判定は ci_error であるべきだが '${result?.status}' だった`);
  assert.equal(result?.ci_wait_seconds, 45);
  assert.equal(result?.ci_poll_attempts, 2);
});

test('[ci-wait-loop] failed は待たずに即 fix loop へ（ci-wait-check 0 回）', async () => {
  const { result, error, calls } = await run({
    'ci-check#1': { status: 'failed', passed: 0, failed: 1, pending: 0, skipped: 0, failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }] },
    'ci-check#2': { status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [] },
  });

  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result?.status, 'lgtm', `failed→fix→passed で lgtm へ進むべきだが '${result?.status}' だった`);
  assert.equal(result?.iterations, 2, `2 iteration で終端するべきだが ${result?.iterations} だった`);

  const waitCheckCalls = calls.filter((c) => c.label.startsWith('ci-wait-check#'));
  assert.equal(waitCheckCalls.length, 0, `failed 応答直後は待機を挟まないべきだが ${waitCheckCalls.length} 回呼ばれた`);
  assert.equal(result?.ci_wait_seconds, 0, `ci_wait_seconds は 0 であるべきだが ${result?.ci_wait_seconds} だった`);
  assert.equal(result?.ci_poll_attempts, 2, `ci_poll_attempts は 2 であるべきだが ${result?.ci_poll_attempts} だった`);
});

test('[ci-wait-loop] agent 報告値 waited_seconds/poll_attempts は積算に使われない（script 側積算）', async () => {
  const { result, error } = await run({
    'ci-check#1': { status: 'pending', passed: 0, failed: 0, pending: 1, skipped: 0, failed_checks: [], waited_seconds: 999, poll_attempts: 99 },
    'ci-wait-check#1.2': { slept: true, status: 'passed', passed: 1, failed: 0, pending: 0, skipped: 0, failed_checks: [], waited_seconds: 888, poll_attempts: 88 },
  });

  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result?.ci_wait_seconds, 45, `agent 報告値を無視し script 側積算 45 であるべきだが ${result?.ci_wait_seconds} だった`);
  assert.equal(result?.ci_poll_attempts, 2, `agent 報告値を無視し script 側積算 2 であるべきだが ${result?.ci_poll_attempts} だった`);
});

test('[ci-wait-loop] ci-check prompt にループ・sleep 指示が無い（dispatch された prompt で観測）', async () => {
  const { calls, error } = await run({});
  assert.equal(error, null, `run が throw した: ${error?.message}`);

  const ciCheck1 = calls.find((c) => c.label === 'ci-check#1');
  assert.ok(ciCheck1 != null, "label==='ci-check#1' の呼び出しが存在するべき");
  assert.ok(!/\battempt\b/i.test(ciCheck1.prompt), `ci-check#1 の prompt に attempt 語が含まれるべきでない。prompt: ${ciCheck1.prompt.slice(0, 900)}`);
  assert.ok(!ciCheck1.prompt.includes('--max-attempts'), `ci-check#1 の prompt に --max-attempts が含まれるべきでない。prompt: ${ciCheck1.prompt.slice(0, 900)}`);
  assert.ok(!ciCheck1.prompt.includes('--poll-seconds'), `ci-check#1 の prompt に --poll-seconds が含まれるべきでない。prompt: ${ciCheck1.prompt.slice(0, 900)}`);
  assert.ok(!/\bsleep\b/i.test(ciCheck1.prompt), `ci-check#1 の prompt に sleep 指示が含まれるべきでない。prompt: ${ciCheck1.prompt.slice(0, 900)}`);
  assert.ok(!ciCheck1.prompt.includes('繰り返'), `ci-check#1 の prompt に繰り返し指示が含まれるべきでない。prompt: ${ciCheck1.prompt.slice(0, 900)}`);
});
