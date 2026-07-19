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

test('isolation probe agent 呼び出しが agentType/schema/label/phase 込みで存在する', () => {
  assert.match(
    src,
    /const isoProbe = await agent\(isolationProbePrompt\(WT\),\s*\{\s*agentType:\s*'dev-runner-haiku',\s*schema:\s*ISOLATION_PROBE,\s*label:\s*'isolation-probe',\s*phase:\s*'Setup'\s*\}\)/,
    'isolation probe の agent() 呼び出しが期待する agentType/schema/label/phase で見つからない',
  );
});

test('probe が written:false を返した場合に isolationFailureMessage で throw する分岐が存在する', () => {
  assert.match(
    src,
    /if\s*\(isoProbe\s*&&\s*isoProbe\.written\s*===\s*false\)\s*\{\s*throw new Error\(isolationFailureMessage\(WT,\s*branch,\s*BASE,\s*ISSUE,\s*isoProbe\.error\)\)\s*\}/,
    'written===false → throw new Error(isolationFailureMessage(...)) の分岐が見つからない',
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
  const probeIdx = src.indexOf('const isoProbe = await agent(isolationProbePrompt(WT)');
  const depsIdx = src.indexOf('const depsRes = await agent(setupDepsPrompt(WT)');
  assert.notStrictEqual(setupIdx, -1, 'worktree 作成 need() 呼び出しが見つからない');
  assert.notStrictEqual(probeIdx, -1, 'isolation probe 呼び出しが見つからない');
  assert.notStrictEqual(depsIdx, -1, 'deps install 呼び出しが見つからない');
  assert.ok(setupIdx < probeIdx, 'isolation probe は worktree 作成より後に配置されるべき');
  assert.ok(probeIdx < depsIdx, 'isolation probe は deps install より前に配置されるべき（早期検知の目的）');
});
