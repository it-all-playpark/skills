// isolation probe の Setup phase 配線を検証する VM 挙動テスト（issue #636: source-regex 走査から
// vm-sandbox（agent() mock）による挙動検証へ移行。issue #641: Setup phase が args.setup 駆動になり
// setup-base/worktree/isolation-cleanup/worktree-deps の 4 spawn が撤去されたため、isolation-probe
// 単独の配線検証へ縮小した）。純関数（isolationProbePrompt/isolationFailureMessage）自体は
// _lib/isolation-probe.test.mjs で直接 import してテストする。本ファイルは dev-flow.js の Setup
// phase がそれらを正しく呼び出し・分岐しているかの配線のみを検証する。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runDevFlowInSandbox, makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs } from './test-helpers/vm-sandbox.mjs';

const devFlowPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

function schemaOf(calls, label) {
  const call = calls.find((c) => c.label === label);
  assert.ok(call, `label '${label}' の call が見つからない`);
  return JSON.parse(JSON.stringify(call.opts.schema));
}

test('Setup phase（analyze 系 label より前）の call は isolation-probe 1 件のみ', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  await runDevFlowInSandbox(src, ctx);

  const analyzeIdx = calls.findIndex((c) => c.label.startsWith('analyze') || c.label.startsWith('contract-probe'));
  assert.notStrictEqual(analyzeIdx, -1, 'analyze 系 call が見つからない');
  const beforeAnalyze = calls.slice(0, analyzeIdx);
  assert.deepEqual(
    beforeAnalyze.map((c) => c.label),
    ['isolation-probe'],
    `Setup phase の call は isolation-probe 1 件のみのはずだが: ${JSON.stringify(beforeAnalyze.map((c) => c.label))}`,
  );
});

test('isolation-probe call の agentType/opts.phase/schema が期待どおり（dev-runner-haiku-wo・Setup・required:[written]）', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  await runDevFlowInSandbox(src, ctx);

  const call = calls.find((c) => c.label === 'isolation-probe');
  assert.ok(call, "label 'isolation-probe' の call が見つからない");
  assert.equal(call.agentType, 'dev-flow:dev-runner-haiku-wo');
  assert.equal(call.opts.phase, 'Setup');

  const schema = schemaOf(calls, 'isolation-probe');
  assert.deepEqual(schema.required, ['written']);
  assert.equal(schema.properties.written.type, 'boolean');
});

test('[fail-closed] isolation-probe が written:false を返すと throw し、message に dev-flow-run / dev-flow-prerun / EnterWorktree を含み Plan phase に到達しない', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: { 'isolation-probe': { written: false, error: 'denied' } },
  });
  const error = await runDevFlowInSandbox(src, ctx);

  assert.ok(error, 'written:false のとき throw されるべき');
  assert.match(error.message, /dev-flow-run/);
  assert.match(error.message, /dev-flow-prerun --issue 1/);
  assert.match(error.message, /EnterWorktree/);
  assert.ok(
    !calls.some((c) => c.label === 'impl:serial:issue-1' || c.agentType === 'dev-flow:dev-implement-fable'),
    'Setup phase で throw した時点で Implement phase（dev-implement-fable 呼び出し）に到達してはならない',
  );
});

test('[fail-open] isolation-probe が null（agent 自体の失敗）でも run は完走する', async () => {
  const { ctx } = makeDevFlowSandbox({ overrides: { 'isolation-probe': null } });
  const error = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, 'isolation-probe が null でも run は完走するべき（fail-open）');
});

// ── issue #641: isoToken の給電元は args.setup.epoch（dev-flow-prerun の date +%s）に一本化されている ──

function findIsolationProbeCall(calls) {
  return calls.find((c) => c.label === 'isolation-probe');
}

test('[isoToken 給電] args.setup.epoch が 1234 のとき、isolation-probe prompt に .isolation-probe-1234 が含まれる', async () => {
  const { ctx, calls } = makeDevFlowSandbox({ extra: { args: devFlowArgs(1, { epoch: 1234 }) } });
  await runDevFlowInSandbox(src, ctx);

  const probeCall = findIsolationProbeCall(calls);
  assert.ok(probeCall, 'isolation-probe の agent() 呼び出しが記録されていない');
  assert.match(
    probeCall.prompt,
    /\.isolation-probe-1234/,
    `isolation-probe prompt に .isolation-probe-1234 が含まれるべきだが含まれていなかった: ${probeCall.prompt}`,
  );
});

// ── issue #641: start mark の epoch 供給元は args.setup.epoch（VM 挙動で観測）──
// args.setup.epoch と post-summary の epoch の差が duration_seconds として telemetry に現れることで、
// start mark が args.setup.epoch から給電されていることを検証する。

test('[epoch 供給元] start mark は args.setup.epoch から給電され duration_seconds = post-summary.epoch - args.setup.epoch になる', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    extra: { args: devFlowArgs(1, { epoch: 5000 }) },
    overrides: {
      'post-summary': { posted: true, method: 'gh', url: 'http://x', epoch: 5300 },
    },
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'epoch-source');
  const save = calls.find((c) => c.label === 'journal-save');
  assert.ok(save, 'journal-save が呼ばれていない');
  assert.ok(
    save.prompt.includes('"duration_seconds":300'),
    `duration_seconds は args.setup.epoch(5000)→post-summary(5300) の 300 のはず:\n${save.prompt.slice(0, 900)}`,
  );
});
