// F1: max_iterations の検証を pin する TDD テスト（red phase）
// テストケース:
//   (1) args={pr:'5', max_iterations:'abc'} → vm 実行が reject し error.message が /正の整数/ にマッチ
//   (2) args={pr:'5', max_iterations:'3'} で pr-reviewer が常に request-changes（topic 毎回ユニーク）→
//       result.status==='max_reached' かつ result.iterations===3
//   (3) args={pr:'5'}（max_iterations 未指定）で pr-reviewer が即 approve、ci-check passed → lgtm
//   (4) args='5'（bare string、max_iterations なし）でも lgtm（単体起動の回帰防止）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const prIteratePath = join(repoRoot, '.claude/workflows/pr-iterate.js');

const src = readFileSync(prIteratePath, 'utf8');

/**
 * pr-iterate.js を vm sandbox で実行する。
 * agentStub は呼び出しラベルと agentType で分岐し、全呼び出しを agentCalls に記録する。
 */
function makeSandbox({ args, agentStub }) {
  const sandbox = {
    phase: () => {},
    log: () => {},
    agent: agentStub,
    parallel: async (fns) => Promise.all((fns || []).map((f) => f())),
    workflow: async () => ({ status: 'lgtm' }),
    args,
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

// ---- テストケース (1): max_iterations='abc' → 明示 throw ----
test('[max-iterations] max_iterations="abc" を渡すと /正の整数/ エラーで reject される（NaN silent 受理の禁止）', async () => {
  const agentCalls = [];
  const agentStub = async (prompt, opts) => {
    agentCalls.push({ label: opts?.label ?? '', agentType: opts?.agentType ?? '' });
    // loop 到達前に throw されるべきなので、何を返してもよい
    if ((opts?.agentType ?? '') === 'pr-reviewer') {
      return { decision: 'approve', issues: [], summary: 'ok' };
    }
    if ((opts?.agentType ?? '') === 'dev-runner-haiku-ro' && typeof prompt === 'string' && prompt.includes('check-ci.sh')) {
      return { status: 'passed', failed_checks: [] };
    }
    if ((opts?.label ?? '').startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }
    if ((opts?.label ?? '') === 'journal-log') {
      return { logged: true, summary: 'ok' };
    }
    return null;
  };

  const ctx = makeSandbox({ args: { pr: '5', max_iterations: 'abc' }, agentStub });
  const { result, error } = await runPrIterate(ctx);

  // ReferenceError/SyntaxError は別問題なので区別して報告
  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }

  // エラーが発生し、message に '正の整数' が含まれることを確認
  assert.ok(
    error != null,
    `max_iterations='abc' では error が throw されるべきだが、error は null で result=${JSON.stringify(result)} だった`,
  );
  assert.match(
    error?.message ?? '',
    /正の整数/,
    `error.message に '正の整数' が含まれるべきだが: "${error?.message}"`,
  );
});

// ---- テストケース (2): max_iterations='3' で request-changes 3 回 → max_reached ----
test('[max-iterations] max_iterations="3" を渡すと上限 3 で max_reached になる', async () => {
  const agentCalls = [];
  let reviewCallCount = 0;

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    agentCalls.push({ label, agentType });

    if (agentType === 'pr-reviewer') {
      reviewCallCount += 1;
      // topic を毎回ユニークにして REVIEW_STUCK=2 の stuck 検出を回避
      return {
        decision: 'request-changes',
        issues: [{ severity: 'major', topic: `t${reviewCallCount}`, description: `issue ${reviewCallCount}` }],
        summary: 'ng',
      };
    }
    if (label.startsWith('fix#')) {
      return { applied: true, summary: 'fixed', files: [] };
    }
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }
    if (label === 'journal-log') {
      return { logged: true, summary: 'ok' };
    }
    return null;
  };

  const ctx = makeSandbox({ args: { pr: '5', max_iterations: '3' }, agentStub });
  const { result, error } = await runPrIterate(ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  if (error) {
    assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  }

  assert.equal(
    result?.status,
    'max_reached',
    `result.status は 'max_reached' であるべきだが '${result?.status}' だった`,
  );
  assert.equal(
    result?.iterations,
    3,
    `result.iterations は 3 であるべきだが ${result?.iterations} だった`,
  );
});

// ---- テストケース (3): max_iterations 未指定（object args）で approve → lgtm ----
test('[max-iterations] args={pr:"5"}（max_iterations 未指定）で approve → lgtm（default 10 の正常系維持）', async () => {
  const agentCalls = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    agentCalls.push({ label, agentType });

    if (agentType === 'pr-reviewer') {
      return { decision: 'approve', issues: [], summary: 'ok' };
    }
    if (agentType === 'dev-runner-haiku-ro' && typeof prompt === 'string' && prompt.includes('check-ci.sh')) {
      return { status: 'passed', failed_checks: [] };
    }
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }
    if (label === 'journal-log') {
      return { logged: true, summary: 'ok' };
    }
    return null;
  };

  const ctx = makeSandbox({ args: { pr: '5' }, agentStub });
  const { result, error } = await runPrIterate(ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  if (error) {
    assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  }

  assert.equal(
    result?.status,
    'lgtm',
    `result.status は 'lgtm' であるべきだが '${result?.status}' だった`,
  );
});

// ---- テストケース (4): bare string args='5'（max_iterations なし）で approve → lgtm ----
test('[max-iterations] args="5"（bare string、max_iterations なし）で approve → lgtm（単体起動の回帰防止）', async () => {
  const agentCalls = [];

  const agentStub = async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    agentCalls.push({ label, agentType });

    if (agentType === 'pr-reviewer') {
      return { decision: 'approve', issues: [], summary: 'ok' };
    }
    if (agentType === 'dev-runner-haiku-ro' && typeof prompt === 'string' && prompt.includes('check-ci.sh')) {
      return { status: 'passed', failed_checks: [] };
    }
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }
    if (label === 'journal-log') {
      return { logged: true, summary: 'ok' };
    }
    return null;
  };

  const ctx = makeSandbox({ args: '5', agentStub });
  const { result, error } = await runPrIterate(ctx);

  if (error && (error.name === 'ReferenceError' || error.name === 'SyntaxError')) {
    assert.fail(`pr-iterate.js が sandbox でクラッシュ: ${error.name}: ${error.message}`);
  }
  if (error) {
    assert.fail(`予期しない error: ${error.name}: ${error.message}`);
  }

  assert.equal(
    result?.status,
    'lgtm',
    `result.status は 'lgtm' であるべきだが '${result?.status}' だった`,
  );
});
