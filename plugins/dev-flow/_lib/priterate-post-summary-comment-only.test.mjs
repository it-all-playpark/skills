// pr-iterate の終端 post-summary 投稿が `gh pr comment` 単一経路であることを pin する（issue #524）
//
// 不変条件: 終端 status × lastDecision のどの組合せでも、post-summary agent への prompt に
// `gh pr review` の literal を含めない。含めると safety classifier に self-approval として
// blocked され、failOpenAgent 経由のため run は lgtm で完走したまま終端サマリーだけが PR に
// 残らない silent data loss になる（fail-open は維持したうえで原因側を断つ）。
//
// harness は test-helpers/vm-sandbox.mjs の makePrIterateSandbox / prIterateRounds / runWorkflowCapture。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, prIterateRounds, runWorkflowCapture } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

async function runPrIterate({ review, fix = [{ applied: true, summary: 'fixed', files: [] }], overrides = {} }) {
  const { ctx, calls } = makePrIterateSandbox({
    overrides,
    rounds: prIterateRounds({
      reviewer: () => review,
      fix,
      commitEnsure: { dirty: false, committed: false, pushed: false },
    }),
  });
  const { result, error } = await runWorkflowCapture(src, ctx, '.claude/workflows/pr-iterate.js');
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  return { result, error, calls };
}

const CRITICAL = { severity: 'critical', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };

// 終端 status × lastDecision ごとに、post-summary prompt に含めない literal / 含む literal を表で見る
const CASES = [
  {
    name: 'lgtm + approve 終端',
    review: { decision: 'approve', issues: [], summary: 'ok' },
    status: 'lgtm',
    absent: ['gh pr review', '--approve'],
    present: ['gh pr comment 5', '--body-file'],
  },
  {
    name: 'fix_failed + request-changes(blocking>0) 終端',
    review: { decision: 'request-changes', issues: [CRITICAL], summary: 'ng' },
    fix: [{ applied: false, summary: 'cannot', files: [] }],
    status: 'fix_failed',
    absent: ['gh pr review', '--request-changes'],
    present: ['gh pr comment 5'],
  },
  {
    name: 'lgtm + comment 終端（既存 comment 経路の回帰）',
    review: { decision: 'comment', issues: [], summary: 'ok' },
    status: 'lgtm',
    absent: ['gh pr review'],
    present: ['gh pr comment 5'],
  },
];

test.each(CASES)('[issue #524] $name -> post-summary prompt は gh pr review を含まず gh pr comment を使う', async ({ review, fix, status, absent, present }) => {
  const { result, error, calls } = await runPrIterate({ review, fix });
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  assert.equal(result?.status, status, `result.status は ${status} であるべきだが '${result?.status}' だった`);

  const postSummary = calls.find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, 'post-summary の呼び出しが存在するべき');
  for (const literal of absent) {
    assert.ok(!postSummary.prompt.includes(literal), `post-summary の prompt に '${literal}' を含めてはならない。先頭1200文字: ${postSummary.prompt.slice(0, 1200)}`);
  }
  for (const literal of present) {
    assert.ok(postSummary.prompt.includes(literal), `post-summary の prompt に '${literal}' を含むべき。先頭1200文字: ${postSummary.prompt.slice(0, 1200)}`);
  }
});

// ---- fail-open 維持（AC-3）: posted:false でも run が throw せず完走する ----
test('[issue #524 AC-3] post-summary が posted:false を返しても run は throw せず lgtm で完走する（fail-open 維持）', async () => {
  const { result, error } = await runPrIterate({
    review: { decision: 'approve', issues: [], summary: 'ok' },
    overrides: { 'post-summary': { posted: false, method: '', url: '' } },
  });
  assert.equal(error, null, `run は throw せず完走するべきだが error が発生した: ${error?.name}: ${error?.message}`);
  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
});

// ---- static 回帰ピン: pr-iterate.js の source 全文に 'gh pr review' literal が存在しない ----
test('[issue #524 static pin] pr-iterate.js の source に \'gh pr review\' literal が存在しない（恒久回帰防止）', () => {
  assert.ok(!src.includes('gh pr review'), `pr-iterate.js に 'gh pr review' literal が残存している（self-approval として classifier に blocked される原因）`);
});
