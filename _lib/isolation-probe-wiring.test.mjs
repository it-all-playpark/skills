// isolation probe の Setup phase 配線を検証する source-regex テスト（PR #399 レビュー指摘対応）。
// devflow-phase-functions.test.mjs と同スタイル（readFileSync + regex + vitest、VM sandbox は使わない
// source-string only）。純関数（isolationProbePrompt/isolationFailureMessage）自体は
// _lib/isolation-probe.test.mjs で直接 import してテストする。本ファイルは dev-flow.js の Setup phase が
// それらを正しく呼び出し・分岐しているかの配線のみを検証する。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const devFlowPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude/workflows/dev-flow.js');
const src = readFileSync(devFlowPath, 'utf8');

test('isolation probe agent 呼び出しが agentType/schema/label/phase 込みで存在する（issue #521: dev-runner-haiku-wo へ切替・isoToken を渡す）', () => {
  assert.match(
    src,
    /const isoProbe = await trackedAgent\(isolationProbePrompt\(WT,\s*isoToken\),\s*\{\s*agentType:\s*'dev-runner-haiku-wo',\s*schema:\s*ISOLATION_PROBE,\s*label:\s*'isolation-probe',\s*phase:\s*'Setup'\s*\}\)/,
    'isolation probe の trackedAgent() 呼び出しが期待する agentType(dev-runner-haiku-wo)/schema/label/phase かつ isoToken 引数込みで見つからない',
  );
});

test('isoToken が clockMarks?.start（fail-open で ISSUE へ fallback）から Date.now/Math.random 非依存で算出される（issue #521）', () => {
  const match = src.match(/const isoToken = String\(clockMarks\?\.start \?\? ISSUE\)[^\n]*/);
  assert.ok(match, 'const isoToken = String(clockMarks?.start ?? ISSUE) の宣言が見つからない');
  assert.doesNotMatch(match[0], /Date\.now|Math\.random/, 'isoToken 宣言行に Date.now/Math.random が含まれてはならない（workflow script の制約違反）');
});

test('probe が written:false を返した場合に isolationFailureMessage で throw する分岐が存在する（workflowName: dev-flow-run を明示）', () => {
  assert.match(
    src,
    /if\s*\(isoProbe\s*&&\s*isoProbe\.written\s*===\s*false\)\s*\{\s*throw new Error\(isolationFailureMessage\(\{\s*worktree:\s*WT,\s*branch,\s*startRef:\s*`origin\/\$\{BASE\}`,\s*workflowName:\s*'dev-flow-run',\s*workflowArgs:\s*ISSUE,\s*targetPath:\s*WT,\s*error:\s*isoProbe\.error\s*\}\)\)\s*\}/,
    'written===false → throw new Error(isolationFailureMessage({..., workflowName: \'dev-flow-run\', ...})) の分岐が見つからない',
  );
});

test('probe 自体が失敗（null）した場合の fail-open log 分岐が存在する', () => {
  assert.match(
    src,
    /if\s*\(!isoProbe\)\s*log\(/,
    '!isoProbe → log(...) の fail-open 分岐が見つからない',
  );
  assert.match(src, /isolation probe 自体が失敗/, 'fail-open log メッセージが見つからない');
  assert.match(src, /fail-open で続行/, 'fail-open log メッセージに fail-open の明示が見つからない');
});

test('ISOLATION_PROBE schema が written(boolean, required) を持つ', () => {
  const match = src.match(/const ISOLATION_PROBE = \{[\s\S]*?\n\}/);
  assert.ok(match, 'ISOLATION_PROBE schema 宣言が見つからない');
  assert.match(match[0], /required:\s*\['written'\]/);
  assert.match(match[0], /written:\s*\{\s*type:\s*'boolean'\s*\}/);
});

test('isolation probe は worktree 作成後・deps install より前（Setup phase 内）に配置されている', () => {
  const setupIdx = src.indexOf(`, 'Setup(worktree)')`);
  const probeIdx = src.indexOf('const isoProbe = await trackedAgent(isolationProbePrompt(WT, isoToken)');
  const depsIdx = src.indexOf('const depsRes = await trackedAgent(setupDepsPrompt(WT)');
  assert.notStrictEqual(setupIdx, -1, 'worktree 作成 need() 呼び出しが見つからない');
  assert.notStrictEqual(probeIdx, -1, 'isolation probe 呼び出しが見つからない');
  assert.notStrictEqual(depsIdx, -1, 'deps install 呼び出しが見つからない');
  assert.ok(setupIdx < probeIdx, 'isolation probe は worktree 作成より後に配置されるべき');
  assert.ok(probeIdx < depsIdx, 'isolation probe は deps install より前に配置されるべき（早期検知の目的）');
});

// ── issue #493: stale 残置物の除去（cleanup）を probe の直前に置く ─────────────

test('isolation cleanup agent 呼び出しが agentType/schema/label/phase 込みで存在する', () => {
  assert.match(
    src,
    /const isoClean = await failOpenAgent\(isolationCleanupPrompt\(WT,\s*'\.devflow-tmp'\),\s*\{\s*agentType:\s*'dev-runner-haiku',\s*schema:\s*ISOLATION_CLEANUP,\s*label:\s*'isolation-cleanup',\s*phase:\s*'Setup'\s*\}\)/,
    'isolation cleanup の failOpenAgent() 呼び出しが期待する agentType/schema/label/phase で見つからない',
  );
});

test('ISOLATION_CLEANUP schema が cleaned(boolean, required) を持つ', () => {
  const match = src.match(/const ISOLATION_CLEANUP = \{[\s\S]*?\n\}/);
  assert.ok(match, 'ISOLATION_CLEANUP schema 宣言が見つからない');
  assert.match(match[0], /required:\s*\['cleaned'\]/);
  assert.match(match[0], /cleaned:\s*\{\s*type:\s*'boolean'\s*\}/);
});

test('isolation cleanup の失敗は fail-open（log のみ・throw しない）', () => {
  assert.match(
    src,
    /if\s*\(!isoClean\s*\|\|\s*isoClean\.cleaned\s*!==\s*true\)\s*log\(/,
    'cleanup 失敗時の fail-open log 分岐が見つからない',
  );
  // 窓は cleanup 呼び出し 〜 probe 呼び出しの直前まで（probe 側の fail-closed throw を巻き込まない）
  const idx = src.indexOf("const isoClean = await failOpenAgent(isolationCleanupPrompt(WT, '.devflow-tmp')");
  const probeIdx = src.indexOf('const isoProbe = await trackedAgent(isolationProbePrompt(WT, isoToken)');
  const nearby = src.slice(idx, probeIdx);
  assert.doesNotMatch(nearby, /throw new Error/, 'cleanup 失敗で throw してはならない（fail-open）');
});

test('isolation cleanup は worktree 作成後・probe より前に配置されている', () => {
  const setupIdx = src.indexOf(`, 'Setup(worktree)')`);
  const cleanIdx = src.indexOf("const isoClean = await failOpenAgent(isolationCleanupPrompt(WT, '.devflow-tmp')");
  const probeIdx = src.indexOf('const isoProbe = await trackedAgent(isolationProbePrompt(WT, isoToken)');
  assert.notStrictEqual(cleanIdx, -1, 'isolation cleanup 呼び出しが見つからない');
  assert.ok(setupIdx < cleanIdx, 'cleanup は worktree 作成より後に配置されるべき');
  assert.ok(cleanIdx < probeIdx, 'cleanup は probe より前に配置されるべき（stale 残置物を probe 前に除去する）');
});

test('Setup の worktree prompt は trust 証跡を stale へ上書きさせる手順を含まない（cleanup へ移譲済み）', () => {
  const setupIdx = src.indexOf('`git worktree を 1 つ作って絶対パスを返せ。手順:');
  assert.notStrictEqual(setupIdx, -1, 'Setup の worktree prompt が見つからない');
  const prompt = src.slice(setupIdx, src.indexOf(`, 'Setup(worktree)')`, setupIdx));
  assert.doesNotMatch(prompt, /trust-test-latest\.json/);
  assert.doesNotMatch(prompt, /trust-risk-/);
  assert.doesNotMatch(prompt, /内容 \\`stale\\`/);
});
