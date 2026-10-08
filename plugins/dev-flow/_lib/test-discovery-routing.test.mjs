// evaluator prompt の test_files 受理条件（test_discovery）は args.setup.stack.test_runners（prerun が
// detect-test-runner.sh で判定した、redgreen-verify と同じ判定元）から注入する（issue #880）。
// dev-flow.js を VM で実行し、eval#1 の prompt に判定結果が verbatim で載り、固定の受理 glob が載らないことを観測する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, devFlowArgs } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

async function evalPrompt(testRunners, name) {
  const { ctx, calls } = makeDevFlowSandbox({ extra: { args: devFlowArgs(1, { stack: { frameworks: [], test_runners: testRunners } }) } });
  const { error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, name);
  const ev = calls.find((c) => c.label === 'eval#1');
  assert.ok(ev, 'eval#1 が呼ばれていない');
  return ev.prompt;
}

test('[test-discovery] eval#1 prompt に stack.test_runners の受理パターンが注入され、固定の 4 glob は載らない', async () => {
  const runners = [
    { runner: 'pytest', accept: ['test_*.py', '*_test.py'], exclude: [], command: 'uv run pytest <files>' },
    { runner: 'go', accept: ['*_test.go'], exclude: [], command: 'go test ./<dir>' },
    { runner: 'bats', accept: ['*.bats'], exclude: [], command: 'bats <files>' },
  ];
  const prompt = await evalPrompt(runners, 'pytest-go');
  assert.ok(prompt.includes('test_discovery（'));
  assert.ok(prompt.includes(JSON.stringify(runners)), 'test_runners が verbatim で載っていない');
  for (const g of ['*.test.mjs', '*.test.ts', '*.test.tsx']) {
    assert.ok(!prompt.includes(g), `eval#1 prompt に固定 glob ${g} が載っている`);
  }
});

test('[test-discovery] stack.test_runners が空なら eval#1 prompt は test_files を挙げず inspection にさせる', async () => {
  const prompt = await evalPrompt([], 'none');
  assert.ok(prompt.includes('test_discovery（'));
  assert.ok(prompt.includes('ランナー検出なし'));
});
