// _lib/priterate-fix-prompt-contract.test.mjs
// pr-iterate の fix agent prompt（review 指摘の fix_loop と CI 失敗の ci_gate の両経路）が subagent dispatch の
// 必須 5 要素（Objective / Output format / Tools / Boundary / Token cap）を持ち、Boundary が worktree の外・他 repo への
// 書き込み、ブランチ作成、gh api での変更を禁止していることを pin する（issue #793）。
//   (a) fix_loop の fix#1 prompt（VM で実 prompt を観測）
//   (b) ci_gate の fix#1 prompt（同上）
//   (c) 静的: callFixAgent に渡す prompt は fixPrompt() で組んだものだけ（5 要素を持たない prompt を足させない）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const prIterateSrc = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

const SECTIONS = ['## Objective', '## Output format', '## Tools', '## Boundary', '## Token cap'];

async function fixPromptOf(overrides) {
  const { ctx, calls } = makePrIterateSandbox({ overrides });
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'fix-prompt-contract');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  const fix = calls.find((c) => c.label === 'fix#1');
  assert.ok(fix, `fix#1 が dispatch されていない: ${calls.map((c) => c.label).join(', ')}`);
  return fix.prompt;
}

function sectionOf(prompt, heading) {
  const start = prompt.indexOf(heading);
  const next = prompt.indexOf('\n## ', start + heading.length);
  return prompt.slice(start, next === -1 ? undefined : next);
}

function assertFiveElements(prompt, label) {
  for (const h of SECTIONS) assert.ok(prompt.includes(`${h}\n`), `${label}: ${h} が無い。prompt: ${prompt}`);
  const order = SECTIONS.map((h) => prompt.indexOf(h));
  assert.deepEqual([...order].sort((a, b) => a - b), order, `${label}: 5 要素の順序が崩れている`);
  assert.match(sectionOf(prompt, '## Output format'), /"applied": boolean/);
  assert.match(sectionOf(prompt, '## Tools'), /使用可:/);
  assert.match(sectionOf(prompt, '## Token cap'), /summary は \d+ 字以内/);
  const boundary = sectionOf(prompt, '## Boundary');
  assert.ok(boundary.includes('worktree（/tmp/wt）の中だけ'), `${label}: Boundary に worktree の絶対パスが無い: ${boundary}`);
  assert.match(boundary, /他 repo/);
  assert.match(boundary, /ブランチを作らない/);
  assert.match(boundary, /git worktree add/);
  assert.match(boundary, /`gh api` で GitHub 上の状態を変更しない/);
  assert.match(boundary, /worktree の外の変更が要る指摘は直さず/);
}

test('[fix-prompt-contract] (a) fix_loop の fix#1 prompt は必須 5 要素を持ち、Boundary で worktree 外・他 repo・ブランチ作成・gh api を禁止する', async () => {
  const prompt = await fixPromptOf({
    'review#1': { decision: 'request-changes', issues: [{ severity: 'major', topic: 't', file: 'src/a.js', line: 1, description: 'null を握りつぶしている', suggestion: '' }], summary: 'ng' },
    'fix#1': { applied: false, files: [], summary: 'stop' },
  });
  assertFiveElements(prompt, 'fix_loop');
  assert.match(sectionOf(prompt, '## Objective'), /PR #5 のレビュー指摘を修正/);
  assert.ok(prompt.includes('null を握りつぶしている'), '指摘本文が prompt に届いていない');
});

test('[fix-prompt-contract] (b) ci_gate の fix#1 prompt も同じ 5 要素と Boundary を持つ', async () => {
  const prompt = await fixPromptOf({
    'ci-check#1': { status: 'failed', failed_checks: [{ name: 'bats', bucket: 'fail', state: 'FAILURE' }] },
    'fix#1': { applied: false, files: [], summary: 'stop' },
  });
  assertFiveElements(prompt, 'ci_gate');
  assert.match(sectionOf(prompt, '## Objective'), /PR #5 の CI 失敗を修正/);
  assert.ok(prompt.includes('ci::bats'), 'CI 失敗が prompt に届いていない');
});

test('[fix-prompt-contract] (c) 静的: callFixAgent に渡す prompt は fixPrompt() で組んだ 2 つだけ', () => {
  const callSites = [...prIterateSrc.matchAll(/await callFixAgent\((\w+), i\)/g)].map((m) => m[1]);
  assert.deepEqual(callSites.sort(), ['ciFixPrompt', 'reviewFixPrompt']);
  for (const name of callSites) {
    assert.match(prIterateSrc, new RegExp(`const ${name} = fixPrompt\\(\\{`), `${name} が fixPrompt() で組まれていない`);
  }
  const def = prIterateSrc.slice(prIterateSrc.indexOf('function fixPrompt('), prIterateSrc.indexOf('const reviewSeen ='));
  for (const h of SECTIONS) assert.ok(def.includes(h), `fixPrompt() の定義に ${h} が無い`);
});
