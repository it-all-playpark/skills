// F2: review agent（review#i / review#i-contract-retry）が StructuredOutput 契約違反で throw / null を
// 返した場合の pr-iterate 側リカバリを pin する（issue #437）。
//   - throw も null も同一の「契約失敗」として扱い、同一 prompt で 1 回だけ schema-retry する
//   - retry で成功すれば通常経路へ完全合流する
//   - retry 後も失敗（throw/null）なら run 全体を落とさず status:'review_contract_error' で graceful 終了
//   - review#i-contract-retry（contract mismatch 経路）が throw/null になった場合も同様に graceful 終了し、
//     元の mismatch review のデータで history を残す
//
// vm sandbox パターンは _lib/priterate-review-contract-routing.test.mjs の makeSandbox / runPrIterate /
// assertNoSandboxCrash / buildAgentStub をそのまま複製する。

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

function buildAgentStub({ reviewerStub, ciStub, fixStub, agentCalls }) {
  return async (prompt, opts) => {
    const label = opts?.label ?? '';
    const agentType = opts?.agentType ?? '';
    const promptStr = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    agentCalls.push({ label, agentType, prompt: promptStr });

    if (agentType === 'pr-reviewer') {
      return reviewerStub(label);
    }
    if (agentType === 'dev-runner-haiku-ro' && promptStr.includes('check-ci --checks-data')) {
      return ciStub ? ciStub(label) : { status: 'passed', failed_checks: [] };
    }
    if (label.startsWith('fix#')) {
      return fixStub ? fixStub(label) : { applied: true, summary: 'fixed', files: [] };
    }
    if (label.startsWith('post-')) {
      return { posted: true, method: 'gh', url: 'http://x' };
    }
    // journal-save (stage1, issue #494): 実際の telemetry payload はここに載る
    if (label === 'journal-save') {
      return { saved: true, path: '/tmp/wt/.devflow-tmp/payload-test.json' };
    }
    if (label === 'journal-log') {
      return { logged: true, summary: 'ok' };
    }
    // pr-meta: cwd は実 run では常に worktree の絶対パス。journal-save の保存先はここから組み立てられる。
    if (label === 'pr-meta') {
      return { url: 'https://github.com/acme/skills/pull/5', cwd: '/tmp/wt' };
    }
    return null;
  };
}

// ---- T1: review#1 が throw、schema-retry が成功 -> 通常経路合流、review_null_retries=1 ----
test('[T1] review#1 throw -> review#1-schema-retry 成功 -> pr-reviewer 2回、lgtm、review_null_retries=1', async () => {
  const agentCalls = [];
  const reviewerStub = (label) => {
    if (label === 'review#1') throw new Error('StructuredOutput 契約違反');
    if (label === 'review#1-schema-retry') return { decision: 'approve', issues: [], summary: 'ok' };
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'pr-reviewer');
  assert.equal(reviewerCalls.length, 2, `pr-reviewer 呼び出しは 2 回（review#1 + schema-retry）であるべきだが ${reviewerCalls.length} 回だった`);
  assert.ok(reviewerCalls.some((c) => c.label === 'review#1'), 'review#1 が呼ばれるべき');
  assert.ok(reviewerCalls.some((c) => c.label === 'review#1-schema-retry'), 'review#1-schema-retry が呼ばれるべき');

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.review_null_retries, 1, `review_null_retries は 1 であるべきだが ${result?.review_null_retries} だった`);
});

// ---- T2: review#1 が throw、schema-retry も throw -> graceful 終了（無限ループ・run 例外終了なし）----
test('[T2] review#1 throw -> review#1-schema-retry も throw -> error null、pr-reviewer 2回のみ、status:review_contract_error', async () => {
  const agentCalls = [];
  const reviewerStub = (label) => {
    if (label === 'review#1' || label === 'review#1-schema-retry') {
      throw new Error('StructuredOutput 契約違反');
    }
    throw new Error(`unexpected pr-reviewer label (should not go past schema-retry): ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  assert.equal(error, null, `run 全体が例外終了してはならないが error が発生: ${error?.name}: ${error?.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'pr-reviewer');
  assert.equal(reviewerCalls.length, 2, `pr-reviewer 呼び出しはちょうど 2 回（無限ループしない）であるべきだが ${reviewerCalls.length} 回だった`);

  const fixCalls = agentCalls.filter((c) => c.label.startsWith('fix#'));
  assert.equal(fixCalls.length, 0, `fix# は 0 回であるべきだが ${fixCalls.length} 回だった`);

  const ciCalls = agentCalls.filter((c) => c.prompt.includes('check-ci --checks-data'));
  assert.equal(ciCalls.length, 0, `ci-check は 0 回であるべきだが ${ciCalls.length} 回だった`);

  assert.equal(result?.status, 'review_contract_error', `result.status は review_contract_error であるべきだが '${result?.status}' だった`);

  const postSummary = agentCalls.find((c) => c.label === 'post-summary');
  assert.ok(postSummary != null, 'post-summary の呼び出しが存在するべき（graceful 終了でも終端投稿は行われる）');

  const journalLog = agentCalls.find((c) => c.label === 'journal-log');
  assert.ok(journalLog != null, 'journal-log の呼び出しが存在するべき（graceful 終了でも telemetry は記録される）');
});

// ---- T3: review#1 が null を2回返す（throw ではなく null）-> T2 と同じ graceful 経路 ----
test('[T3] review#1 が null を2回返す(throwでなくnull) -> T2 と同じ graceful 経路、status:review_contract_error', async () => {
  const agentCalls = [];
  const reviewerStub = () => null;
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  assert.equal(error, null, `run 全体が例外終了してはならないが error が発生: ${error?.name}: ${error?.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'pr-reviewer');
  assert.equal(reviewerCalls.length, 2, `pr-reviewer 呼び出しはちょうど 2 回（無限ループしない）であるべきだが ${reviewerCalls.length} 回だった`);

  assert.equal(result?.status, 'review_contract_error', `result.status は review_contract_error であるべきだが '${result?.status}' だった`);
});

// ---- T4: review#1-contract-retry が throw、schema-retry も throw -> graceful 終了、history に元の mismatch を保持 ----
test('[T4] review#1 contract mismatch -> review#1-contract-retry throw -> schema-retry も throw -> status:review_contract_error、history に iteration 1 が残る', async () => {
  const agentCalls = [];
  const majorIssue = { severity: 'major', topic: 't1', file: 'a.ts', description: 'd1', suggestion: 's1' };
  const reviewerStub = (label) => {
    if (label === 'review#1') return { decision: 'approve', issues: [majorIssue], summary: 'mismatch' };
    if (label === 'review#1-contract-retry' || label === 'review#1-contract-retry-schema-retry') {
      throw new Error('StructuredOutput 契約違反');
    }
    throw new Error(`unexpected pr-reviewer label: ${label}`);
  };
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  assert.equal(error, null, `run 全体が例外終了してはならないが error が発生: ${error?.name}: ${error?.message}`);

  const reviewerCalls = agentCalls.filter((c) => c.agentType === 'pr-reviewer');
  assert.equal(reviewerCalls.length, 3, `pr-reviewer 呼び出しは 3 回（review#1 + contract-retry + contract-retry-schema-retry）であるべきだが ${reviewerCalls.length} 回だった`);

  assert.equal(result?.status, 'review_contract_error', `result.status は review_contract_error であるべきだが '${result?.status}' だった`);

  assert.equal(result?.history?.length, 1, `history は 1 件であるべきだが ${result?.history?.length} 件だった`);
  assert.equal(result.history[0].iteration, 1, 'history[0].iteration は 1 であるべき');
  assert.equal(result.history[0].blocking?.length, 1, 'history[0].blocking は元の mismatch review の 1 件を保持するべき');
});

// ---- T5 回帰: 正常経路（throw/null なし）で schema-retry ラベル呼び出し 0 回、review_null_retries=0 ----
test('[T5 回帰] 正常経路(review#1 approve+issues:[])では schema-retry 呼び出し 0 回、review_null_retries=0', async () => {
  const agentCalls = [];
  const reviewerStub = () => ({ decision: 'approve', issues: [], summary: 'ok' });
  const agentStub = buildAgentStub({ reviewerStub, agentCalls });
  const ctx = makeSandbox(agentStub);
  const { result, error } = await runPrIterate(ctx);
  assertNoSandboxCrash(error);
  if (error) assert.fail(`予期しない error: ${error.name}: ${error.message}`);

  const schemaRetryCalls = agentCalls.filter((c) => c.label.includes('schema-retry'));
  assert.equal(schemaRetryCalls.length, 0, `schema-retry 呼び出しは 0 回であるべきだが ${schemaRetryCalls.length} 回だった`);

  assert.equal(result?.status, 'lgtm', `result.status は lgtm であるべきだが '${result?.status}' だった`);
  assert.equal(result?.review_null_retries, 0, `review_null_retries は 0 であるべきだが ${result?.review_null_retries} だった`);
});
