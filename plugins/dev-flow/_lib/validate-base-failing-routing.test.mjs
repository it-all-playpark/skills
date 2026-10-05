// validate-base-failing-routing: Validate のテスト失敗を「diff と無関係で base でも同じように落ちる既存の失敗（ENV）」と
// green-fix の対象に分ける経路を VM sandbox で検証する（_lib/base-failure-triage.mjs の配線）。
//
//   (a) diff と無関係で base でも同じように落ちる → ENV。green-fix を起動せず green で先へ進み、
//       ledger の ENV-BASE-FAILING（advisory）と終端サマリーの「base でも失敗する既存の失敗」に載る
//   (b) diff が触ったテストファイル / テスト対象のソースが diff にある → base 再実行せず green-fix
//   (c) base では通る（base_failed:false）→ green-fix
//   (d) 一部だけ ENV → 残りを green-fix に回し、ENV のファイルは prompt で触るなと伝える。次の iteration で
//       ENV のファイルだけが落ちても base を再実行せず green で抜ける
//   (e) failed_files が無い → diff 一覧も base 再実行も取らず green-fix（これまでどおり）
//   (f) base 再実行が null / diff 一覧が取れない → green-fix（ENV 判定の材料が欠けたら green 要件を緩めない）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, runWorkflowCapture, assertNoCrash, STANDARD_FILES } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/dev-flow.js'), 'utf8');

const ENV_FILE = 'plugins/x/scripts/generate_thumbnail.bats';
const RED = (files) => ({ tests: 'failed', green: false, summary: `${files.join(', ')} が red`, failed_files: files });
const DIFF = { ok: true, lines: [...STANDARD_FILES] };
const baseResult = (file, over = {}) => ({ file, ran: true, base_failed: true, same_failure: true, summary: 'same', ...over });

async function run(overrides) {
  const { ctx, calls, logs } = makeDevFlowSandbox({ overrides });
  const { result, error } = await runWorkflowCapture(src, ctx);
  assertNoCrash(error, 'validate-base-failing-routing');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { calls, logs, result };
}

const labelsOf = (calls) => calls.map((c) => c.label);
const greenFixes = (calls) => calls.filter((c) => c.label.startsWith('green-fix#'));

test('[validate-base-failing] (a) diff と無関係で base でも同じように落ちる失敗は ENV になり green-fix を起動しない', async () => {
  const { calls, result } = await run({
    'test#1': RED([ENV_FILE]),
    'validate-diff#1': DIFF,
    'base-rerun#1': { results: [baseResult(ENV_FILE)] },
  });
  const labels = labelsOf(calls);
  assert.equal(greenFixes(calls).length, 0, `green-fix は起動されないはず (labels: ${labels.join(', ')})`);
  assert.ok(!labels.includes('test#2'), `ENV だけの失敗で test#2 を回してはならない (labels: ${labels.join(', ')})`);
  assert.ok(labels.includes('eval#1'), 'Evaluate へ進むはず');

  const diffCall = calls.find((c) => c.label === 'validate-diff#1');
  assert.equal(diffCall.agentType, 'dev-flow:dev-runner-haiku-ro', 'diff 一覧は read-only proxy');
  assert.ok(diffCall.prompt.includes('ls-files --others --exclude-standard'), 'untracked も diff に含める');
  const rerun = calls.find((c) => c.label === 'base-rerun#1');
  assert.equal(rerun.agentType, 'dev-flow:dev-runner-haiku');
  assert.ok(rerun.prompt.includes(JSON.stringify([ENV_FILE])), `base 再実行の対象に ${ENV_FILE} が渡るはず`);
  assert.ok(rerun.prompt.includes('origin/main'), 'base ref を渡す');

  assert.equal(result.test_green, true, 'ENV は green 要件から外れる');
  const summary = calls.find((c) => c.label === 'post-summary').prompt;
  assert.ok(summary.includes('環境ノート 1 件'), `ledger の ENV 項目（advisory）として環境ノートに数えられるはず:\n${summary.slice(0, 1500)}`);
  assert.ok(summary.includes('base でも失敗する既存の失敗 1 件') && summary.includes(`\`${ENV_FILE}\``),
    `終端サマリーに既存の失敗として載るはず:\n${summary.slice(0, 1500)}`);
});

test('[validate-base-failing] (b) diff が触ったテストファイル・テスト対象のソースが diff にある失敗は base 再実行せず green-fix', async () => {
  // src/w.test.ts: テストファイル自身が diff にある / src/x.test.ts: テスト対象の src/x.ts が diff にある
  for (const failed of ['src/w.test.ts', 'src/x.test.ts']) {
    const diffLines = failed === 'src/w.test.ts' ? [...STANDARD_FILES, failed] : [...STANDARD_FILES];
    const { calls } = await run({
      'test#1': RED([failed]),
      'validate-diff#1': { ok: true, lines: diffLines },
    });
    const labels = labelsOf(calls);
    assert.ok(!labels.some((l) => l.startsWith('base-rerun#')), `${failed}: base 再実行は不要 (labels: ${labels.join(', ')})`);
    assert.deepEqual(greenFixes(calls).map((c) => c.label), ['green-fix#1'], `${failed}: green-fix#1 が 1 回起動するはず`);
  }
});

test('[validate-base-failing] (c) base では通る失敗は green-fix の対象のまま', async () => {
  const { calls, result } = await run({
    'test#1': RED([ENV_FILE]),
    'validate-diff#1': DIFF,
    'base-rerun#1': { results: [baseResult(ENV_FILE, { base_failed: false, same_failure: false })] },
  });
  const labels = labelsOf(calls);
  assert.deepEqual(greenFixes(calls).map((c) => c.label), ['green-fix#1'], `green-fix#1 が起動するはず (labels: ${labels.join(', ')})`);
  assert.ok(labels.indexOf('base-rerun#1') < labels.indexOf('green-fix#1'), 'base 再実行は green-fix の前');
  const summary = calls.find((c) => c.label === 'post-summary').prompt;
  assert.ok(!summary.includes('base でも失敗する既存の失敗'), '既存の失敗は無いのでサマリーに載らない');
  assert.equal(result.test_green, true, 'test#2 は既定で green');
});

test('[validate-base-failing] (d) 一部だけ ENV なら残りを green-fix し、ENV のファイルは触るなと伝える。次の iteration は再実行せず green', async () => {
  const touched = 'src/x.test.ts';
  const { calls, result } = await run({
    'test#1': RED([ENV_FILE, touched]),
    'validate-diff#1': DIFF,
    'base-rerun#1': { results: [baseResult(ENV_FILE)] },
    'test#2': RED([ENV_FILE]),
    'validate-diff#2': DIFF,
  });
  const labels = labelsOf(calls);
  const rerun = calls.find((c) => c.label === 'base-rerun#1');
  assert.ok(rerun.prompt.includes(JSON.stringify([ENV_FILE])), 'diff が触ったファイルは base 再実行の対象にしない');
  const gfs = greenFixes(calls);
  assert.deepEqual(gfs.map((c) => c.label), ['green-fix#1'], `green-fix は 1 回だけ (labels: ${labels.join(', ')})`);
  assert.ok(gfs[0].prompt.includes('修正対象外 — 触るな') && gfs[0].prompt.includes(JSON.stringify([ENV_FILE])),
    `green-fix prompt に既存の失敗のファイルを触らない指示が入るはず:\n${gfs[0].prompt.slice(0, 1200)}`);
  assert.ok(!labels.includes('base-rerun#2'), '判定済み ENV は再実行しない');
  assert.ok(!labels.includes('test#3'), 'ENV だけが残った iteration で抜ける');
  assert.equal(result.test_green, true);
});

test('[validate-base-failing] (e) failed_files が無い失敗は diff 一覧も base 再実行も取らず green-fix（これまでどおり）', async () => {
  const { calls } = await run({ 'test#1': { tests: 'failed', green: false, summary: 'assert mismatch' } });
  const labels = labelsOf(calls);
  assert.ok(!labels.some((l) => l.startsWith('validate-diff#') || l.startsWith('base-rerun#')), `labels: ${labels.join(', ')}`);
  assert.deepEqual(greenFixes(calls).map((c) => c.label), ['green-fix#1']);
});

test('[validate-base-failing] (f) base 再実行の結果・diff 一覧が取れないときは green-fix（green 要件を緩めない）', async () => {
  const rerunNull = await run({ 'test#1': RED([ENV_FILE]), 'validate-diff#1': DIFF, 'base-rerun#1': null });
  assert.deepEqual(greenFixes(rerunNull.calls).map((c) => c.label), ['green-fix#1'], 'base-rerun null → green-fix');
  const diffFail = await run({ 'test#1': RED([ENV_FILE]), 'validate-diff#1': { ok: false, error: 'git failed' } });
  assert.ok(!labelsOf(diffFail.calls).some((l) => l.startsWith('base-rerun#')), 'diff 一覧が無ければ base 再実行しない');
  assert.deepEqual(greenFixes(diffFail.calls).map((c) => c.label), ['green-fix#1'], 'diff 一覧失敗 → green-fix');
});
