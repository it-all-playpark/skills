// Regression test: mktemp が TMPDIR フォールバック形式を使うことを VM 挙動で保証する。
//
// 問題: `mktemp /tmp/...` はサンドボックス環境（macOS の Claude Code sandbox 等）では
//       /tmp への書き込みが拒否されて失敗する。$TMPDIR 環境変数を参照する形式
//       `mktemp "${TMPDIR:-/tmp}/..."` を使えばサンドボックスが許可した一時ディレクトリを使える。
//
// dev-flow.js / pr-iterate.js を VM で実行し、agent() に実際に渡った prompt を観測する:
//   (a) どの agent() prompt にも `mktemp /tmp/` という古い形式が現れない
//   (b) dev-flow.js の post-summary prompt に mktemp "${TMPDIR:-/tmp}/dev-flow-XXXXXX.md" が現れる
//   (c) pr-iterate.js の post-summary prompt に mktemp "${TMPDIR:-/tmp}/pr-iterate-XXXXXX.md" が現れる

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeDevFlowSandbox, makePrIterateSandbox, runWorkflowCapture, assertNoCrash } from './test-helpers/vm-sandbox.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflowDir = join(here, '..', '.claude/workflows');
const devFlowSrc = readFileSync(join(workflowDir, 'dev-flow.js'), 'utf8');
const prIterateSrc = readFileSync(join(workflowDir, 'pr-iterate.js'), 'utf8');

async function runDevFlow() {
  const { ctx, calls } = makeDevFlowSandbox();
  const { error } = await runWorkflowCapture(devFlowSrc, ctx);
  assertNoCrash(error, 'dev-flow');
  assert.equal(error, null, `dev-flow run が throw した: ${error?.message}`);
  return calls;
}

async function runPrIterate() {
  const { ctx, calls } = makePrIterateSandbox();
  const { error } = await runWorkflowCapture(prIterateSrc, ctx, '.claude/workflows/pr-iterate.js');
  assertNoCrash(error, 'pr-iterate');
  assert.equal(error, null, `pr-iterate run が throw した: ${error?.message}`);
  return calls;
}

// (a) 旧形式 `mktemp /tmp/` がどの prompt にも現れない
test('[tmpdir] dev-flow.js: agent() prompt に `mktemp /tmp/` という旧形式が含まれない', async () => {
  const hit = (await runDevFlow()).find((c) => c.prompt.includes('mktemp /tmp/'));
  assert.ok(!hit, `${hit?.label} の prompt に \`mktemp /tmp/\` が残存している（TMPDIR フォールバック形式へ移行すること）`);
});

test('[tmpdir] pr-iterate.js: agent() prompt に `mktemp /tmp/` という旧形式が含まれない', async () => {
  const hit = (await runPrIterate()).find((c) => c.prompt.includes('mktemp /tmp/'));
  assert.ok(!hit, `${hit?.label} の prompt に \`mktemp /tmp/\` が残存している（TMPDIR フォールバック形式へ移行すること）`);
});

// (b) dev-flow.js の post-summary が TMPDIR フォールバック形式 + 'dev-flow' prefix で mktemp を指示する
test('[tmpdir] dev-flow.js: post-summary prompt が mktemp "${TMPDIR:-/tmp}/dev-flow-XXXXXX.md" を指示する', async () => {
  const post = (await runDevFlow()).find((c) => c.label === 'post-summary');
  assert.ok(post, 'post-summary が呼ばれていない');
  assert.ok(post.prompt.includes('mktemp "${TMPDIR:-/tmp}/dev-flow-XXXXXX.md"'), `post-summary prompt に TMPDIR フォールバック形式の mktemp が無い:\n${post.prompt.slice(0, 400)}`);
});

// (c) pr-iterate.js の post-summary が TMPDIR フォールバック形式 + 'pr-iterate' prefix で mktemp を指示する
test('[tmpdir] pr-iterate.js: post-summary prompt が mktemp "${TMPDIR:-/tmp}/pr-iterate-XXXXXX.md" を指示する', async () => {
  const post = (await runPrIterate()).find((c) => c.label === 'post-summary');
  assert.ok(post, 'post-summary が呼ばれていない');
  assert.ok(post.prompt.includes('mktemp "${TMPDIR:-/tmp}/pr-iterate-XXXXXX.md"'), `post-summary prompt に TMPDIR フォールバック形式の mktemp が無い:\n${post.prompt.slice(0, 400)}`);
});
