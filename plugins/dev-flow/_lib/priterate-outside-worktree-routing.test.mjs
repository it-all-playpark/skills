// _lib/priterate-outside-worktree-routing.test.mjs
// pr-iterate が file で worktree の外を指す blocking finding を fix に渡さず、終端サマリーの人間側 follow-up と
// 返り値 human_followups に回すことを VM 実行で pin する（issue #793）。
//   (a) 内外が混ざった round: fix#1 には worktree 内の指摘だけが届き、外の指摘は post-summary の follow-up 節に出る
//   (b) 外の指摘だけの round: fix を起動せず CI 判定へ進み、lgtm で終わる（follow-up 節には出る）
//   (c) 同じ外の指摘が続いても stuck にせず、follow-up は 1 件にまとめる
//   (d) dev-flow からの nested（caller:'dev-flow' — 終端サマリー無し）でも返り値 human_followups に載る
//   (e) worktree 内の指摘だけの round はこれまでどおり fix へ進み、follow-up 節を出さない
//   (f) /pr-iterate wrapper 経由の単体起動（caller:'standalone'）は nested でも終端サマリーに follow-up 節を出す（issue #828）

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const prIterateSrc = readFileSync(join(here, '..', '.claude/workflows/pr-iterate.js'), 'utf8');

const INSIDE = { severity: 'major', topic: 'in', file: 'plugins/dev-flow/_lib/a.mjs', line: 3, description: 'worktree 内の指摘本文', suggestion: '直す' };
const OUTSIDE = { severity: 'major', topic: 'out', file: '~/ghq/github.com/acme/dotfiles/claude-code/settings.json', description: 'dotfiles 側の許可が無い', suggestion: '人間が足す' };
const FOLLOWUP_HEADING = '### 👤 人間側 follow-up（worktree の外を指す指摘 — 自動修正の対象外・1 件）';

const plain = (v) => JSON.parse(JSON.stringify(v));

async function run(overrides, args) {
  const { ctx, calls, logs } = makePrIterateSandbox({ overrides, ...(args ? { args } : {}) });
  const { result, error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'outside-worktree');
  assert.equal(error, null, `run が throw した: ${error?.message}`);
  return { result, calls, logs };
}

test('[outside-worktree] (a) 内外が混ざった round → fix#1 には worktree 内の指摘だけが届き、外の指摘は終端サマリーの人間側 follow-up に出る', async () => {
  const { result, calls } = await run({
    'review#1': { decision: 'request-changes', issues: [INSIDE, OUTSIDE], summary: 'ng' },
    'review#2': { decision: 'approve', issues: [], summary: 'ok' },
  });
  const fix = calls.find((c) => c.label === 'fix#1');
  assert.ok(fix, 'worktree 内の指摘があるので fix#1 は起動する');
  assert.ok(fix.prompt.includes(INSIDE.description), 'worktree 内の指摘が fix に届いていない');
  assert.ok(!fix.prompt.includes(OUTSIDE.description), `worktree の外の指摘が fix に渡っている: ${fix.prompt}`);
  assert.ok(!fix.prompt.includes(OUTSIDE.file), 'worktree の外のパスが fix に渡っている');

  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post, 'post-summary が dispatch されていない');
  assert.ok(post.prompt.includes(FOLLOWUP_HEADING), `終端サマリーに人間側 follow-up 節が無い: ${post.prompt.slice(0, 3000)}`);
  assert.ok(post.prompt.includes(`\`${OUTSIDE.file}\`（反復 1 回目）`), '人間側 follow-up に外の指摘の場所が無い');
  assert.ok(post.prompt.includes(OUTSIDE.description));

  assert.equal(result.status, 'lgtm');
  assert.deepEqual(plain(result.human_followups).map((f) => f.file), [OUTSIDE.file]);
  assert.deepEqual(plain(result.history[0].blocking).map((f) => f.file), [INSIDE.file], 'history の blocking は fix に渡した指摘だけ');
});

test('[outside-worktree] (b) 外の指摘だけの round → fix を起動せず CI 判定へ進んで lgtm、follow-up 節に出る', async () => {
  const { result, calls, logs } = await run({
    'review#1': { decision: 'request-changes', issues: [OUTSIDE], summary: 'ng' },
  });
  assert.equal(calls.filter((c) => c.label.startsWith('fix#')).length, 0, `外の指摘だけで fix が起動した: ${calls.map((c) => c.label).join(', ')}`);
  assert.ok(calls.some((c) => c.label === 'ci-check#1'), 'CI 判定へ進んでいない');
  assert.equal(result.status, 'lgtm');
  assert.equal(result.fixes_applied, 0);
  assert.deepEqual(plain(result.human_followups).map((f) => f.topic), ['out']);
  assert.ok(logs.some((l) => l.includes('worktree の外を指す blocking 1 件')), 'fix から外した log が無い');
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(post.prompt.includes(FOLLOWUP_HEADING));
});

test('[outside-worktree] (c) 同じ外の指摘が 2 round 続いても stuck にせず、follow-up は 1 件にまとめる', async () => {
  const { result, calls } = await run({
    'review#1': { decision: 'request-changes', issues: [INSIDE, OUTSIDE], summary: 'ng' },
    'review#2': { decision: 'request-changes', issues: [{ ...INSIDE, topic: 'in2', description: '別の指摘' }, OUTSIDE], summary: 'ng' },
    'review#3': { decision: 'approve', issues: [], summary: 'ok' },
  });
  assert.equal(result.status, 'lgtm', `外の指摘の反復で stuck になった: ${result.status}`);
  assert.equal(calls.filter((c) => /^fix#\d+$/.test(c.label)).length, 2);
  assert.equal(plain(result.human_followups).length, 1);
});

test('[outside-worktree] (d) dev-flow からの nested（caller:dev-flow）でも返り値 human_followups に載り、post-summary は起動しない', async () => {
  const { result, calls } = await run(
    { 'review#1': { decision: 'request-changes', issues: [OUTSIDE], summary: 'ng' } },
    { pr: 5, nested: { caller: 'dev-flow', cwd: '/tmp/wt', head_ref: 'feature/x', repo: 'acme/skills' } },
  );
  assert.equal(calls.filter((c) => c.label === 'post-summary').length, 0);
  assert.deepEqual(plain(result.human_followups).map((f) => f.file), [OUTSIDE.file]);
});

test('[outside-worktree] (f) /pr-iterate wrapper 経由の単体起動（nested caller:standalone）は終端サマリーを投稿し、人間側 follow-up 節を載せる', async () => {
  const { result, calls } = await run(
    { 'review#1': { decision: 'request-changes', issues: [OUTSIDE], summary: 'ng' } },
    { pr: 5, nested: { caller: 'standalone', cwd: '/tmp/wt', head_ref: 'feature/x', head_sha: 'c'.repeat(40), base_ref: 'main', repo: 'acme/skills', epoch: 77 } },
  );
  assert.ok(!calls.some((c) => c.label === 'pr-meta' || c.label === 'isolation-cleanup'), 'wrapper 経由の単体起動で pr-meta / isolation-cleanup が起動した');
  const post = calls.filter((c) => c.label === 'post-summary');
  assert.equal(post.length, 1, 'wrapper 経由の単体起動は終端サマリーを投稿するべき');
  assert.ok(post[0].prompt.includes(FOLLOWUP_HEADING), '終端サマリーに人間側 follow-up 節が無い');
  assert.deepEqual(plain(result.human_followups).map((f) => f.file), [OUTSIDE.file]);
});

test('[outside-worktree] (e) worktree 内の指摘だけの round は fix へ進み、follow-up 節を出さない', async () => {
  const { result, calls } = await run({
    'review#1': { decision: 'request-changes', issues: [INSIDE], summary: 'ng' },
    'review#2': { decision: 'approve', issues: [], summary: 'ok' },
  });
  assert.ok(calls.some((c) => c.label === 'fix#1'));
  assert.deepEqual(plain(result.human_followups), []);
  const post = calls.find((c) => c.label === 'post-summary');
  assert.ok(!post.prompt.includes('人間側 follow-up'), 'follow-up が無いのに節が出ている');
});
