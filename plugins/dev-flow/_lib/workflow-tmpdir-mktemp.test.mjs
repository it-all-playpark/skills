// Regression test: mktemp が TMPDIR フォールバック形式を使うことを VM 挙動で保証する。
//
// 問題: `mktemp /tmp/...` はサンドボックス環境（macOS の Claude Code sandbox 等）では
//       /tmp への書き込みが拒否されて失敗する。$TMPDIR 環境変数を参照する形式
//       `mktemp "${TMPDIR:-/tmp}/..."` を使えばサンドボックスが許可した一時ディレクトリを使える。
//
// 検証は (a) の一部を dev-flow.js / pr-iterate.js 全文に対する静的否定 assert で、
// 残りを両 workflow を VM で実行し agent() に実際に渡った prompt を観測することで行う:
//   (a-static) devFlowSrc / prIterateSrc 全文のどこにも `mktemp /tmp/` という古い形式が現れない
//       — success run 1 本の prompt 観測だけでは未到達分岐への再混入を検出できないため、
//       VM 観測とは独立に全文走査で pin する
//   (a-vm) success run で実際に agent() へ渡った prompt にも `mktemp /tmp/` が現れない
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

// (a-static) 旧形式 `mktemp /tmp/` が devFlowSrc / prIterateSrc 全文のどこにも現れない
// — success run 1 本の prompt 観測だけでは未到達分岐（abort 等）への再混入を検出できないため、
// VM 観測とは独立に全文走査で pin する。
test('[tmpdir] (a-static) devFlowSrc / prIterateSrc 全文に `mktemp /tmp/` という旧形式が無い', () => {
  for (const [name, src] of [['dev-flow.js', devFlowSrc], ['pr-iterate.js', prIterateSrc]]) {
    assert.ok(!src.includes('mktemp /tmp/'), `${name} に \`mktemp /tmp/\` という旧形式が静的に残存している（TMPDIR フォールバック形式へ移行すること）`);
  }
});

// (a-vm) 旧形式 `mktemp /tmp/` がどの prompt にも現れない
test('[tmpdir] (a-vm) dev-flow.js: agent() prompt に `mktemp /tmp/` という旧形式が含まれない', async () => {
  const hit = (await runDevFlow()).find((c) => c.prompt.includes('mktemp /tmp/'));
  assert.ok(!hit, `${hit?.label} の prompt に \`mktemp /tmp/\` が残存している（TMPDIR フォールバック形式へ移行すること）`);
});

test('[tmpdir] (a-vm) pr-iterate.js: agent() prompt に `mktemp /tmp/` という旧形式が含まれない', async () => {
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
