// F2: pr-iterate.js の ci-check exec-proxy を throw-safe 化する（failOpenAgent）ことを pin する
// テスト（tdd）。issue #499。
//
// (a) ci-check#i の agent stub が throw する harness ケースで run が throw せず完走し
//     terminal が ci_error（status に反映）になること
// (b) ci-check#i stub が null（schema 未返却）でも同様に ci_error 終端になること
// (c) source scan で ci-check prompt に '--checks-data' が含まれ '--checks-json' /
//     '$TMPDIR/ci-checks' / 'リダイレクト' が含まれないこと
// (d) hygiene: ci-check / post-summary / journal 系 prompt 文字列に guard / sandbox /
//     ガード / サンドボックス が含まれないこと
// (e) failOpenAgent を source から抽出し throw する stub で null が返ることの単体検証
//
// vm sandbox パターンは _lib/priterate-ci-wait-telemetry.test.mjs / priterate-review-throw-recovery.test.mjs
// の makeSandbox / runPrIterate を踏襲する。

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');
const src = readFileSync(prIteratePath, 'utf8');

function makeSandbox(agentStub) {
  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: async (fns) => Promise.all((fns || []).map((f) => f())),
    workflow: async () => ({ status: 'lgtm' }),
    args: '5',
    console,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    RegExp,
    Promise,
    Symbol,
    Map,
    Set,
    Date,
  };
  return vm.createContext(sandbox);
}

async function runPrIterate(ctx) {
  const stripped = src
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  const wrapped = `(async () => {\n${stripped}\n})();`;

  let caughtError = null;
  let resolvedResult = null;
  try {
    const resultPromise = vm.runInContext(wrapped, ctx, { filename: '.claude/workflows/pr-iterate.js' });
    if (resultPromise && typeof resultPromise.then === 'function') {
      resolvedResult = await resultPromise.catch((e) => {
        caughtError = e;
        return null;
      });
    }
  } catch (e) {
    caughtError = e;
  }
  return { result: resolvedResult, error: caughtError };
}

function assertNoSandboxCrash(error) {
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
}

function buildAgentStub({ ciStub, agentCalls }) {
  return async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    const promptStr = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    agentCalls.push({ label, agentType, prompt: promptStr });

    if (agentType === 'pr-reviewer') {
      return { decision: 'approve', issues: [], summary: 'ok' };
    }
    if (agentType === 'dev-runner-haiku-ro' && promptStr.includes('check-ci.sh')) {
      return ciStub(label);
    }
    if (label.startsWith('fix#')) {
      return { applied: true, summary: 'fixed', files: [] };
    }
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }
    if (label === 'journal-save') {
      return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }
    if (label === 'journal-log') {
      return { logged: true, summary: 'ok' };
    }
    if (label === 'pr-meta') {
      return { url: 'https://github.com/acme/skills/pull/5', cwd: '/tmp/wt' };
    }
    if (label === 'isolation-probe') {
      return { written: true };
    }
    if (label === 'worktree-dirty-check') {
      return { dirty: false, files: 0 };
    }
    return null;
  };
}

// ---- (a) ci-check#i throw -> run 完走、terminal=ci_error ----
test('[failopen-a] ci-check#1 が throw -> run が throw せず完走し status=ci_error', async () => {
  const agentCalls = [];
  const ciStub = () => { throw new Error('exec-proxy 例外（StructuredOutput 未返却）'); };
  const agentStub = buildAgentStub({ ciStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  assert.equal(error, null, `run 全体が例外終了してはならないが error が発生: ${error?.name}: ${error?.message}`);
  assert.equal(result?.status, 'ci_error', `ci-check#1 throw 時は status=ci_error であるべきだが '${result?.status}' だった`);
});

// ---- (b) ci-check#i null -> 同様に ci_error 終端 ----
test('[failopen-b] ci-check#1 が null(schema 未返却) -> status=ci_error', async () => {
  const agentCalls = [];
  const ciStub = () => null;
  const agentStub = buildAgentStub({ ciStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  assert.equal(error, null, `run 全体が例外終了してはならないが error が発生: ${error?.name}: ${error?.message}`);
  assert.equal(result?.status, 'ci_error', `ci-check#1 null 時は status=ci_error であるべきだが '${result?.status}' だった`);
});

// ---- (c) source scan: prompt が argv データ渡し形 ----
test('[failopen-c] ci-check prompt が --checks-data を使い --checks-json/$TMPDIR/ci-checks/リダイレクトを含まない', () => {
  const ciCheckBlockMatch = src.match(/const ci = await failOpenAgent\(([\s\S]*?)\{ agentType: 'dev-runner-haiku-ro'[\s\S]*?label: `ci-check#\$\{i\}`/);
  assert.ok(ciCheckBlockMatch, 'ci-check#i の trackedAgent 呼び出しブロックが見つかるべき');
  const block = ciCheckBlockMatch[1];
  assert.ok(block.includes('--checks-data'), 'ci-check prompt に --checks-data が含まれるべき');
  assert.ok(!block.includes('--checks-json'), 'ci-check prompt に旧 --checks-json が残っているべきでない');
  assert.ok(!block.includes('$TMPDIR/ci-checks'), 'ci-check prompt に $TMPDIR/ci-checks への言及が残っているべきでない');
  assert.ok(!/[>]\s*\$TMPDIR/.test(block), 'ci-check prompt に $TMPDIR へのリダイレクト構文が残っているべきでない');
});

// ---- (d) hygiene: guard/sandbox 語が prompt 文字列に含まれない ----
test('[failopen-d] ci-check / post-summary / journal 系 prompt に guard/sandbox 系の語が含まれない', () => {
  const forbidden = ['guard', 'sandbox', 'ガード', 'サンドボックス'];
  const sections = [
    { name: 'ci-check', re: /const ci = await failOpenAgent\(([\s\S]*?)label: `ci-check#\$\{i\}`[\s\S]*?\)\n/ },
    { name: 'post-summary', re: /const summaryPost = await failOpenAgent\(([\s\S]*?)label: `post-summary`[\s\S]*?\)\n/ },
    { name: 'journal-save', re: /const journalSaveRes = await trackedAgent\(([\s\S]*?)label: 'journal-save'[\s\S]*?\)\n/ },
    { name: 'journal-log', re: /const journalPost = await trackedAgent\(([\s\S]*?)label: 'journal-log'[\s\S]*?\)\n/ },
  ];
  for (const { name, re } of sections) {
    const m = src.match(re);
    assert.ok(m, `${name} の trackedAgent 呼び出しブロックが見つかるべき`);
    const block = m[1].toLowerCase();
    for (const word of forbidden) {
      assert.ok(!block.includes(word.toLowerCase()), `${name} prompt に禁止語 '${word}' が含まれているべきでない`);
    }
  }
});

// ---- (e) failOpenAgent 単体: throw する stub で null が返る ----
test('[failopen-e] failOpenAgent は trackedAgent が throw しても null を返す(コンテキストへ抽出して直接検証)', async () => {
  const failOpenMatch = src.match(/async function failOpenAgent\([\s\S]*?\n\}/);
  assert.ok(failOpenMatch, 'failOpenAgent 関数定義が source に存在するべき');

  const calls = [];
  const sandbox = {
    log: (msg) => calls.push(msg),
    trackedAgent: async () => { throw new Error('boom'); },
    console,
  };
  const ctx = vm.createContext(sandbox);
  const wrapped = `(${failOpenMatch[0]})`;
  const fn = vm.runInContext(wrapped, ctx);
  const out = await fn('prompt', { label: 'test-proxy' });
  assert.equal(out, null, 'failOpenAgent は throw を吸収して null を返すべき');
  assert.ok(calls.some((m) => String(m).includes('test-proxy')), 'failOpenAgent は警告 log を出すべき');
});
