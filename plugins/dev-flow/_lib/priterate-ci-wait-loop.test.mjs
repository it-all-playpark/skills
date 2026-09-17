// F2 (issue #663): pr-iterate.js の CI gate を script 側 poll ループへ置き換えたことの検証（TDD）。
//
// AC-2: CI 待ちが script 側ループで、総待機の上限が定数 CI_WAIT_CEILING_SECONDS（既定 300）で決まる。
// AC-3: telemetry ci_wait_seconds / ci_poll_attempts が script 側積算で現行と同じキー・意味で
//   handoff（journal-save prompt / return 値）に載る。
// AC-4: ceiling 到達時は ci_pending 終端（ci_error にならない）。CI failed は現行どおり fix loop へ。
// AC-1: ci-check exec-proxy の prompt に attempt ループ・sleep 指示が無く、1 spawn で 1 回の判定だけを返す。
//
// base（script 側ループ導入前）では: ci-check#1 が pending を返すと即座に status:'pending' 分岐で
// ci_pending 終端していたため ci-wait#* が一度も dispatch されず、test 1/2/3 が red になる。
// test 5 は base では agent 報告の waited_seconds/poll_attempts をそのまま積算していたため red になる。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const prIteratePath = join(here, '..', '.claude', 'workflows', 'pr-iterate.js');
const src = readFileSync(prIteratePath, 'utf8');

async function run(overrides) {
  const { ctx, calls } = makePrIterateSandbox({ overrides });
  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'priterate-ci-wait-loop');
  return { result, error, calls };
}

test('[ci-wait-loop] pending → passed: ci-check#1 が pending、ci-wait#1-1 を挟んで ci-check#1.2 が passed → lgtm、ci_wait_seconds=45 / ci_poll_attempts=2', async () => {
  const { result, error, calls } = await run({
    'ci-check#1': { status: 'pending', failed_checks: [] },
    'ci-check#1.2': { status: 'passed', failed_checks: [] },
    'ci-wait#1-1': { slept: true, seconds: 45 },
  });

  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result?.status, 'lgtm', `pending→passed で lgtm へ進むべきだが '${result?.status}' だった`);
  assert.equal(result?.ci_wait_seconds, 45, `ci_wait_seconds は 45 であるべきだが ${result?.ci_wait_seconds} だった`);
  assert.equal(result?.ci_poll_attempts, 2, `ci_poll_attempts は 2 であるべきだが ${result?.ci_poll_attempts} だった`);

  const wait1 = calls.find((c) => c.label === 'ci-wait#1-1');
  assert.ok(wait1 != null, "label==='ci-wait#1-1' の呼び出しが存在するべき");
  assert.equal(wait1.agentType, 'dev-flow:dev-runner-haiku-ro', `ci-wait#1-1 の agentType が想定と異なる: ${wait1.agentType}`);
  assert.ok(wait1.prompt.includes('`sleep 45`'), `ci-wait#1-1 の prompt に \`sleep 45\` が含まれるべき。prompt: ${wait1.prompt.slice(0, 500)}`);
  assert.ok(!wait1.prompt.includes('check-ci'), `ci-wait#1-1 の prompt に check-ci が含まれるべきでない。prompt: ${wait1.prompt.slice(0, 500)}`);

  const journalCall = calls.find((c) => c.label === 'journal-save');
  assert.ok(journalCall != null, "label==='journal-save' の呼び出しが存在するべき");
  assert.ok(journalCall.prompt.includes('"ci_wait_seconds":45'), `journal-save prompt に "ci_wait_seconds":45 が含まれるべき。prompt: ${journalCall.prompt.slice(0, 1000)}`);
  assert.ok(journalCall.prompt.includes('"ci_poll_attempts":2'), `journal-save prompt に "ci_poll_attempts":2 が含まれるべき。prompt: ${journalCall.prompt.slice(0, 1000)}`);
});

test('[ci-wait-loop] ceiling: 常に pending なら ci-wait 6 回 / ci-check 7 回で ci_pending 終端（ci_error にならない）、ci_wait_seconds=270 / ci_poll_attempts=7', async () => {
  const overrides = {};
  for (let k = 1; k <= 7; k++) {
    overrides[k === 1 ? 'ci-check#1' : `ci-check#1.${k}`] = { status: 'pending', failed_checks: [] };
  }
  for (let k = 1; k <= 6; k++) {
    overrides[`ci-wait#1-${k}`] = { slept: true, seconds: 45 };
  }

  const { result, error, calls } = await run(overrides);

  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result?.status, 'ci_pending', `ceiling 到達で ci_pending 終端すべきだが '${result?.status}' だった`);
  assert.notEqual(result?.status, 'ci_error', 'ceiling 到達は ci_error であってはならない');
  assert.equal(result?.ci_wait_seconds, 270, `ci_wait_seconds は 270 であるべきだが ${result?.ci_wait_seconds} だった`);
  assert.equal(result?.ci_poll_attempts, 7, `ci_poll_attempts は 7 であるべきだが ${result?.ci_poll_attempts} だった`);

  const ciCheckCalls = calls.filter((c) => c.label.startsWith('ci-check#'));
  const ciWaitCalls = calls.filter((c) => c.label.startsWith('ci-wait#'));
  assert.equal(ciCheckCalls.length, 7, `ci-check# 呼び出しは 7 回であるべきだが ${ciCheckCalls.length} 回だった`);
  assert.equal(ciWaitCalls.length, 6, `ci-wait# 呼び出しは 6 回であるべきだが ${ciWaitCalls.length} 回だった`);
});

test('[ci-wait-loop] ci-wait が null / throw でも nominal 積算され有界で終端する', async () => {
  const overrides = {
    'ci-wait#1-1': () => { throw new Error('injected'); },
  };
  for (let k = 1; k <= 7; k++) {
    overrides[k === 1 ? 'ci-check#1' : `ci-check#1.${k}`] = { status: 'pending', failed_checks: [] };
  }

  const { result, error } = await run(overrides);

  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result?.status, 'ci_pending', `ceiling 到達で ci_pending 終端すべきだが '${result?.status}' だった`);
  assert.equal(result?.ci_poll_attempts, 7, `ci_poll_attempts は 7 であるべきだが ${result?.ci_poll_attempts} だった`);
  assert.equal(result?.ci_wait_seconds, 270, `ci_wait_seconds は 270 であるべきだが ${result?.ci_wait_seconds} だった`);
});

test('[ci-wait-loop] failed は待たずに即 fix loop へ（ci-wait 0 回）', async () => {
  const { result, error, calls } = await run({
    'ci-check#1': { status: 'failed', failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }] },
    'ci-check#2': { status: 'passed', failed_checks: [] },
  });

  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result?.status, 'lgtm', `failed→fix→passed で lgtm へ進むべきだが '${result?.status}' だった`);
  assert.equal(result?.iterations, 2, `2 iteration で終端するべきだが ${result?.iterations} だった`);

  const ciWaitCalls = calls.filter((c) => c.label.startsWith('ci-wait#'));
  assert.equal(ciWaitCalls.length, 0, `failed 応答直後は ci-wait を挟まないべきだが ${ciWaitCalls.length} 回呼ばれた`);
  assert.equal(result?.ci_wait_seconds, 0, `ci_wait_seconds は 0 であるべきだが ${result?.ci_wait_seconds} だった`);
  assert.equal(result?.ci_poll_attempts, 2, `ci_poll_attempts は 2 であるべきだが ${result?.ci_poll_attempts} だった`);
});

test('[ci-wait-loop] ci-check の agent 報告値 waited_seconds/poll_attempts は積算に使われない（script 側積算）', async () => {
  const { result, error } = await run({
    'ci-check#1': { status: 'passed', failed_checks: [], waited_seconds: 999, poll_attempts: 99 },
  });

  assert.equal(error, null, `run が throw した: ${error?.message}`);
  assert.equal(result?.ci_wait_seconds, 0, `agent 報告値 999 を無視し script 側積算 0 であるべきだが ${result?.ci_wait_seconds} だった`);
  assert.equal(result?.ci_poll_attempts, 1, `agent 報告値 99 を無視し script 側積算 1 であるべきだが ${result?.ci_poll_attempts} だった`);
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
