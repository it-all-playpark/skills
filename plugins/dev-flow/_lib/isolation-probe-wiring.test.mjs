// isolation probe の Setup phase 配線を検証する VM 挙動テスト（issue #636: source-regex 走査から
// vm-sandbox（agent() mock）による挙動検証へ移行）。純関数（isolationProbePrompt/isolationFailureMessage）
// 自体は _lib/isolation-probe.test.mjs で直接 import してテストする。本ファイルは dev-flow.js の Setup
// phase がそれらを正しく呼び出し・分岐しているかの配線のみを検証する。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeRecordingSandbox, runDevFlowInSandbox, makeDevFlowSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const devFlowPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

function schemaOf(calls, label) {
  const call = calls.find((c) => c.label === label);
  assert.ok(call, `label '${label}' の call が見つからない`);
  return JSON.parse(JSON.stringify(call.opts.schema));
}

test('Setup の call 順序が worktree < isolation-cleanup < isolation-probe < worktree-deps', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  await runDevFlowInSandbox(src, ctx);

  const idx = (label) => calls.findIndex((c) => c.label === label);
  const iWorktree = idx('worktree');
  const iCleanup = idx('isolation-cleanup');
  const iProbe = idx('isolation-probe');
  const iDeps = idx('worktree-deps');

  assert.notStrictEqual(iWorktree, -1, "label 'worktree' の call が見つからない");
  assert.notStrictEqual(iCleanup, -1, "label 'isolation-cleanup' の call が見つからない");
  assert.notStrictEqual(iProbe, -1, "label 'isolation-probe' の call が見つからない");
  assert.notStrictEqual(iDeps, -1, "label 'worktree-deps' の call が見つからない");
  assert.ok(iWorktree < iCleanup, 'worktree は isolation-cleanup より前でなければならない');
  assert.ok(iCleanup < iProbe, 'isolation-cleanup は isolation-probe より前でなければならない（早期除去）');
  assert.ok(iProbe < iDeps, 'isolation-probe は worktree-deps より前でなければならない（早期検知）');
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

test('isolation-cleanup call の agentType/schema が期待どおり（dev-runner-haiku・required:[cleaned]）', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  await runDevFlowInSandbox(src, ctx);

  const call = calls.find((c) => c.label === 'isolation-cleanup');
  assert.ok(call, "label 'isolation-cleanup' の call が見つからない");
  assert.equal(call.agentType, 'dev-flow:dev-runner-haiku');

  const schema = schemaOf(calls, 'isolation-cleanup');
  assert.deepEqual(schema.required, ['cleaned']);
});

test('isolation-cleanup prompt が git -C <worktree> clean -fdx -- .devflow-tmp を含む', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  await runDevFlowInSandbox(src, ctx);

  const call = calls.find((c) => c.label === 'isolation-cleanup');
  assert.ok(call, "label 'isolation-cleanup' の call が見つからない");
  assert.match(call.prompt, /git -C \/tmp\/wt clean -fdx -- \.devflow-tmp/);
});

test('[fail-closed] isolation-probe が written:false を返すと throw し、message に dev-flow-run / args / EnterWorktree を含み Plan phase に到達しない', async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: { 'isolation-probe': { written: false, error: 'denied' } },
  });
  const error = await runDevFlowInSandbox(src, ctx);

  assert.ok(error, 'written:false のとき throw されるべき');
  assert.match(error.message, /dev-flow-run/);
  assert.match(error.message, /args: "1"/);
  assert.match(error.message, /EnterWorktree/);
  assert.ok(
    !calls.some((c) => c.label === 'plan#1' || c.agentType === 'dev-flow:dev-planner'),
    'Setup phase で throw した時点で Plan phase（dev-planner 呼び出し）に到達してはならない',
  );
});

test('[fail-open] isolation-probe が null（agent 自体の失敗）でも run は完走する', async () => {
  const { ctx } = makeDevFlowSandbox({ overrides: { 'isolation-probe': null } });
  const error = await runDevFlowInSandbox(src, ctx);
  assert.equal(error, null, 'isolation-probe が null でも run は完走するべき（fail-open）');
});

test('[fail-open] isolation-cleanup が失敗（cleaned:false / null）でも isolation-probe は 1 回呼ばれ run は完走する', async () => {
  for (const cleanupOverride of [{ cleaned: false }, null]) {
    const { ctx, calls } = makeDevFlowSandbox({
      overrides: { 'isolation-cleanup': cleanupOverride },
    });
    const error = await runDevFlowInSandbox(src, ctx);
    assert.equal(error, null, 'isolation-cleanup 失敗でも run は完走するべき（fail-open）');
    const probeCalls = calls.filter((c) => c.label === 'isolation-probe');
    assert.equal(probeCalls.length, 1, 'isolation-probe は 1 回呼ばれるべき');
  }
});

test('Setup の worktree prompt は trust-test-latest.json / trust-risk-*.json を含まない（負 pin、cleanup へ移譲済み）', async () => {
  const { ctx, calls } = makeDevFlowSandbox();
  await runDevFlowInSandbox(src, ctx);

  const call = calls.find((c) => c.label === 'worktree');
  assert.ok(call, "label 'worktree' の call が見つからない");
  assert.doesNotMatch(call.prompt, /trust-test-latest\.json/);
  assert.doesNotMatch(call.prompt, /trust-risk-/);
});

// ── issue #550 案1+案2: isoToken の epoch 供給元が setup-base（resolve-base + worktree-base-check
// 統合 probe）に一本化されていることを VM sandbox 実行で pin する。
// AC「案1+案2を両方採用する場合: epoch の供給元が統合後の probe に一本化されており、isoToken が
// run 毎に一意であることをテストで pin する（供給元が二重化・不定にならないこと）」に対応。

function findIsolationProbeCall(calls) {
  return calls.find((c) => c.label === 'isolation-probe');
}

test('[isoToken 給電] setup-base probe が epoch:1234 を返すとき、isolation-probe prompt に .isolation-probe-1234 が含まれる', async () => {
  const responder = ({ label }) => {
    if (label === 'setup-base') {
      return {
        ok: true, default_branch: 'main', dev_exists: true, requested_exists: false,
        worktree_exists: false, upstream_remote: '', upstream_merge: '', epoch: 1234,
      };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    }
    return undefined;
  };
  const { ctx, calls } = makeRecordingSandbox(responder);
  await runDevFlowInSandbox(src, ctx);

  const probeCall = findIsolationProbeCall(calls);
  assert.ok(probeCall, 'isolation-probe の agent() 呼び出しが記録されていない');
  assert.match(
    probeCall.prompt,
    /\.isolation-probe-1234/,
    `isolation-probe prompt に .isolation-probe-1234 が含まれるべきだが含まれていなかった: ${probeCall.prompt}`,
  );
});

test('[isoToken 給電 fallback] setup-base probe が epoch を欠く（fail-open）とき、isolation-probe prompt は ISSUE（.isolation-probe-1）へ fallback する', async () => {
  const responder = ({ label }) => {
    if (label === 'setup-base') {
      return {
        ok: true, default_branch: 'main', dev_exists: true, requested_exists: false,
        worktree_exists: false, upstream_remote: '', upstream_merge: '',
      };
    }
    if (label === 'worktree') {
      return { worktree: '/tmp/wt', branch: 'feature/issue-1', repo: 'acme/skills' };
    }
    return undefined;
  };
  const { ctx, calls } = makeRecordingSandbox(responder);
  await runDevFlowInSandbox(src, ctx);

  const probeCall = findIsolationProbeCall(calls);
  assert.ok(probeCall, 'isolation-probe の agent() 呼び出しが記録されていない');
  assert.match(
    probeCall.prompt,
    /\.isolation-probe-1(?!\d)/,
    `epoch 欠落時は isolation-probe prompt が ISSUE（1）へ fallback するべきだが含まれていなかった: ${probeCall.prompt}`,
  );
});

// ── issue #550 案1+案2: start mark の epoch 供給元は setup-base probe（VM 挙動で観測）──
// setup-base の epoch と post-summary の epoch の差が duration_seconds として telemetry に現れることで、
// start mark が setup-base probe の epoch から給電されていることを検証する（issue #636: 「feedClockMark('start'
// の呼び出しが 1 箇所」というソース pin から置換。別の給電元が start を上書きすれば差が変わり落ちる）。

test("[epoch 供給元] start mark は setup-base probe の epoch から給電され duration_seconds = post-summary.epoch - setup-base.epoch になる", async () => {
  const { ctx, calls } = makeDevFlowSandbox({
    overrides: {
      'setup-base': {
        ok: true, default_branch: 'main', dev_exists: true, requested_exists: false,
        worktree_exists: false, upstream_remote: '', upstream_merge: '', epoch: 5000,
      },
      'worktree': { worktree: '/tmp/wt', branch: 'feature/issue-1', epoch: 7777 },
      'post-summary': { posted: true, method: 'gh', url: 'http://x', epoch: 5300 },
    },
  });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'epoch-source');
  const save = calls.find((c) => c.label === 'journal-save');
  assert.ok(save, 'journal-save が呼ばれていない');
  assert.ok(
    save.prompt.includes('"duration_seconds":300'),
    `duration_seconds は setup-base(5000)→post-summary(5300) の 300 のはず（worktree の epoch 7777 を start に使っていない）:\n${save.prompt.slice(0, 900)}`,
  );
});
